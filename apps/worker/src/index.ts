import {
  createDb,
  handleAiSupportForConversation,
  processCampaignRecipientBatch,
  runScheduledCampaignTick,
  type CampaignQueueMessageBody,
  type CampaignQueueProducer,
  type WorkersAiBinding
} from '@wacrm/db';
import { MetaCloudProvider, QrBridgeClient, type WhatsAppProvider } from '@wacrm/providers';

export type EngineQueueJob =
  | CampaignQueueMessageBody
  | {
      kind: 'ai_reply';
      organizationId: string;
      conversationId: string;
      customerText: string;
    };

export interface WorkerEngineEnv {
  DB?: D1Database;
  AI?: WorkersAiBinding;
  JOBS_QUEUE?: Queue<EngineQueueJob>;
  ENCRYPTION_KEY?: string;
  META_GRAPH_VERSION?: string;
  QR_BRIDGE_URL?: string;
  QR_BRIDGE_SECRET?: string;
}

export interface EngineHandlerOptions {
  provider?: WhatsAppProvider;
  qrBridge?: QrBridgeClient;
}

export function createWorkerHandlers(options: EngineHandlerOptions = {}) {
  function getProvider(env: WorkerEngineEnv): WhatsAppProvider {
    return (
      options.provider ??
      new MetaCloudProvider({ graphVersion: env.META_GRAPH_VERSION?.trim() || 'v21.0' })
    );
  }

  function getQrBridge(env: WorkerEngineEnv): QrBridgeClient | undefined {
    if (options.qrBridge) return options.qrBridge;
    const url = env.QR_BRIDGE_URL?.trim();
    const secret = env.QR_BRIDGE_SECRET?.trim();
    if (!url || !secret || secret.length < 16) return undefined;
    return new QrBridgeClient({ baseUrl: url, secret });
  }

  return {
    async scheduled(_controller: ScheduledController, env: WorkerEngineEnv): Promise<void> {
      if (!env.DB) return;
      const db = createDb(env.DB);
      const jobsQueue: CampaignQueueProducer | undefined = env.JOBS_QUEUE
        ? {
            sendBatch: (msgs) => env.JOBS_QUEUE!.sendBatch(msgs)
          }
        : undefined;

      await runScheduledCampaignTick(db, {
        jobsQueue,
        encryptionKey: env.ENCRYPTION_KEY,
        provider: getProvider(env),
        qrBridge: getQrBridge(env),
        maxBatchRecipients: 10,
        inlineFallbackLimit: 5
      });
    },

    async queue(batch: MessageBatch<EngineQueueJob>, env: WorkerEngineEnv): Promise<void> {
      if (!env.DB) {
        for (const msg of batch.messages) msg.retry();
        return;
      }

      const db = createDb(env.DB);
      const provider = getProvider(env);
      const qrBridge = getQrBridge(env);

      for (const msg of batch.messages) {
        try {
          if ('kind' in msg.body && msg.body.kind === 'ai_reply') {
            await handleAiSupportForConversation(db, env.DB, {
              organizationId: msg.body.organizationId,
              conversationId: msg.body.conversationId,
              customerText: msg.body.customerText,
              aiBinding: env.AI,
              encryptionKey: env.ENCRYPTION_KEY,
              provider,
              qrBridge,
              sendOutboundReply: true
            });
            msg.ack();
            continue;
          }

          const result = await processCampaignRecipientBatch(db, {
            message: msg.body as CampaignQueueMessageBody,
            encryptionKey: env.ENCRYPTION_KEY,
            provider,
            qrBridge
          });
          if (result.hasRetryableErrors) {
            msg.retry();
          } else {
            msg.ack();
          }
        } catch {
          msg.retry();
        }
      }
    }
  };
}

const defaultHandlers = createWorkerHandlers();

export default {
  scheduled: defaultHandlers.scheduled,
  queue: defaultHandlers.queue
};
