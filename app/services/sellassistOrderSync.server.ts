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
import {
  appLog,
  createWebhookRunId,
  sanitizeRequestHeaders,
  sanitizeSellassistOrder,
} from "../utils/appLogger.server";

const verifySellassistWebhookSecret = (
  request: Request,
  logContext: { runId: string },
): boolean => {
  const expected = process.env.SELLASSIST_WEBHOOK_SECRET?.trim();
  if (!expected) {
    appLog.debug("sellassist:auth-skip", {
      ...logContext,
      reason: "SELLASSIST_WEBHOOK_SECRET not set — accepting all requests",
    });
    return true;
  }

  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("secret");
  const fromHeader = request.headers.get("x-sellassist-webhook-secret");
  const ok = fromQuery === expected || fromHeader === expected;

  appLog.debug("sellassist:auth-check", {
    ...logContext,
    ok,
    hasQuerySecret: Boolean(fromQuery),
    hasHeaderSecret: Boolean(fromHeader),
  });

  return ok;
};

const readWebhookBody = async (request: Request): Promise<unknown> => {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }

  const contentType = request.headers.get("content-type") ?? "";
  const text = await request.text();

  if (!text.trim()) {
    return null;
  }

  if (contentType.includes("json") || text.trim().startsWith("{")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text.slice(0, 500) };
    }
  }

  return { raw: text.slice(0, 500), contentType };
};

