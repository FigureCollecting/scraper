/**
 * Test helper — a realistic, NON-EMPTY ingest WriteStats (mirrors @figurecollecting/ingest-contract
 * WriteStats). A successful spine ingest persists at least one row, so a `send` fake that stands in
 * for success must resolve one of these (persistedRows >= 1) to pass the queue's persist-or-fail
 * honesty gate. Placeholder `{ sourceId: 'x' }` objects report zero persisted and now (correctly)
 * count as EMPTY failures. Override any field per test.
 */
export function okWriteStats(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceId: 'src-1',
    productId: 'prod-1',
    claims: { emitted: 1, inserted: 1, deduped: 0, quarantined: 0, dropped: 0 },
    identifiers: { emitted: 0, inserted: 0, deduped: 0, dropped: 0 },
    prices: { emitted: 0, inserted: 0, deduped: 0, skipped: 0, dropped: 0 },
    availability: { emitted: 0, inserted: 0, deduped: 0, dropped: 0 },
    warnings: [] as string[],
    registeredNewAttrs: 0,
    emptyFields: 0,
    ...overrides,
  };
}
