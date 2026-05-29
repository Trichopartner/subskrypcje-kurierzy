import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { processSellassistOrderWebhook } from "../services/sellassistOrderSync.server";

/** Webhook Sellassist: Wywołaj URL z {id_order} w automatyzacji zamówień. */
export const loader = async ({ request, params }: LoaderFunctionArgs) =>
  processSellassistOrderWebhook(params.orderId ?? "", request);

export const action = async ({ request, params }: ActionFunctionArgs) =>
  processSellassistOrderWebhook(params.orderId ?? "", request);
