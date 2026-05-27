import {
  appLog,
  createWebhookRunId,
  sanitizeOrderWebhookPayload,
  type AppLogContext,
} from "../utils/appLogger.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
};

type ProcessWebhookInput = {
  admin: AdminGraphqlClient | undefined;
  payload: unknown;
  topic: string;
  shop: string;
  runId?: string;
};

const APPSTLE_FIRST_ORDER_TAG = "appstle_subscription_first_order";
const APPSTLE_RECURRING_ORDER_TAG = "appstle_subscription_recurring_order";

const getOrderIdGid = (orderId: string | number): string =>
  `gid://shopify/Order/${orderId}`;

const parseOrderTags = (rawTags: string | undefined): string[] =>
  (rawTags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

const PICKUP_POINT_ATTRIBUTE_KEY_PATTERN = /^pickuppoint/i;
const PICKUP_POINT_CODE_PATTERN = /\b([A-Z0-9]{5,})\b/g;

const getPointIdFromShippingCode = (
  shippingCode: string | null | undefined,
  logContext?: { source: string },
): string | null => {
  if (!shippingCode) {
    appLog.debug("getPointIdFromShippingCode: brak kodu wysyłki", logContext);
    return null;
  }

  try {
    const parsed = JSON.parse(shippingCode) as { pointId?: string };
    if (parsed.pointId?.trim()) {
      appLog.debug("getPointIdFromShippingCode: pointId z JSON", {
        ...logContext,
        pointId: parsed.pointId.trim(),
        shippingCodePreview: shippingCode.slice(0, 200),
      });
      return parsed.pointId.trim();
    }
    appLog.debug("getPointIdFromShippingCode: JSON bez pointId", {
      ...logContext,
      shippingCodePreview: shippingCode.slice(0, 200),
    });
  } catch {
    appLog.debug("getPointIdFromShippingCode: kod nie jest JSON", {
      ...logContext,
      shippingCodePreview: shippingCode.slice(0, 200),
    });
  }

  return null;
};

const getPointIdFromShippingTitle = (
  shippingTitle: string | null | undefined,
  logContext?: { source: string },
): string | null => {
  if (!shippingTitle?.trim()) {
    appLog.debug("getPointIdFromShippingTitle: brak tytułu wysyłki", logContext);
    return null;
  }

  const normalized = shippingTitle.toUpperCase();
  const matches = normalized.match(PICKUP_POINT_CODE_PATTERN) ?? [];
  const selected = matches.find((candidate) => /\d/.test(candidate));

  if (!selected) {
    appLog.debug("getPointIdFromShippingTitle: brak kandydata pointId w title", {
      ...logContext,
      shippingTitle,
      candidates: matches,
    });
    return null;
  }

  appLog.debug("getPointIdFromShippingTitle: pointId z title", {
    ...logContext,
    shippingTitle,
    pointId: selected,
  });
  return selected;
};

const getPointIdFromCustomAttributes = (
  customAttributes: Array<{ key: string; value?: string | null }> | undefined,
  logContext?: { source: string },
): string | null => {
  if (!customAttributes?.length) {
    appLog.debug("getPointIdFromCustomAttributes: brak atrybutów", logContext);
    return null;
  }

  const pointIdAttribute = customAttributes.find(
    (attribute) => attribute.key.trim().toLowerCase() === "pickuppointid",
  );

  if (!pointIdAttribute?.value?.trim()) {
    appLog.debug("getPointIdFromCustomAttributes: brak pickuppointid", {
      ...logContext,
      attributeKeys: customAttributes.map((a) => a.key),
    });
    return null;
  }

  appLog.debug("getPointIdFromCustomAttributes: znaleziono pickuppointid", {
    ...logContext,
    pointId: pointIdAttribute.value.trim(),
  });

  return pointIdAttribute.value.trim();
};

const isPickupDeliveryTitle = (shippingTitle: string | null | undefined): boolean => {
  if (!shippingTitle?.trim()) {
    return false;
  }

  const normalized = shippingTitle.toLowerCase();
  return normalized.includes("paczkomat") || normalized.includes("pickup");
};

const isPickupDelivery = ({
  shippingTitle,
  shippingCode,
  pointIdFromAttributes,
  pointIdFromCode,
}: {
  shippingTitle: string | null | undefined;
  shippingCode: string | null | undefined;
  pointIdFromAttributes: string | null;
  pointIdFromCode: string | null;
}): boolean => {
  if (pointIdFromAttributes || pointIdFromCode) {
    return true;
  }

  if (isPickupDeliveryTitle(shippingTitle)) {
    return true;
  }

  // Wiele integracji kurierskich nie ma pointId i nie powinno dostać PickupPoint*.
  if (!shippingCode && !shippingTitle) {
    return false;
  }

  return false;
};

const normalizeCustomAttributes = (
  customAttributes: Array<{ key: string; value?: string | null }> | undefined,
): Array<{ key: string; value: string }> =>
  (customAttributes ?? [])
    .filter((attribute) => attribute.key.trim() && attribute.value != null)
    .map((attribute) => ({
      key: attribute.key.trim(),
      value: (attribute.value ?? "").trim(),
    }))
    .filter((attribute) => attribute.value.length > 0);

const upsertAttribute = (
  attributes: Array<{ key: string; value: string }>,
  key: string,
  value: string,
): Array<{ key: string; value: string }> => {
  const next = [...attributes];
  const existingIndex = next.findIndex(
    (attribute) => attribute.key.toLowerCase() === key.toLowerCase(),
  );

  if (existingIndex >= 0) {
    next[existingIndex] = { key: next[existingIndex].key, value };
    return next;
  }

  next.push({ key, value });
  return next;
};

const enrichPickupPointAttributes = (
  attributes: Array<{ key: string; value: string }>,
  fallback: {
    pointId: string | null;
    courier: string | null;
  },
): Array<{ key: string; value: string }> => {
  if (!fallback.pointId) {
    return attributes;
  }

  let next = upsertAttribute(attributes, "PickupPointId", fallback.pointId);
  next = upsertAttribute(next, "PickupPointName", fallback.pointId);

  if (fallback.courier) {
    next = upsertAttribute(next, "PickupPointCourier", fallback.courier);
  }

  return next;
};

const mergePickupPointAttributes = (
  currentAttributes: Array<{ key: string; value: string }>,
  preferredAttributes: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> => {
  const preferredPickupPointAttributes = preferredAttributes.filter((attribute) =>
    PICKUP_POINT_ATTRIBUTE_KEY_PATTERN.test(attribute.key),
  );

  if (preferredPickupPointAttributes.length === 0) {
    return currentAttributes;
  }

  const preferredKeys = new Set(
    preferredPickupPointAttributes.map((attribute) => attribute.key.toLowerCase()),
  );

  const nonPickupCurrentAttributes = currentAttributes.filter(
    (attribute) => !preferredKeys.has(attribute.key.toLowerCase()),
  );

  return [...nonPickupCurrentAttributes, ...preferredPickupPointAttributes];
};

const toAttributesMap = (
  attributes: Array<{ key: string; value: string }>,
): Map<string, string> => {
  const map = new Map<string, string>();
  for (const attribute of attributes) {
    map.set(attribute.key.toLowerCase(), attribute.value);
  }
  return map;
};

const areAttributesEquivalent = (
  left: Array<{ key: string; value: string }>,
  right: Array<{ key: string; value: string }>,
): boolean => {
  const leftMap = toAttributesMap(left);
  const rightMap = toAttributesMap(right);

  if (leftMap.size !== rightMap.size) {
    return false;
  }

  for (const [key, value] of leftMap) {
    if (rightMap.get(key) !== value) {
      return false;
    }
  }

  return true;
};

const diffAttributes = (
  before: Array<{ key: string; value: string }>,
  after: Array<{ key: string; value: string }>,
): AppLogContext => {
  const beforeMap = toAttributesMap(before);
  const afterMap = toAttributesMap(after);
  const changed: Array<{ key: string; from: string | null; to: string | null }> = [];

  const allKeys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  for (const key of allKeys) {
    const from = beforeMap.get(key) ?? null;
    const to = afterMap.get(key) ?? null;
    if (from !== to) {
      changed.push({ key, from, to });
    }
  }

  return { changedCount: changed.length, changed };
};

export const processSubscriptionDeliverySyncWebhook = async ({
  admin,
  payload,
  topic,
  shop,
  runId: externalRunId,
}: ProcessWebhookInput): Promise<void> => {
  const runId = externalRunId ?? createWebhookRunId();
  const baseContext = { runId, topic, shop };

  appLog.info("sync:start", {
    ...baseContext,
    hasAdmin: Boolean(admin),
    payloadSummary: sanitizeOrderWebhookPayload(payload),
  });

  if (!admin) {
    appLog.warn("sync:skip — brak klienta Admin API (np. webhook z CLI)", {
      ...baseContext,
      reason: "NO_ADMIN_CLIENT",
      hint: "Webhook musi pochodzić ze sklepu z zainstalowaną aplikacją.",
    });
    return;
  }

  const orderNumericId = (payload as { id?: number }).id;
  if (!orderNumericId) {
    appLog.warn("sync:skip — brak id w payloadzie", {
      ...baseContext,
      reason: "NO_ORDER_ID",
      payloadSummary: sanitizeOrderWebhookPayload(payload),
    });
    return;
  }

  const orderId = getOrderIdGid(orderNumericId);
  const rawTags = (payload as { tags?: string }).tags;
  const orderTags = parseOrderTags(rawTags);
  const isFirstSubscriptionOrder = orderTags.includes(APPSTLE_FIRST_ORDER_TAG);
  const isRecurringSubscriptionOrder = orderTags.includes(
    APPSTLE_RECURRING_ORDER_TAG,
  );

  appLog.info("sync:tags", {
    ...baseContext,
    orderId,
    orderNumericId,
    rawTags: rawTags ?? null,
    orderTags,
    isFirstSubscriptionOrder,
    isRecurringSubscriptionOrder,
    expectedRecurringTag: APPSTLE_RECURRING_ORDER_TAG,
    expectedFirstTag: APPSTLE_FIRST_ORDER_TAG,
  });

  if (!isRecurringSubscriptionOrder) {
    const hint = isFirstSubscriptionOrder
      ? "Pierwsze zamówienie subskrypcji — aplikacja celowo nic nie zmienia (punkt odniesienia dla kolejnych odnowień)."
      : "Tag appstle_subscription_recurring_order może pojawić się dopiero przy orders/updated.";

    appLog.info("sync:skip — to nie jest zamówienie cykliczne Appstle", {
      ...baseContext,
      reason: isFirstSubscriptionOrder
        ? "FIRST_SUBSCRIPTION_ORDER_ONLY"
        : "NOT_RECURRING_ORDER",
      orderId,
      orderTags,
      isFirstSubscriptionOrder,
      hint,
    });
    return;
  }

  appLog.info("sync:recurring-order-detected", {
    ...baseContext,
    orderId,
    orderNumericId,
  });

  const currentOrderQueryStartedAt = Date.now();
  const currentOrderResponse = await admin.graphql(
    `#graphql
      query CurrentOrderShipping($orderId: ID!) {
        order(id: $orderId) {
          id
          name
          shippingLine {
            code
            title
          }
          customAttributes {
            key
            value
          }
        }
      }`,
    { variables: { orderId } },
  );

  const currentOrderData = (await currentOrderResponse.json()) as {
    data?: {
      order?: {
        id: string;
        name?: string | null;
        shippingLine?: {
          code?: string | null;
          title?: string | null;
        } | null;
        customAttributes?: Array<{ key: string; value?: string | null }>;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  appLog.info("sync:graphql-current-order", {
    ...baseContext,
    orderId,
    durationMs: Date.now() - currentOrderQueryStartedAt,
    httpStatus: currentOrderResponse.status,
    hasOrder: Boolean(currentOrderData.data?.order),
    graphqlErrors: currentOrderData.errors ?? [],
    orderName: currentOrderData.data?.order?.name ?? null,
    shippingLine: currentOrderData.data?.order?.shippingLine ?? null,
    customAttributes: currentOrderData.data?.order?.customAttributes ?? [],
  });

  if (currentOrderData.errors?.length) {
    appLog.error("sync:abort — błąd zapytania o bieżące zamówienie", {
      ...baseContext,
      reason: "CURRENT_ORDER_QUERY_FAILED",
      orderId,
      graphqlErrors: currentOrderData.errors,
    });
    return;
  }

  const currentOrder = currentOrderData.data?.order;
  if (!currentOrder) {
    appLog.warn("sync:abort — zamówienie nie znalezione w Admin API", {
      ...baseContext,
      reason: "CURRENT_ORDER_NOT_FOUND",
      orderId,
    });
    return;
  }

  const customerNumericId = (payload as { customer?: { id?: number } }).customer?.id;
  if (!customerNumericId) {
    appLog.warn("sync:abort — brak customer.id w payloadzie webhooka", {
      ...baseContext,
      reason: "NO_CUSTOMER_ID_IN_PAYLOAD",
      orderId,
      payloadSummary: sanitizeOrderWebhookPayload(payload),
      hint: "Shopify czasem nie wysyła customer w orders/create — sprawdź orders/updated.",
    });
    return;
  }

  const firstOrderSearchQuery = `customer_id:${customerNumericId} tag:${APPSTLE_FIRST_ORDER_TAG}`;
  appLog.info("sync:search-first-order", {
    ...baseContext,
    orderId,
    customerNumericId,
    searchQuery: firstOrderSearchQuery,
  });

  const firstOrderQueryStartedAt = Date.now();
  const firstOrderByTagResponse = await admin.graphql(
    `#graphql
      query FindFirstSubscriptionOrderByTag($query: String!) {
        orders(first: 1, sortKey: CREATED_AT, reverse: false, query: $query) {
          nodes {
            id
            name
            tags
            shippingLine {
              code
              title
            }
            customAttributes {
              key
              value
            }
          }
        }
      }`,
    {
      variables: {
        query: firstOrderSearchQuery,
      },
    },
  );

  const firstOrderByTagData = (await firstOrderByTagResponse.json()) as {
    data?: {
      orders?: {
        nodes?: Array<{
          id: string;
          name?: string | null;
          tags?: string[];
          shippingLine?: { code?: string | null; title?: string | null } | null;
          customAttributes?: Array<{ key: string; value?: string | null }>;
        }>;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  appLog.info("sync:graphql-first-order", {
    ...baseContext,
    orderId,
    durationMs: Date.now() - firstOrderQueryStartedAt,
    httpStatus: firstOrderByTagResponse.status,
    nodesCount: firstOrderByTagData.data?.orders?.nodes?.length ?? 0,
    graphqlErrors: firstOrderByTagData.errors ?? [],
    firstOrder: firstOrderByTagData.data?.orders?.nodes?.[0] ?? null,
  });

  if (firstOrderByTagData.errors?.length) {
    appLog.error("sync:abort — błąd wyszukiwania pierwszego zamówienia", {
      ...baseContext,
      reason: "FIRST_ORDER_QUERY_FAILED",
      orderId,
      customerNumericId,
      searchQuery: firstOrderSearchQuery,
      graphqlErrors: firstOrderByTagData.errors,
    });
    return;
  }

  const firstTaggedOrder = firstOrderByTagData.data?.orders?.nodes?.[0];
  if (!firstTaggedOrder) {
    appLog.warn("sync:abort — brak pierwszego zamówienia z tagiem Appstle", {
      ...baseContext,
      reason: "FIRST_ORDER_NOT_FOUND",
      orderId,
      customerNumericId,
      searchQuery: firstOrderSearchQuery,
      expectedTag: APPSTLE_FIRST_ORDER_TAG,
    });
    return;
  }

  const recurringCode = currentOrder.shippingLine?.code ?? null;
  const firstCode = firstTaggedOrder.shippingLine?.code ?? null;
  const recurringTitle = currentOrder.shippingLine?.title ?? null;
  const firstTitle = firstTaggedOrder.shippingLine?.title ?? null;

  const recurringPointFromAttrs = getPointIdFromCustomAttributes(
    currentOrder.customAttributes,
    { source: "recurring-customAttributes" },
  );
  const recurringPointFromCode = getPointIdFromShippingCode(recurringCode, {
    source: "recurring-shippingCode",
  });
  const recurringPointFromTitle = getPointIdFromShippingTitle(recurringTitle, {
    source: "recurring-shippingTitle",
  });
  const firstPointFromAttrs = getPointIdFromCustomAttributes(
    firstTaggedOrder.customAttributes,
    { source: "first-customAttributes" },
  );
  const firstPointFromCode = getPointIdFromShippingCode(firstCode, {
    source: "first-shippingCode",
  });
  const firstPointFromTitle = getPointIdFromShippingTitle(firstTitle, {
    source: "first-shippingTitle",
  });

  const recurringIsPickupDelivery = isPickupDelivery({
    shippingTitle: recurringTitle,
    shippingCode: recurringCode,
    pointIdFromAttributes: recurringPointFromAttrs,
    pointIdFromCode: recurringPointFromCode,
  });

  if (!recurringIsPickupDelivery) {
    appLog.info("sync:skip — bieżące zamówienie nie jest paczkomatem", {
      ...baseContext,
      reason: "NON_PICKUP_DELIVERY_SKIPPED",
      orderId,
      recurringShippingLine: currentOrder.shippingLine,
      hint: "Dla metod kurierskich (np. Kurier InPost) nie dopisujemy PickupPoint*.",
    });
    return;
  }

  const recurringPointId =
    recurringPointFromAttrs ?? recurringPointFromCode ?? recurringPointFromTitle;
  const firstPointId = firstPointFromAttrs ?? firstPointFromCode ?? firstPointFromTitle;

  const isPointIdMatch =
    Boolean(recurringPointId) &&
    Boolean(firstPointId) &&
    recurringPointId === firstPointId;
  const isExactSameTitle =
    Boolean(recurringTitle) && Boolean(firstTitle) && recurringTitle === firstTitle;
  const isExactSameCode =
    Boolean(recurringCode) && Boolean(firstCode) && recurringCode === firstCode;

  const isDeliveryMatching = isPointIdMatch || isExactSameCode || isExactSameTitle;
  const currentAttributes = enrichPickupPointAttributes(
    normalizeCustomAttributes(currentOrder.customAttributes),
    {
      pointId: recurringPointId,
      courier: isPickupDeliveryTitle(currentOrder.shippingLine?.title)
        ? "InPost Paczkomaty"
        : null,
    },
  );
  const preferredAttributes = enrichPickupPointAttributes(
    normalizeCustomAttributes(firstTaggedOrder.customAttributes),
    {
      pointId: firstPointId ?? recurringPointId,
      courier: isPickupDeliveryTitle(firstTaggedOrder.shippingLine?.title)
        ? "InPost Paczkomaty"
        : null,
    },
  );
  const mergedAttributes = mergePickupPointAttributes(
    currentAttributes,
    preferredAttributes,
  );
  const hasAttributeChanges = !areAttributesEquivalent(
    currentAttributes,
    mergedAttributes,
  );

  appLog.info("sync:delivery-comparison", {
    ...baseContext,
    orderId,
    recurringOrderName: currentOrder.name,
    firstOrderId: firstTaggedOrder.id,
    firstOrderName: firstTaggedOrder.name,
    recurring: {
      shippingLine: currentOrder.shippingLine,
      pointId: recurringPointId,
      pointFromAttrs: recurringPointFromAttrs,
      pointFromCode: recurringPointFromCode,
      pointFromTitle: recurringPointFromTitle,
      customAttributes: currentOrder.customAttributes,
    },
    first: {
      shippingLine: firstTaggedOrder.shippingLine,
      tags: firstTaggedOrder.tags,
      pointId: firstPointId,
      pointFromAttrs: firstPointFromAttrs,
      pointFromCode: firstPointFromCode,
      pointFromTitle: firstPointFromTitle,
      customAttributes: firstTaggedOrder.customAttributes,
    },
    matchChecks: {
      isPointIdMatch,
      isExactSameTitle,
      isExactSameCode,
      isDeliveryMatching,
    },
    note: isDeliveryMatching
      ? "Uznano zgodność — NIE będzie orderUpdate (nawet jeśli tytuł/kod wygląda inaczej dla człowieka)."
      : "Wykryto rozjazd — przejdę do synchronizacji atrybutów.",
  });

  if (isDeliveryMatching && !hasAttributeChanges) {
    appLog.info("sync:done — dostawa zgodna i atrybuty kompletne, bez zmian", {
      ...baseContext,
      reason: "DELIVERY_AND_ATTRIBUTES_ALREADY_MATCHING",
      orderId,
    });
    return;
  }

  if (isDeliveryMatching && hasAttributeChanges) {
    appLog.info(
      "sync:delivery-ok-but-attributes-missing — wymuszam uzupełnienie danych PickupPoint*",
      {
        ...baseContext,
        reason: "DELIVERY_MATCHING_BUT_ATTRIBUTES_NEED_SYNC",
        orderId,
        attributeDiff: diffAttributes(currentAttributes, mergedAttributes),
      },
    );
  }

  appLog.warn("sync:mismatch — rozjazd dostawy vs pierwsze zamówienie", {
    ...baseContext,
    reason: "DELIVERY_MISMATCH",
    orderId,
    recurringPointId,
    firstPointId,
    limitation:
      "Aplikacja nie zmienia shippingLine w zamówieniu — tylko customAttributes + notatkę.",
  });

  appLog.info("sync:attributes-merge", {
    ...baseContext,
    orderId,
    currentAttributes,
    preferredAttributes,
    mergedAttributes,
    attributeDiff: diffAttributes(currentAttributes, mergedAttributes),
    hasAttributeChanges,
    pickupPointKeysInPreferred: preferredAttributes
      .filter((a) => PICKUP_POINT_ATTRIBUTE_KEY_PATTERN.test(a.key))
      .map((a) => a.key),
  });

  if (!hasAttributeChanges) {
    appLog.warn("sync:abort — atrybuty już takie same, brak orderUpdate", {
      ...baseContext,
      reason: "ATTRIBUTES_ALREADY_EQUIVALENT",
      orderId,
      recurringPointId,
      firstPointId,
      hint:
        "Shipping line może być inna, ale atrybuty pickuppoint są identyczne — paczkomat w UI może nadal wyglądać źle.",
    });
    return;
  }

  const updateNote = [
    currentOrder.name
      ? `AUTO_SYNC: recurring order ${currentOrder.name} had mismatched pickup point.`
      : "AUTO_SYNC: recurring order had mismatched pickup point.",
    firstTaggedOrder.name
      ? `Preferred source order: ${firstTaggedOrder.name}.`
      : "Preferred source order resolved by appstle_subscription_first_order tag.",
    recurringPointId ? `Recurring point: ${recurringPointId}.` : null,
    firstPointId ? `Preferred point: ${firstPointId}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  appLog.info("sync:orderUpdate — wysyłam mutację", {
    ...baseContext,
    orderId,
    updateNote,
    mergedAttributes,
    mutationInput: {
      id: orderId,
      note: updateNote,
      customAttributes: mergedAttributes,
    },
  });

  let updateOrderResponse: Response;
  try {
    const mutationStartedAt = Date.now();
    updateOrderResponse = await admin.graphql(
      `#graphql
        mutation UpdateOrderPickupPoint($input: OrderInput!) {
          orderUpdate(input: $input) {
            order {
              id
              note
              customAttributes {
                key
                value
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          input: {
            id: orderId,
            note: updateNote,
            customAttributes: mergedAttributes,
          },
        },
      },
    );
    appLog.info("sync:orderUpdate — odpowiedź HTTP", {
      ...baseContext,
      orderId,
      durationMs: Date.now() - mutationStartedAt,
      httpStatus: updateOrderResponse.status,
    });
  } catch (error) {
    appLog.error("sync:abort — wyjątek przy orderUpdate", {
      ...baseContext,
      reason: "ORDER_UPDATE_EXCEPTION",
      orderId,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      hint: "Wymagany scope write_orders i ponowna autoryzacja aplikacji w sklepie.",
    });
    return;
  }

  const updateOrderData = (await updateOrderResponse.json()) as {
    data?: {
      orderUpdate?: {
        order?: {
          id: string;
          note?: string | null;
          customAttributes?: Array<{ key: string; value?: string | null }>;
        } | null;
        userErrors?: Array<{ field?: string[]; message: string }>;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  const updateOrderErrors = updateOrderData.data?.orderUpdate?.userErrors ?? [];
  if (updateOrderData.errors?.length || updateOrderErrors.length) {
    appLog.error("sync:abort — orderUpdate zwrócił błędy", {
      ...baseContext,
      reason: "ORDER_UPDATE_FAILED",
      orderId,
      graphqlErrors: updateOrderData.errors ?? [],
      userErrors: updateOrderErrors,
      mergedAttributes,
    });
    return;
  }

  appLog.info("sync:done — zamówienie zaktualizowane", {
    ...baseContext,
    reason: "ORDER_UPDATED",
    orderId,
    updatedOrder: updateOrderData.data?.orderUpdate?.order ?? null,
    updatedAttributeKeys: mergedAttributes.map((attribute) => attribute.key),
    noteUpdated: true,
  });
};
