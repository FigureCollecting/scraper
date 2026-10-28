/**
 * The gallery-capture Job's run on fc-shared's server logging (telemetry.ts; the body is ./galleryCapture main).
 *
 * A run is ONE root trace: a job.start line, each line the run prints as one gallery.note line (a refusal, a lock, a lost
 * lease or a warning at warn), a probe's evidence as one gallery.probe_evidence line per request with its fields, and ONE
 * job.end line carrying the exit code and the report's counts. A crashed run (exit 1) is written once, as job.end's error,
 * and rejects, so the entry exits 1.
 *
 * ONE TRACE PER ITEM: each worklist item the run captures is its own root trace (item.capture, linked to the run by
 * itemTracer), so its lines and the capture and failure ledgers' calls to the ingest server it makes carry the ITEM's
 * traceparent (runJobProcess installs the client interceptor). No image request carries one.
 */
import { GALLERY_CAPTURE, itemTracer, runJobProcess, type Logger } from '../../telemetry.js';
import { GALLERY_FAILED, main, type GalleryMainDeps } from './galleryCapture.js';
import type { GalleryReport, ProbeEvidence } from './galleryDriver.js';

export type GalleryJobDeps = Omit<GalleryMainDeps, 'print' | 'onReport' | 'evidence' | 'traceItem'> & {
  /** Default: the gallery-capture logger on stdout. */
  logger?: Logger;
};

/** A printed line that an operator should see as a warning. */
const WARN_LINE = /^(?:REFUSED|LOCKED|LOST|WARNING|ERROR)\b/;

/** The job.end counts: the exit code, and the report's own counters when the run got as far as one. */
export function galleryCounts(code: number, report: GalleryReport | undefined): Record<string, unknown> {
  if (report === undefined) return { exitCode: code };
  // refusal and pauseReason are prose and already printed on their own lines.
  const { probe, refusal: _refusal, pauseReason: _pauseReason, ...counts } = report;
  return { exitCode: code, ...counts, ...(probe === undefined ? {} : { probeVerdict: probe.verdict }) };
}

/** One request's evidence as fields. setCookie is a flag, printed as sets_state: a key naming a cookie is masked whole. */
function evidenceFields({ setCookie, ...rest }: ProbeEvidence): Record<string, unknown> {
  return { event: 'gallery.probe_evidence', ...rest, setsState: setCookie };
}

export async function runGalleryJob(argv: readonly string[], deps: GalleryJobDeps = {}): Promise<number> {
  const { logger: given, ...mainDeps } = deps;
  let report: GalleryReport | undefined;
  return runJobProcess(GALLERY_CAPTURE, async (logger, run) => {
    let crashed: string | undefined;
    const code = await main(argv, {
      ...mainDeps,
      print: line => {
        if (line.startsWith(GALLERY_FAILED)) { crashed = line; return; }
        logger[WARN_LINE.test(line) ? 'warn' : 'info']({ event: 'gallery.note' }, line);
      },
      onReport: r => { report = r; },
      evidence: entries => { for (const entry of entries) logger.info(evidenceFields(entry), 'probe evidence'); },
      traceItem: itemTracer(run, 'item.capture'),
    });
    if (crashed !== undefined) throw new Error(crashed);
    return code;
  }, code => galleryCounts(code, report), { env: deps.env ?? process.env, ...(given === undefined ? {} : { logger: given }) });
}
