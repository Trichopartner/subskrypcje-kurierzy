import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processSubscriptionDeliverySyncWebhook } from "../services/subscriptionDeliverySync.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop, admin } = await authenticate.webhook(request);
  await processSubscriptionDeliverySyncWebhook({ admin, payload, topic, shop });
  return new Response();
};
