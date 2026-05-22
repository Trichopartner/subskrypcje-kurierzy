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

  // Log PRZED authenticate — widać nawet gdy HMAC/DB się wyłoży
  appLog.info("webhook:orders/create:hit", {
    runId,
    path: new URL(request.url).pathname,
    shopifyTopic: request.headers.get("x-shopify-topic"),
    shopifyShop: request.headers.get("x-shopify-shop-domain"),
    deployedAppUrl: process.env.SHOPIFY_APP_URL ?? null,
  });

  appLog.info("webhook:orders/create:received", {
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

    appLog.info("webhook:orders/create:authenticated", {
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

    appLog.info("webhook:orders/create:finished", {
      runId,
      topic,
      shop,
      totalDurationMs: Date.now() - startedAt,
    });
  } catch (error) {
    appLog.error("webhook:orders/create:failed", {
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
