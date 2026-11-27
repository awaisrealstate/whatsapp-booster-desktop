import {
  createDb,
  handleAiSupportForConversation,
  processCampaignRecipientBatch,
  runScheduledCampaignTick,
  getScheduledMessagesForExecution,
  updateScheduledMessageStatus,
  getDecryptedMetaCredentials,
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
  GEMINI_API_KEY?: string;
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
              geminiApiKey: env.GEMINI_API_KEY,
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
    },

    async fetch(request: Request, env: WorkerEngineEnv): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        return Response.json(
          {
            ok: true,
            service: 'wacrm-engine',
            mode: 'cron_and_queue_worker',
            bindings: {
              database: Boolean(env.DB),
              queue: Boolean(env.JOBS_QUEUE),
              ai: Boolean(env.AI),
              encryptionConfigured: Boolean(env.ENCRYPTION_KEY && env.ENCRYPTION_KEY.trim().length >= 16),
              qrBridgeConfigured: Boolean(
                env.QR_BRIDGE_URL?.trim() && env.QR_BRIDGE_SECRET && env.QR_BRIDGE_SECRET.trim().length >= 16
              )
            }
          },
          { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }
        );
      }
      return Response.json(
        { error: { code: 'NOT_FOUND', message: 'wacrm-engine handles Cron and Queue workloads.' } },
        { status: 404, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }
      );
    }
  };
}

const defaultHandlers = createWorkerHandlers();

export default {
  fetch: defaultHandlers.fetch,
  scheduled: defaultHandlers.scheduled,
  queue: defaultHandlers.queue
};
