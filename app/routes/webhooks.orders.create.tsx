import { createOrderWebhookAction } from "../utils/orderWebhookHandler.server";

export const action = createOrderWebhookAction("orders/create");
