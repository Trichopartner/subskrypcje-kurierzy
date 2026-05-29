import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  isSellassistCourierShipment,
  isSellassistPaczkomatShipment,
  isValidPaczkomatPointId,
  type DeliveryType,
} from "./deliveryResolution.server";
import {
  getSellassistOrder,
  listSellassistShipments,
  updateSellassistOrder,
} from "./sellassist.client.server";
import {
  fetchShopifyOrderSyncContext,
  runShopifyDeliverySyncForOrder,
} from "./shopifyOrderSync.server";
import { appLog, createWebhookRunId } from "../utils/appLogger.server";

const verifySellassistWebhookSecret = (request: Request): boolean => {
  const expected = process.env.SELLASSIST_WEBHOOK_SECRET?.trim();
  if (!expected) {
    return true;
  }

  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("secret");
  const fromHeader = request.headers.get("x-sellassist-webhook-secret");

  return fromQuery === expected || fromHeader === expected;
};

const resolveShopDomain = async (): Promise<string> => {
  const fromEnv = process.env.SHOPIFY_SHOP_DOMAIN?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const session = await prisma.session.findFirst({
    where: { isOnline: false },
    orderBy: { shop: "asc" },
  });

  if (!session?.shop) {
    throw new Error("SHOPIFY_SHOP_DOMAIN is not configured and no offline session found");
  }

  return session.shop;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const readString = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
};

const extractShopifyOrderNumericId = (
  sellassistOrder: Record<string, unknown>,
): number | null => {
  const directCandidates = [
    sellassistOrder.external_id,
    sellassistOrder.shopify_order_id,
    sellassistOrder.source_order_id,
    sellassistOrder.source_id,
    sellassistOrder.order_id_external,
    sellassistOrder.foreign_id,
  ];

  for (const candidate of directCandidates) {
    const text = readString(candidate);
    if (!text) {
      continue;
    }
    const digits = text.match(/\d{6,}/)?.[0];
    if (digits) {
      return Number(digits);
    }
  }

  const additionalFields = sellassistOrder.additional_fields;
  if (Array.isArray(additionalFields)) {
    for (const field of additionalFields) {
      const row = asRecord(field);
      const value = readString(row.value ?? row.field_value);
      const digits = value?.match(/\d{6,}/)?.[0];
      if (digits) {
        return Number(digits);
      }
    }
  }

  return null;
};

const getSellassistShipmentLabel = (
  sellassistOrder: Record<string, unknown>,
): string => {
  const shipment = asRecord(sellassistOrder.shipment);
  return (
    readString(sellassistOrder.shipment_name) ??
    readString(shipment.name) ??
    readString(sellassistOrder.delivery_method) ??
    readString(sellassistOrder.shipment_method) ??
    ""
  );
};

const getSellassistShipmentId = (
  sellassistOrder: Record<string, unknown>,
): string | null => {
  const shipment = asRecord(sellassistOrder.shipment);
  return (
    readString(sellassistOrder.shipment_id) ??
    readString(shipment.id) ??
    readString(sellassistOrder.delivery_method_id)
  );
};

const getSellassistPickupPointLabel = (
  sellassistOrder: Record<string, unknown>,
): string | null => {
  const deliveryAddress = asRecord(sellassistOrder.delivery_address);
  const candidates = [
    readString(deliveryAddress.pickup_point),
    readString(deliveryAddress.point_name),
    readString(deliveryAddress.company),
    readString(deliveryAddress.name),
    readString(deliveryAddress.address_1),
    readString(deliveryAddress.street),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const match = candidate.match(/paczkomat[y]?\s*:?\s*(.+)$/i);
    if (!match?.[1]) {
      continue;
    }
    const value = match[1].trim();
    if (isValidPaczkomatPointId(value)) {
      return value;
    }
  }

  const additionalFields = sellassistOrder.additional_fields;
  if (Array.isArray(additionalFields)) {
    for (const field of additionalFields) {
      const row = asRecord(field);
      const key = readString(row.field_name ?? row.name)?.toLowerCase() ?? "";
      const value = readString(row.value ?? row.field_value);
      if (
        value &&
        (key.includes("pickuppoint") || key.includes("paczkomat")) &&
        isValidPaczkomatPointId(value)
      ) {
        return value;
      }
    }
  }

  return null;
};

let cachedShipments: Array<{ id: string; name: string }> | null = null;

const resolveShipmentIdForDeliveryType = async (
  deliveryType: DeliveryType,
): Promise<string | null> => {
  if (deliveryType === "courier") {
    const fromEnv = process.env.SELLASSIST_SHIPMENT_ID_KURIER?.trim();
    if (fromEnv) {
      return fromEnv;
    }
  }

  if (deliveryType === "pickup") {
    const fromEnv = process.env.SELLASSIST_SHIPMENT_ID_PACZKOMAT?.trim();
    if (fromEnv) {
      return fromEnv;
    }
  }

  if (!cachedShipments) {
    cachedShipments = await listSellassistShipments();
  }

  const match = cachedShipments.find((shipment) => {
    const name = shipment.name.toLowerCase();
    if (deliveryType === "courier") {
      return name.includes("kurier");
    }
    if (deliveryType === "pickup") {
      return name.includes("paczkomat");
    }
    return false;
  });

  return match?.id ?? null;
};

