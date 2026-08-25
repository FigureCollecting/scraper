/**
 * createCapturingScrapingService — the pooled browser surface the /lookup + /resolve mount uses,
 * REQUIRED to be backed by the shared raw-capture sink (ingest-queue parity): a bare
 * createScrapingService() defaults to a NoopCaptureSink, which silently drops the wire+dom
 * captures of every navigation made through it. That miswiring is exactly what this pins against.
 */
jest.mock('../../../services/engineServices/scrapingService');
jest.mock('../../../services/s3ObjectStore');

import { createCapturingScrapingService } from '../../../services/engineServices/capturingScrapingService';
import { createScrapingService } from '../../../services/engineServices/scrapingService';
import { getRawCaptureSink } from '../../../services/s3ObjectStore';

describe('createCapturingScrapingService', () => {
  it('builds the pooled surface over the SHARED raw-capture sink — never the silent Noop default', () => {
    const sink = { capture: jest.fn() };
    const service = { marker: 'pooled-service' };
    (getRawCaptureSink as jest.Mock).mockReturnValue(sink);
    (createScrapingService as jest.Mock).mockReturnValue(service);

    const out = createCapturingScrapingService();

    expect(getRawCaptureSink).toHaveBeenCalledTimes(1);
    expect(createScrapingService).toHaveBeenCalledWith(sink);
    expect(out).toBe(service);
  });
});
