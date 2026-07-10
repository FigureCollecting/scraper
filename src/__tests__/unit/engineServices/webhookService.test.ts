import { jest } from '@jest/globals';

jest.mock('../../../services/webhookClient');

import * as webhookClient from '../../../services/webhookClient';
import { createWebhookService } from '../../../services/engineServices/webhookService';

const mocked = webhookClient as jest.Mocked<typeof webhookClient>;

describe('createWebhookService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards registerConfig to webhookClient.registerWebhookConfig', () => {
    const service = createWebhookService();
    const config = { webhookUrl: 'https://backend.test/hook', webhookSecret: 's3cret', sessionId: 'sess-1' };

    service.registerConfig(config);

    expect(mocked.registerWebhookConfig).toHaveBeenCalledWith(config);
  });

  it('forwards unregisterConfig to webhookClient.unregisterWebhookConfig', () => {
    const service = createWebhookService();

    service.unregisterConfig('sess-1');

    expect(mocked.unregisterWebhookConfig).toHaveBeenCalledWith('sess-1');
  });

  it('forwards notifyItemComplete and returns its resolved value', async () => {
    mocked.notifyItemComplete.mockResolvedValue(true);
    const service = createWebhookService();
    const payload = { sessionId: 'sess-1', mfcId: '42', status: 'completed' as const };

    const result = await service.notifyItemComplete(payload);

    expect(mocked.notifyItemComplete).toHaveBeenCalledWith(payload);
    expect(result).toBe(true);
  });

  it('forwards notifyPhaseChange and returns its resolved value', async () => {
    mocked.notifyPhaseChange.mockResolvedValue(false);
    const service = createWebhookService();
    const payload = { sessionId: 'sess-1', phase: 'enriching' };

    const result = await service.notifyPhaseChange(payload);

    expect(mocked.notifyPhaseChange).toHaveBeenCalledWith(payload);
    expect(result).toBe(false);
  });

  it('forwards notifyListsSync and returns its resolved value', async () => {
    mocked.notifyListsSync.mockResolvedValue(true);
    const service = createWebhookService();
    const payload = { sessionId: 'sess-1', lists: [] };

    const result = await service.notifyListsSync(payload);

    expect(mocked.notifyListsSync).toHaveBeenCalledWith(payload);
    expect(result).toBe(true);
  });
});
