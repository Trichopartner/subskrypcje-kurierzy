import type { LoaderFunctionArgs } from "react-router";
import { appLog } from "../utils/appLogger.server";
import { checkDatabaseHealth } from "../utils/dbHealth.server";

/** GET — diagnostyka deploymentu (otwórz w przeglądarce). */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const dbHealth = await checkDatabaseHealth();

  const info = {
    ok: dbHealth.ok,
    service: "proteoglikany-dostawa",
    shopifyAppUrl: process.env.SHOPIFY_APP_URL ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
    env: {
      hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
      hasShopifyApiKey: Boolean(process.env.SHOPIFY_API_KEY),
      hasShopifyApiSecret: Boolean(process.env.SHOPIFY_API_SECRET),
      hasScopes: Boolean(process.env.SCOPES),
    },
    database: dbHealth,
    timestamp: new Date().toISOString(),
    requestUrl: request.url,
  };

  appLog.info("health:ping", info);

  return Response.json(info, {
    status: dbHealth.ok ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
};
