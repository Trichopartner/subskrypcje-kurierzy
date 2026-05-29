import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { processSellassistOrderWebhook } from "../services/sellassistOrderSync.server";
import { appLog, createWebhookRunId } from "../utils/appLogger.server";

/** Webhook Sellassist: Wywołaj URL z {id_order} w automatyzacji zamówień. */
const handleSellassistWebhook = async (
  request: Request,
  orderIdParam: string | undefined,
) => {
  const runId = createWebhookRunId();
  appLog.info("sellassist:route-hit", {
    runId,
    orderIdParam: orderIdParam ?? null,
    method: request.method,
    pathname: new URL(request.url).pathname,
  });

  return processSellassistOrderWebhook(orderIdParam ?? "", request);
};

export const loader = async ({ request, params }: LoaderFunctionArgs) =>
  handleSellassistWebhook(request, params.orderId);

export const action = async ({ request, params }: ActionFunctionArgs) =>
  handleSellassistWebhook(request, params.orderId);
