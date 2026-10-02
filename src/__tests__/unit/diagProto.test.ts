/**
 * TDD (red first) — the fc.diag.v1 wire contract (proto/fc/diag/v1/diag.proto, buf codegen into
 * src/gen). Hands-off plan unit S1.
 *
 * The probes Ross triggers reach the engine through DiagService.RunProbe over gRPC (h2c inside the
 * mesh; the server is S2). This file pins the SHAPE of that contract: every field name and number,
 * the enum vocabularies, the one RPC, and that max_requests carries explicit presence (absent asks
 * for the probe maximum, 0 asks for nothing). A renumbered or renamed field fails here before any
 * client and server can disagree about it.
 */
import { create, fromBinary, toBinary, toJson } from '@bufbuild/protobuf';
import { FeatureSet_FieldPresence } from '@bufbuild/protobuf/wkt';
import type { DescMessage } from '@bufbuild/protobuf';
import {
  AiBarTier,
  DiagService,
  Outcome,
  Probe,
  RobotsDrift,
  RunProbeRequestSchema,
  RunProbeResponseSchema,
  TargetRole,
  TargetSchema,
  RobotsFindingsSchema,
  AiBarSummarySchema,
} from '../../gen/fc/diag/v1/diag_pb';

/** `name=number` for every field, in declaration order. */
function shape(schema: DescMessage): string[] {
  return schema.fields.map((f) => `${f.name}=${f.number}`);
}

