import type { LoaderFunctionArgs } from "react-router";
import { appLog } from "../utils/appLogger.server";

/** GET — sprawdź, czy trafiasz na właściwy deployment (otwórz w przeglądarce). */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const info = {
    ok: true,
    service: "proteoglikany-dostawa",
    shopifyAppUrl: process.env.SHOPIFY_APP_URL ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    timestamp: new Date().toISOString(),
    requestUrl: request.url,
  };

  appLog.info("health:ping", info);

  return Response.json(info, {
    headers: { "cache-control": "no-store" },
  });
};
