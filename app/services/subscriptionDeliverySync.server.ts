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

const getPointIdFromShippingCode = (shippingCode: string | null | undefined): string | null => {
  if (!shippingCode) {
    return null;
  }

  try {
    const parsed = JSON.parse(shippingCode) as { pointId?: string };
    if (parsed.pointId?.trim()) {
      return parsed.pointId.trim();
    }
  } catch {
    // non-JSON shipping code
  }

  return null;
};

const getPointIdFromCustomAttributes = (
  customAttributes: Array<{ key: string; value?: string | null }> | undefined,
): string | null => {
  if (!customAttributes?.length) {
    return null;
  }

  const pointIdAttribute = customAttributes.find(
    (attribute) => attribute.key.trim().toLowerCase() === "pickuppointid",
  );

  if (!pointIdAttribute?.value?.trim()) {
    return null;
  }

  return pointIdAttribute.value.trim();
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

export const processSubscriptionDeliverySyncWebhook = async ({
  admin,
  payload,
  topic,
  shop,
}: ProcessWebhookInput): Promise<void> => {
  console.log(`Received ${topic} webhook for ${shop}`);

  if (!admin) {
    console.warn("Skipping order webhook because no admin client is available.");
    return;
  }

  const orderNumericId = (payload as { id?: number }).id;
  if (!orderNumericId) {
    console.warn("Order webhook payload has no numeric id", { payload });
    return;
  }

  const orderId = getOrderIdGid(orderNumericId);
  const rawTags = (payload as { tags?: string }).tags;
  const orderTags = parseOrderTags(rawTags);
  const isFirstSubscriptionOrder = orderTags.includes(APPSTLE_FIRST_ORDER_TAG);
  const isRecurringSubscriptionOrder = orderTags.includes(
    APPSTLE_RECURRING_ORDER_TAG,
  );

  console.log("Order webhook tags parsed", {
    topic,
    orderId,
    orderTags,
    isFirstSubscriptionOrder,
    isRecurringSubscriptionOrder,
  });

  if (!isRecurringSubscriptionOrder) {
    console.log("Skipping order - not Appstle recurring subscription order", {
      topic,
      orderId,
    });
    return;
  }

  console.log("Order webhook payload parsed", { topic, orderId, orderNumericId });

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

  if (currentOrderData.errors?.length) {
    console.error("Current order query failed:", {
      topic,
      errors: currentOrderData.errors,
    });
    return;
  }

  const currentOrder = currentOrderData.data?.order;
  if (!currentOrder) {
    console.warn("Current order not found via Admin API", { topic, orderId });
    return;
  }

  const customerNumericId = (payload as { customer?: { id?: number } }).customer?.id;
  if (!customerNumericId) {
    console.warn("Recurring order has no customer id in payload", {
      topic,
      orderId,
    });
    return;
  }

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
        query: `customer_id:${customerNumericId} tag:${APPSTLE_FIRST_ORDER_TAG}`,
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

  if (firstOrderByTagData.errors?.length) {
    console.error("Could not fetch first Appstle order by tag", {
      topic,
      orderId,
      customerNumericId,
      graphqlErrors: firstOrderByTagData.errors,
    });
    return;
  }

  const firstTaggedOrder = firstOrderByTagData.data?.orders?.nodes?.[0];
  if (!firstTaggedOrder) {
    console.warn("No first subscription order found by Appstle tag", {
      topic,
      orderId,
      customerNumericId,
      expectedTag: APPSTLE_FIRST_ORDER_TAG,
    });
    return;
  }

  const recurringCode = currentOrder.shippingLine?.code ?? null;
  const firstCode = firstTaggedOrder.shippingLine?.code ?? null;
  const recurringTitle = currentOrder.shippingLine?.title ?? null;
  const firstTitle = firstTaggedOrder.shippingLine?.title ?? null;

  const recurringPointId =
    getPointIdFromCustomAttributes(currentOrder.customAttributes) ??
    getPointIdFromShippingCode(recurringCode);
  const firstPointId =
    getPointIdFromCustomAttributes(firstTaggedOrder.customAttributes) ??
    getPointIdFromShippingCode(firstCode);

  const isPointIdMatch =
    Boolean(recurringPointId) &&
    Boolean(firstPointId) &&
    recurringPointId === firstPointId;
  const isExactSameTitle =
    Boolean(recurringTitle) && Boolean(firstTitle) && recurringTitle === firstTitle;
  const isExactSameCode =
    Boolean(recurringCode) && Boolean(firstCode) && recurringCode === firstCode;

  const isDeliveryMatching = isPointIdMatch || isExactSameCode || isExactSameTitle;

  if (isDeliveryMatching) {
    console.log("Recurring order delivery matches first subscription order", {
      topic,
      orderId,
      recurringOrderName: currentOrder.name,
      recurringShipping: currentOrder.shippingLine,
      firstOrderId: firstTaggedOrder.id,
      firstOrderName: firstTaggedOrder.name,
      firstOrderShipping: firstTaggedOrder.shippingLine,
      recurringPointId,
      firstPointId,
    });
    return;
  }

  console.warn("Recurring order delivery mismatch vs first subscription order", {
    topic,
    orderId,
    recurringOrderName: currentOrder.name,
    recurringShipping: currentOrder.shippingLine,
    firstOrderId: firstTaggedOrder.id,
    firstOrderName: firstTaggedOrder.name,
    firstOrderShipping: firstTaggedOrder.shippingLine,
    recurringPointId,
    firstPointId,
    actionRequired:
      "Mismatch detected. Without Appstle write API, automatic correction is not possible from this app.",
  });

  const currentAttributes = normalizeCustomAttributes(currentOrder.customAttributes);
  const preferredAttributes = normalizeCustomAttributes(firstTaggedOrder.customAttributes);
  const mergedAttributes = mergePickupPointAttributes(
    currentAttributes,
    preferredAttributes,
  );

  const hasAttributeChanges = !areAttributesEquivalent(
    currentAttributes,
    mergedAttributes,
  );

  if (!hasAttributeChanges) {
    console.warn("PickupPoint attributes already match preferred values", {
      topic,
      orderId,
      currentAttributesCount: currentAttributes.length,
      preferredAttributesCount: preferredAttributes.length,
      recurringPointId,
      firstPointId,
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

  let updateOrderResponse: Response;
  try {
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
  } catch (error) {
    console.error("Failed to call orderUpdate mutation", {
      topic,
      orderId,
      error,
      hint: "App needs write_orders scope and reauthorization after scope change.",
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
    console.error("Failed to update recurring order additional details/note", {
      topic,
      orderId,
      graphqlErrors: updateOrderData.errors,
      userErrors: updateOrderErrors,
      mergedAttributes,
    });
    return;
  }

  console.log("Recurring order additional details and note updated", {
    topic,
    orderId,
    updatedAttributeKeys: mergedAttributes.map((attribute) => attribute.key),
    noteUpdated: true,
  });
};