/** Every value of a generated enum object, by name. */
function enumValues(e: Record<string, string | number>): Record<string, number> {
  return Object.fromEntries(Object.entries(e).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
}

describe('fc.diag.v1 — package and service', () => {
  it('lives in package fc.diag.v1', () => {
    expect(RunProbeRequestSchema.typeName).toBe('fc.diag.v1.RunProbeRequest');
    expect(RunProbeResponseSchema.typeName).toBe('fc.diag.v1.RunProbeResponse');
    expect(DiagService.typeName).toBe('fc.diag.v1.DiagService');
  });

  it('DiagService has exactly one RPC, the unary RunProbe(RunProbeRequest) -> RunProbeResponse', () => {
    expect(DiagService.methods.map((m) => m.name)).toEqual(['RunProbe']);
    const m = DiagService.method.runProbe;
    expect(m.methodKind).toBe('unary');
    expect(m.input).toBe(RunProbeRequestSchema);
    expect(m.output).toBe(RunProbeResponseSchema);
  });
});

describe('fc.diag.v1 — enums', () => {
  it('Probe is ROBOTS_SNAPSHOT | ITEM_STATUS and nothing else (there is no cookie-jar RPC)', () => {
    expect(enumValues(Probe)).toEqual({ UNSPECIFIED: 0, ROBOTS_SNAPSHOT: 1, ITEM_STATUS: 2 });
  });

  it('Outcome carries the per-target classes and the probe-level verdicts', () => {
    expect(enumValues(Outcome)).toEqual({
      UNSPECIFIED: 0,
      OK: 1,
      OUTAGE: 2,
      CHALLENGE: 3,
      LOGIN_LOST: 4,
      DISPLAY_GATED: 5,
      NOT_FOUND_AMBIGUOUS: 6,
      COOLDOWN_SKIPPED: 7,
      BUDGET_REFUSED: 8,
      CANARY_UNCONFIGURED: 9,
      ERROR: 10,
    });
  });

  it('TargetRole labels the canary half without ever carrying its id', () => {
    expect(enumValues(TargetRole)).toEqual({ UNSPECIFIED: 0, ROBOTS: 1, ITEM: 2, CANARY: 3, CONTROL: 4 });
  });

  it('AiBarTier mirrors the plugin contract tiers', () => {
    expect(enumValues(AiBarTier)).toEqual({
      UNSPECIFIED: 0,
      FULL_BAR: 1,
      ROUTE_BAR: 2,
      NAMED_NO_ROUTE_BAR: 3,
      CRAWL_DELAY_ONLY: 4,
      NOT_NAMED: 5,
      UNREADABLE: 6,
    });
  });

  it('RobotsDrift separates unchanged, changed and unknown (no pin / no classifier)', () => {
    expect(enumValues(RobotsDrift)).toEqual({ UNSPECIFIED: 0, UNCHANGED: 1, CHANGED: 2, UNKNOWN: 3 });
  });
});

describe('fc.diag.v1 — message shapes (names and numbers are the wire)', () => {
  it('RunProbeRequest', () => {
    expect(shape(RunProbeRequestSchema)).toEqual([
      'probe=1',
      'store=2',
      'origin=3',
      'ids=4',
      'pair=5',
      'max_requests=6',
      'run_id=7',
    ]);
  });

  it('max_requests has explicit presence; the other request scalars do not', () => {
    const presence = Object.fromEntries(RunProbeRequestSchema.fields.map((f) => [f.name, f.presence]));
    expect(presence.max_requests).toBe(FeatureSet_FieldPresence.EXPLICIT);
    expect(presence.store).toBe(FeatureSet_FieldPresence.IMPLICIT);
    expect(presence.pair).toBe(FeatureSet_FieldPresence.IMPLICIT);
    expect(create(RunProbeRequestSchema, {}).maxRequests).toBeUndefined();
    expect(create(RunProbeRequestSchema, { maxRequests: 0 }).maxRequests).toBe(0);
  });

  it('RunProbeResponse', () => {
    expect(shape(RunProbeResponseSchema)).toEqual([
      'verdict=1',
      'requests_issued=2',
      'budget_remaining=3',
      'targets=4',
      'robots=5',
      'hands_off=6',
      'started_at=7',
      'finished_at=8',
      'probe=9',
      'run_id=10',
      'host=11',
    ]);
  });

  it('Target', () => {
    expect(shape(TargetSchema)).toEqual([
      'role=1',
      'status=2',
      'bytes=3',
      'class=4',
      'raw_key=5',
      'sha256=6',
      'redirected=7',
    ]);
  });

  it('RobotsFindings and AiBarSummary', () => {
    expect(shape(RobotsFindingsSchema)).toEqual(['drift=1', 'pin_sha=2', 'summary=3', 'reason=4']);
    expect(shape(AiBarSummarySchema)).toEqual([
      'tier=1',
      'named_tokens=2',
      'full_bar_tokens=3',
      'route_bar_tokens=4',
      'crawl_delay_tokens=5',
      'content_signals=6',
    ]);
  });
});

describe('fc.diag.v1 — round trip', () => {
  it('a populated response survives binary encoding, and its JSON is the @@DIAG-RESULT shape', () => {
    const res = create(RunProbeResponseSchema, {
      verdict: Outcome.OK,
      requestsIssued: 2,
      budgetRemaining: 4,
      targets: [
        { role: TargetRole.CANARY, status: 200, bytes: 41_000, class: Outcome.OK, rawKey: 'raw-html/ab', sha256: 'ab'.repeat(32) },
        { role: TargetRole.CONTROL, status: 500, bytes: 0, class: Outcome.OUTAGE, redirected: true },
      ],
      robots: {
        drift: RobotsDrift.UNKNOWN,
        reason: 'no-classifier',
        summary: { tier: AiBarTier.FULL_BAR, namedTokens: ['claudebot'], fullBarTokens: ['claudebot'] },
      },
      handsOff: true,
      startedAt: '2026-10-02T16:20:00.000Z',
      finishedAt: '2026-10-02T16:20:03.000Z',
      probe: Probe.ITEM_STATUS,
      runId: 'run-1',
      host: 'store.example',
    });
    const back = fromBinary(RunProbeResponseSchema, toBinary(RunProbeResponseSchema, res));
    expect(back).toEqual(res);
    const json = toJson(RunProbeResponseSchema, res) as Record<string, unknown>;
    expect(json.verdict).toBe('OUTCOME_OK');
    expect(json.requestsIssued).toBe(2);
    expect((json.targets as Array<Record<string, unknown>>)[0].class).toBe('OUTCOME_OK');
    expect((json.targets as Array<Record<string, unknown>>)[0].role).toBe('TARGET_ROLE_CANARY');
  });
});
