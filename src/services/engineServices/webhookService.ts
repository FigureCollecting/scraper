/**
 * WebhookService adapter — thin pass-through to the existing webhookClient
 * module. No mapping needed: webhookClient's config/payload shapes already
 * match the generic contract exactly.
 */
import {
  registerWebhookConfig,
  unregisterWebhookConfig,
  notifyItemComplete,
  notifyPhaseChange,
  notifyListsSync,
} from '../webhookClient.js';
import { WebhookService } from '../pluginTypes.js';

export function createWebhookService(): WebhookService {
  return {
    registerConfig: registerWebhookConfig,
    unregisterConfig: unregisterWebhookConfig,
    notifyItemComplete,
    notifyPhaseChange,
    notifyListsSync,
  };
}
