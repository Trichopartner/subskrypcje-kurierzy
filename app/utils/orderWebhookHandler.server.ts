import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processSubscriptionDeliverySyncWebhook } from "../services/subscriptionDeliverySync.server";
import { checkDatabaseHealth } from "./dbHealth.server";
import {
  appLog,
  createWebhookRunId,
  sanitizeOrderWebhookPayload,
} from "./appLogger.server";

const webhookFailureResponse = (
  status: number,
  body: Record<string, unknown>,
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const handleOrderWebhook = async (
  request: Request,
  webhookName: "orders/create" | "orders/updated",
): Promise<Response> => {
  const runId = createWebhookRunId();
  const startedAt = Date.now();
  const logPrefix = `webhook:${webhookName}`;

  appLog.info(`${logPrefix}:hit`, {
    runId,
    path: new URL(request.url).pathname,
    shopifyTopic: request.headers.get("x-shopify-topic"),
    shopifyShop: request.headers.get("x-shopify-shop-domain"),
    deployedAppUrl: process.env.SHOPIFY_APP_URL ?? null,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    hasShopifyApiSecret: Boolean(process.env.SHOPIFY_API_SECRET),
    hasShopifyApiKey: Boolean(process.env.SHOPIFY_API_KEY),
  });

  const dbHealth = await checkDatabaseHealth();
  if (!dbHealth.ok) {
    appLog.error(`${logPrefix}:abort-db`, {
      runId,
      dbHealth,
      fixSteps: [
        "Vercel → projekt proteoglikany-paczkomaty1 → Settings → Environment Variables",
        "Ustaw DATABASE_URL (ten sam Neon co lokalnie)",
        "Redeploy. Build musi uruchomić: prisma migrate deploy",
      ],
    });

    return webhookFailureResponse(500, {
      error: "Database not ready",
      runId,
      ...dbHealth,
    });
  }

  try {
    const { payload, topic, shop, admin } = await authenticate.webhook(request);

    appLog.info(`${logPrefix}:authenticated`, {
      runId,
      topic,
      shop,
      hasAdmin: Boolean(admin),
      sessionCount: dbHealth.sessionCount,
      durationMs: Date.now() - startedAt,
      payloadSummary: sanitizeOrderWebhookPayload(payload),
    });

    try {
      await processSubscriptionDeliverySyncWebhook({
        admin,
        payload,
        topic,
        shop,
        runId,
      });
    } catch (syncError) {
      appLog.error(`${logPrefix}:sync-failed`, {
        runId,
        error:
          syncError instanceof Error
            ? { message: syncError.message, stack: syncError.stack }
            : syncError,
      });
      // 200 — webhook odebrany; błąd logiki nie powinien powodować nieskończonych retry Shopify
      return webhookFailureResponse(200, {
        ok: false,
        error: "Sync failed — see server logs",
        runId,
      });
    }

    appLog.info(`${logPrefix}:finished`, {
      runId,
      topic,
      shop,
      totalDurationMs: Date.now() - startedAt,
    });

    return new Response();
  } catch (error) {
    const errorInfo =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };

    appLog.error(`${logPrefix}:failed`, {
      runId,
      totalDurationMs: Date.now() - startedAt,
      error: errorInfo,
      likelyCauses: [
        "SHOPIFY_API_SECRET na Vercel ≠ secret w Partner Dashboard (błąd HMAC)",
        "Brak sesji sklepu w tabeli Session — otwórz aplikację w adminie lub przeinstaluj",
        "DATABASE_URL błędny lub migracje nie wykonane",
      ],
    });

    return webhookFailureResponse(500, {
      error: "Webhook authentication or processing failed",
      runId,
      details: errorInfo.message,
    });
  }
};

export const createOrderWebhookAction =
  (webhookName: "orders/create" | "orders/updated") =>
  async ({ request }: ActionFunctionArgs): Promise<Response> =>
    handleOrderWebhook(request, webhookName);