const extractOrderIdFromBody = (body: unknown): string | null => {
  const row = asRecord(body);
  return (
    readString(row.id_order) ??
    readString(row.idOrder) ??
    readString(row.order_id) ??
    readString(row.orderId)
  );
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
  logContext?: { runId: string },
): number | null => {
  const directCandidates: Array<{ field: string; value: unknown }> = [
    { field: "external_id", value: sellassistOrder.external_id },
    { field: "shopify_order_id", value: sellassistOrder.shopify_order_id },
    { field: "source_order_id", value: sellassistOrder.source_order_id },
    { field: "source_id", value: sellassistOrder.source_id },
    { field: "order_id_external", value: sellassistOrder.order_id_external },
    { field: "foreign_id", value: sellassistOrder.foreign_id },
  ];

  for (const { field, value } of directCandidates) {
    const text = readString(value);
    if (!text) {
      continue;
    }
    const digits = text.match(/\d{6,}/)?.[0];
    if (digits) {
      appLog.debug("sellassist:shopify-id-from-field", {
        ...logContext,
        field,
        rawValue: text,
        shopifyOrderNumericId: Number(digits),
      });
      return Number(digits);
    }
    appLog.debug("sellassist:shopify-id-field-no-match", {
      ...logContext,
      field,
      rawValue: text,
    });
  }

  const additionalFields = sellassistOrder.additional_fields;
  if (Array.isArray(additionalFields)) {
    for (const field of additionalFields) {
      const row = asRecord(field);
      const value = readString(row.value ?? row.field_value);
      const digits = value?.match(/\d{6,}/)?.[0];
      if (digits) {
        appLog.debug("sellassist:shopify-id-from-additional-field", {
          ...logContext,
          fieldName: readString(row.field_name ?? row.name),
          shopifyOrderNumericId: Number(digits),
        });
        return Number(digits);
      }
    }
  }

  appLog.warn("sellassist:shopify-id-not-found", {
    ...logContext,
    triedDirectFields: directCandidates.map((c) => c.field),
    additionalFieldsCount: Array.isArray(additionalFields)
      ? additionalFields.length
      : 0,
  });

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
  logContext: { runId: string },
): Promise<string | null> => {
  if (deliveryType === "courier") {
    const fromEnv = process.env.SELLASSIST_SHIPMENT_ID_KURIER?.trim();
    if (fromEnv) {
      appLog.info("sellassist:shipment-id-from-env", {
        ...logContext,
        deliveryType,
        envVar: "SELLASSIST_SHIPMENT_ID_KURIER",
        shipmentId: fromEnv,
      });
      return fromEnv;
    }
  }

  if (deliveryType === "pickup") {
    const fromEnv = process.env.SELLASSIST_SHIPMENT_ID_PACZKOMAT?.trim();
    if (fromEnv) {
      appLog.info("sellassist:shipment-id-from-env", {
        ...logContext,
        deliveryType,
        envVar: "SELLASSIST_SHIPMENT_ID_PACZKOMAT",
        shipmentId: fromEnv,
      });
      return fromEnv;
    }
  }

  if (!cachedShipments) {
    appLog.info("sellassist:loading-shipments-list", logContext);
    cachedShipments = await listSellassistShipments();
    appLog.info("sellassist:shipments-list-loaded", {
      ...logContext,
      count: cachedShipments.length,
      names: cachedShipments.map((s) => s.name),
    });
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

  appLog.info("sellassist:shipment-id-resolved", {
    ...logContext,
    deliveryType,
    matched: match ?? null,
    usedCache: true,
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
  const validPickupPoint = isValidPaczkomatPointId(sellassistPickupPoint);

  let needsFix = false;
  let reason: string | null = null;

  if (shopifyDeliveryType === "courier" && sellassistPaczkomat && !sellassistCourier) {
    needsFix = true;
    reason = "shopify-courier-but-sellassist-paczkomat";
  }

  if (
    shopifyDeliveryType === "pickup" &&
    sellassistPaczkomat &&
    !validPickupPoint
  ) {
    needsFix = true;
    reason = "shopify-pickup-but-sellassist-missing-valid-point-id";
  }

  appLog.debug("sellassist:should-fix-shipment", {
    shopifyDeliveryType,
    sellassistShipmentLabel,
    sellassistPickupPoint,
    sellassistPaczkomat,
    sellassistCourier,
    validPickupPoint,
    needsFix,
    reason,
  });

  return needsFix;
};

export const processSellassistOrderWebhook = async (
  sellassistOrderId: string,
  request: Request,
): Promise<Response> => {
  const runId = createWebhookRunId();
  const logContext = { runId };
  const startedAt = Date.now();

  if (!verifySellassistWebhookSecret(request, logContext)) {
    appLog.warn("sellassist:webhook-unauthorized", {
      ...logContext,
      sellassistOrderId,
      headers: sanitizeRequestHeaders(request),
    });
    return new Response("Unauthorized", { status: 401 });
  }

  const requestBody = await readWebhookBody(request);
  const orderIdFromBody = extractOrderIdFromBody(requestBody);
  const effectiveSellassistOrderId =
    sellassistOrderId.trim() && !/^\{.*\}$/.test(sellassistOrderId.trim())
      ? sellassistOrderId.trim()
      : (orderIdFromBody ?? sellassistOrderId.trim());

  appLog.info("sellassist:webhook-start", {
    ...logContext,
    sellassistOrderIdParam: sellassistOrderId,
    effectiveSellassistOrderId,
    orderIdFromBody,
    method: request.method,
    url: request.url,
    headers: sanitizeRequestHeaders(request),
    bodyPreview: requestBody,
    env: {
      hasSellassistApiKey: Boolean(process.env.SELLASSIST_API_KEY),
      hasSellassistAccount: Boolean(process.env.SELLASSIST_ACCOUNT),
      hasShopifyShopDomain: Boolean(process.env.SHOPIFY_SHOP_DOMAIN),
      appUrl: process.env.SHOPIFY_APP_URL ?? null,
    },
  });

  try {
    const fetchSellassistStartedAt = Date.now();
    const sellassistOrder = asRecord(
      await getSellassistOrder(effectiveSellassistOrderId),
    );

    appLog.info("sellassist:order-fetched", {
      ...logContext,
      effectiveSellassistOrderId,
      durationMs: Date.now() - fetchSellassistStartedAt,
      orderSummary: sanitizeSellassistOrder(sellassistOrder),
    });

    const shopifyOrderNumericId = extractShopifyOrderNumericId(
      sellassistOrder,
      logContext,
    );

    if (!shopifyOrderNumericId) {
      appLog.warn("sellassist:abort-no-shopify-id", {
        runId,
        sellassistOrderId,
        sellassistOrderKeys: Object.keys(sellassistOrder),
      });
      return Response.json({ ok: false, reason: "NO_SHOPIFY_ORDER_ID" }, { status: 200 });
    }

    const shop = await resolveShopDomain();
    appLog.info("sellassist:shop-resolved", { ...logContext, shop });

    const { admin } = await unauthenticated.admin(shop);
    appLog.info("sellassist:admin-client", {
      ...logContext,
      shop,
      hasAdmin: Boolean(admin),
    });

    const shopifyContext = await fetchShopifyOrderSyncContext(
      admin,
      shopifyOrderNumericId,
      logContext,
    );

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
      appLog.info("sellassist:starting-shopify-sync", {
        ...logContext,
        shopifyOrderNumericId,
        orderName: shopifyContext.orderName,
      });
      await runShopifyDeliverySyncForOrder({
        admin,
        shop,
        context: shopifyContext,
        runId,
        topic: "sellassist/webhook",
      });
      appLog.info("sellassist:shopify-sync-finished", {
        ...logContext,
        shopifyOrderNumericId,
      });
    } else {
      appLog.info("sellassist:skip-shopify-sync", {
        ...logContext,
        reason: "NOT_RECURRING_SUBSCRIPTION_ORDER",
        tags: shopifyContext.tags,
      });
    }

    if (needsSellassistFix && shopifyContext.deliveryType !== "unknown") {
      const targetShipmentId = await resolveShipmentIdForDeliveryType(
        shopifyContext.deliveryType,
        logContext,
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
          appLog.info("sellassist:shipment-update-start", {
            ...logContext,
            effectiveSellassistOrderId,
            fromShipmentId: currentShipmentId,
            toShipmentId: targetShipmentId,
          });

          await updateSellassistOrder(effectiveSellassistOrderId, {
            shipment_id: targetShipmentId,
          });

          appLog.info("sellassist:shipment-updated", {
            ...logContext,
            effectiveSellassistOrderId,
            fromShipmentId: currentShipmentId,
            toShipmentId: targetShipmentId,
            shopifyDeliveryType: shopifyContext.deliveryType,
          });
        } else {
          appLog.info("sellassist:shipment-already-correct", {
            ...logContext,
            shipmentId: currentShipmentId,
            shopifyDeliveryType: shopifyContext.deliveryType,
          });
        }
      }
    } else {
      appLog.info("sellassist:skip-shipment-fix", {
        ...logContext,
        needsSellassistFix,
        shopifyDeliveryType: shopifyContext.deliveryType,
        reason: !needsSellassistFix
          ? "NO_FIX_NEEDED"
          : "UNKNOWN_SHOPIFY_DELIVERY_TYPE",
      });
    }

    appLog.info("sellassist:webhook-finished", {
      ...logContext,
      effectiveSellassistOrderId,
      shopifyOrderNumericId,
      totalDurationMs: Date.now() - startedAt,
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
