/**
 * A loopback SOCKS5 server standing in for the scraper's residential exit (fc-infra egress-proxy.yaml: a userspace SOCKS5 listener,
 * RESIDENTIAL_PROXY_URL socks5://egress-proxy...:1055). No authentication, CONNECT only, the three address types. Nothing here leaves
 * 127.0.0.1: every CONNECT is answered by piping to a loopback port the test names.
 *
 * `route` maps the port a client ASKED for to the loopback port that serves it. A test points its image urls at a port nothing listens
 * on and routes that port to its image server, so a request can only succeed by going through this proxy: one sent from the process's
 * own address meets a closed port.
 */
import net from 'node:net';

export interface SocksConnect {
  /** The destination as the client named it (an IPv4 or IPv6 address, or a host name). */
  host: string;
  port: number;
  /** ms since an arbitrary start, monotonic. */
  t: number;
}

export interface Socks5Loopback {
  port: number;
  /** `socks5://127.0.0.1:<port>`: the value RESIDENTIAL_PROXY_URL takes. */
  url: string;
  connects: SocksConnect[];
  /** Answer CONNECTs for `askedPort` from 127.0.0.1:`toPort`. A CONNECT to a port with no route is refused (reply 0x05). */
  route(askedPort: number, toPort: number): void;
  close(): Promise<void>;
}

const clock = (): number => Number(process.hrtime.bigint() / 1_000n) / 1000;

function readAddress(buf: Buffer): { host: string; port: number; length: number } | undefined {
  const atyp = buf[3];
  if (atyp === 0x01 && buf.length >= 10) return { host: [...buf.subarray(4, 8)].join('.'), port: buf.readUInt16BE(8), length: 10 };
  if (atyp === 0x03 && buf.length >= 5) {
    const n = buf[4]!;
    if (buf.length < 5 + n + 2) return undefined;
    return { host: buf.subarray(5, 5 + n).toString('latin1'), port: buf.readUInt16BE(5 + n), length: 5 + n + 2 };
  }
  if (atyp === 0x04 && buf.length >= 22) {
    const words: string[] = [];
    for (let i = 0; i < 16; i += 2) words.push(buf.readUInt16BE(4 + i).toString(16));
    return { host: words.join(':'), port: buf.readUInt16BE(20), length: 22 };
  }
  return undefined;
}

export async function startSocks5(): Promise<Socks5Loopback> {
  const connects: SocksConnect[] = [];
  const routes = new Map<number, number>();
  const sockets = new Set<net.Socket>();
  const reply = (code: number): Buffer => Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
  const server = net.createServer(client => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'request' | 'piped' = 'greeting';
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      if (stage === 'greeting') {
        if (buf.length < 2 || buf.length < 2 + buf[1]!) return;
        const methods = [...buf.subarray(2, 2 + buf[1]!)];
        buf = buf.subarray(2 + buf[1]!);
        if (!methods.includes(0x00)) { client.end(Buffer.from([0x05, 0xff])); return; }
        client.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 4) return;
        const addr = readAddress(buf);
        if (addr === undefined) return;
        const rest = buf.subarray(addr.length);
        connects.push({ host: addr.host, port: addr.port, t: clock() });
        const to = routes.get(addr.port);
        if (buf[1] !== 0x01 || to === undefined) { client.end(reply(0x05)); return; }
        stage = 'piped';
        client.off('data', onData);
        const upstream = net.connect(to, '127.0.0.1', () => {
          client.write(reply(0x00));
          if (rest.length > 0) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        sockets.add(upstream);
        upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
      }
    };
    client.on('data', onData);
  });
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
  return {
    port,
    url: `socks5://127.0.0.1:${port}`,
    connects,
    route: (askedPort, toPort) => void routes.set(askedPort, toPort),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/** A loopback port with nothing listening on it (bound, then released): a request sent there directly is refused. */
export async function closedPort(): Promise<number> {
  const s = net.createServer();
  const port = await new Promise<number>(resolve => s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port)));
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}
