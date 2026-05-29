import {
  resolveDeliveryType,
  type DeliveryType,
} from "./deliveryResolution.server";
import { processSubscriptionDeliverySyncWebhook } from "./subscriptionDeliverySync.server";

const APPSTLE_RECURRING_ORDER_TAG = "appstle_subscription_recurring_order";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type ShopifyOrderSyncContext = {
  orderNumericId: number;
  orderGid: string;
  orderName: string | null;
  tags: string[];
  isRecurringSubscriptionOrder: boolean;
  customerNumericId: number | null;
  shippingCode: string | null;
  shippingTitle: string | null;
  deliveryType: DeliveryType;
};

const parseNumericIdFromGid = (gid: string | null | undefined): number | null => {
  if (!gid) {
    return null;
  }

  const match = gid.match(/(\d+)$/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
};

export const fetchShopifyOrderSyncContext = async (
  admin: AdminGraphqlClient,
  orderNumericId: number,
): Promise<ShopifyOrderSyncContext | null> => {
  const orderId = `gid://shopify/Order/${orderNumericId}`;
  const response = await admin.graphql(
    `#graphql
      query ShopifyOrderForSync($orderId: ID!) {
        order(id: $orderId) {
          id
          name
          tags
          customer {
            id
          }
          shippingLine {
            code
            title
          }
        }
      }`,
    { variables: { orderId } },
  );

  const data = (await response.json()) as {
    data?: {
      order?: {
        id: string;
        name?: string | null;
        tags?: string[];
        customer?: { id?: string | null } | null;
        shippingLine?: { code?: string | null; title?: string | null } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (data.errors?.length || !data.data?.order) {
    return null;
  }

  const order = data.data.order;
  const shippingCode = order.shippingLine?.code ?? null;
  const shippingTitle = order.shippingLine?.title ?? null;
  const tags = order.tags ?? [];

  return {
    orderNumericId,
    orderGid: order.id,
    orderName: order.name ?? null,
    tags,
    isRecurringSubscriptionOrder: tags.includes(APPSTLE_RECURRING_ORDER_TAG),
    customerNumericId: parseNumericIdFromGid(order.customer?.id),
    shippingCode,
    shippingTitle,
    deliveryType: resolveDeliveryType({ shippingTitle, shippingCode }),
  };
};

export const runShopifyDeliverySyncForOrder = async ({
  admin,
  shop,
  context,
  runId,
  topic,
}: {
  admin: AdminGraphqlClient;
  shop: string;
  context: ShopifyOrderSyncContext;
  runId: string;
  topic: string;
}): Promise<void> => {
  await processSubscriptionDeliverySyncWebhook({
    admin,
    shop,
    topic,
    runId,
    payload: {
      id: context.orderNumericId,
      tags: context.tags.join(", "),
      customer: context.customerNumericId
        ? { id: context.customerNumericId }
        : undefined,
      shipping_lines: [
        {
          title: context.shippingTitle ?? undefined,
          code: context.shippingCode ?? undefined,
        },
      ],
    },
  });
};
