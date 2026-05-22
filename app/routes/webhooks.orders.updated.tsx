import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processSubscriptionDeliverySyncWebhook } from "../services/subscriptionDeliverySync.server";
import {
  appLog,
  createWebhookRunId,
  sanitizeOrderWebhookPayload,
} from "../utils/appLogger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const runId = createWebhookRunId();
  const startedAt = Date.now();

  appLog.info("webhook:orders/updated:received", {
    runId,
    method: request.method,
    url: request.url,
    contentType: request.headers.get("content-type"),
    shopifyTopic: request.headers.get("x-shopify-topic"),
    shopifyShop: request.headers.get("x-shopify-shop-domain"),
    shopifyWebhookId: request.headers.get("x-shopify-webhook-id"),
  });

  try {
    const { payload, topic, shop, admin } = await authenticate.webhook(request);

    appLog.info("webhook:orders/updated:authenticated", {
      runId,
      topic,
      shop,
      hasAdmin: Boolean(admin),
      durationMs: Date.now() - startedAt,
      payloadSummary: sanitizeOrderWebhookPayload(payload),
    });

    await processSubscriptionDeliverySyncWebhook({
      admin,
      payload,
      topic,
      shop,
      runId,
    });

    appLog.info("webhook:orders/updated:finished", {
      runId,
      topic,
      shop,
      totalDurationMs: Date.now() - startedAt,
    });
  } catch (error) {
    appLog.error("webhook:orders/updated:failed", {
      runId,
      totalDurationMs: Date.now() - startedAt,
      error:
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : error,
    });
    throw error;
  }

  return new Response();
};