const shouldFixSellassistShipment = ({
  shopifyDeliveryType,
  sellassistShipmentLabel,
  sellassistPickupPoint,
}: {
  shopifyDeliveryType: DeliveryType;
  sellassistShipmentLabel: string;
  sellassistPickupPoint: string | null;
}): boolean => {
  const sellassistPaczkomat = isSellassistPaczkomatShipment(sellassistShipmentLabel);
  const sellassistCourier = isSellassistCourierShipment(sellassistShipmentLabel);

  if (shopifyDeliveryType === "courier" && sellassistPaczkomat && !sellassistCourier) {
    return true;
  }

  if (
    shopifyDeliveryType === "pickup" &&
    sellassistPaczkomat &&
    !isValidPaczkomatPointId(sellassistPickupPoint)
  ) {
    return true;
  }

  return false;
};

export const processSellassistOrderWebhook = async (
  sellassistOrderId: string,
  request: Request,
): Promise<Response> => {
  const runId = createWebhookRunId();

  if (!verifySellassistWebhookSecret(request)) {
    appLog.warn("sellassist:webhook-unauthorized", { runId, sellassistOrderId });
    return new Response("Unauthorized", { status: 401 });
  }

  appLog.info("sellassist:webhook-start", {
    runId,
    sellassistOrderId,
    method: request.method,
    url: request.url,
  });

  try {
    const sellassistOrder = asRecord(await getSellassistOrder(sellassistOrderId));
    const shopifyOrderNumericId = extractShopifyOrderNumericId(sellassistOrder);

    if (!shopifyOrderNumericId) {
      appLog.warn("sellassist:abort-no-shopify-id", {
        runId,
        sellassistOrderId,
        sellassistOrderKeys: Object.keys(sellassistOrder),
      });
      return Response.json({ ok: false, reason: "NO_SHOPIFY_ORDER_ID" }, { status: 200 });
    }

    const shop = await resolveShopDomain();
    const { admin } = await unauthenticated.admin(shop);
    const shopifyContext = await fetchShopifyOrderSyncContext(admin, shopifyOrderNumericId);

    if (!shopifyContext) {
      appLog.warn("sellassist:abort-shopify-order-not-found", {
        runId,
        sellassistOrderId,
        shopifyOrderNumericId,
        shop,
      });
      return Response.json(
        { ok: false, reason: "SHOPIFY_ORDER_NOT_FOUND", shopifyOrderNumericId },
        { status: 200 },
      );
    }

    const sellassistShipmentLabel = getSellassistShipmentLabel(sellassistOrder);
    const sellassistPickupPoint = getSellassistPickupPointLabel(sellassistOrder);
    const needsSellassistFix = shouldFixSellassistShipment({
      shopifyDeliveryType: shopifyContext.deliveryType,
      sellassistShipmentLabel,
      sellassistPickupPoint,
    });

    appLog.info("sellassist:analysis", {
      runId,
      sellassistOrderId,
      shopifyOrderNumericId,
      shopifyDeliveryType: shopifyContext.deliveryType,
      sellassistShipmentLabel,
      sellassistPickupPoint,
      sellassistShipmentId: getSellassistShipmentId(sellassistOrder),
      isRecurring: shopifyContext.isRecurringSubscriptionOrder,
      needsSellassistFix,
      shopifyShipping: {
        code: shopifyContext.shippingCode,
        title: shopifyContext.shippingTitle,
      },
    });

    if (shopifyContext.isRecurringSubscriptionOrder) {
      await runShopifyDeliverySyncForOrder({
        admin,
        shop,
        context: shopifyContext,
        runId,
        topic: "sellassist/webhook",
      });
    }

    if (needsSellassistFix && shopifyContext.deliveryType !== "unknown") {
      const targetShipmentId = await resolveShipmentIdForDeliveryType(
        shopifyContext.deliveryType,
      );

      if (!targetShipmentId) {
        appLog.warn("sellassist:abort-no-target-shipment-id", {
          runId,
          sellassistOrderId,
          shopifyDeliveryType: shopifyContext.deliveryType,
        });
      } else {
        const currentShipmentId = getSellassistShipmentId(sellassistOrder);
        if (currentShipmentId !== targetShipmentId) {
          await updateSellassistOrder(sellassistOrderId, {
            shipment_id: targetShipmentId,
          });

          appLog.info("sellassist:shipment-updated", {
            runId,
            sellassistOrderId,
            fromShipmentId: currentShipmentId,
            toShipmentId: targetShipmentId,
            shopifyDeliveryType: shopifyContext.deliveryType,
          });
        }
      }
    }

    appLog.info("sellassist:webhook-finished", {
      runId,
      sellassistOrderId,
      shopifyOrderNumericId,
    });

    return Response.json({
      ok: true,
      runId,
      shopifyOrderNumericId,
      shopifyDeliveryType: shopifyContext.deliveryType,
      needsSellassistFix,
    });
  } catch (error) {
    appLog.error("sellassist:webhook-failed", {
      runId,
      sellassistOrderId,
      error:
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : error,
    });
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        runId,
      },
      { status: 500 },
    );
  }
};
