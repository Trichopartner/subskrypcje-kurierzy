const LOG_PREFIX = "[proteoglikany-dostawa]";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type AppLogContext = Record<string, unknown>;

const serialize = (data: AppLogContext | undefined): string => {
  if (!data || Object.keys(data).length === 0) {
    return "";
  }

  try {
    return JSON.stringify(data, (_key, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      return value;
    });
  } catch {
    return String(data);
  }
};

const write = (level: LogLevel, step: string, data?: AppLogContext): void => {
  const line = `${LOG_PREFIX} [${level.toUpperCase()}] ${step} ${serialize(data)}`.trim();

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "debug":
      console.debug(line);
      break;
    default:
      console.log(line);
  }
};

export const appLog = {
  debug: (step: string, data?: AppLogContext) => write("debug", step, data),
  info: (step: string, data?: AppLogContext) => write("info", step, data),
  warn: (step: string, data?: AppLogContext) => write("warn", step, data),
  error: (step: string, data?: AppLogContext) => write("error", step, data),
};

/** Bezpieczny podgląd payloadu webhooka zamówienia (bez tokenów / pełnych danych klienta). */
export const sanitizeOrderWebhookPayload = (payload: unknown): AppLogContext => {
  const order = payload as {
    id?: number;
    name?: string;
    order_number?: number;
    tags?: string;
    email?: string;
    created_at?: string;
    updated_at?: string;
    customer?: { id?: number; email?: string };
    shipping_lines?: Array<{
      title?: string;
      code?: string;
      source?: string;
      carrier_identifier?: string;
    }>;
    note_attributes?: Array<{ name?: string; value?: string }>;
    shipping_address?: {
      address1?: string;
      city?: string;
      zip?: string;
      country?: string;
    };
  };

  return {
    id: order.id ?? null,
    name: order.name ?? null,
    order_number: order.order_number ?? null,
    tags: order.tags ?? null,
    created_at: order.created_at ?? null,
    updated_at: order.updated_at ?? null,
    customer_id: order.customer?.id ?? null,
    customer_email: order.customer?.email ?? null,
    shipping_lines: (order.shipping_lines ?? []).map((line) => ({
      title: line.title ?? null,
      code: line.code ?? null,
      source: line.source ?? null,
      carrier_identifier: line.carrier_identifier ?? null,
    })),
    note_attributes: (order.note_attributes ?? []).map((attr) => ({
      name: attr.name ?? null,
      value: attr.value ?? null,
    })),
    shipping_address: order.shipping_address
      ? {
          address1: order.shipping_address.address1 ?? null,
          city: order.shipping_address.city ?? null,
          zip: order.shipping_address.zip ?? null,
          country: order.shipping_address.country ?? null,
        }
      : null,
  };
};

export const createWebhookRunId = (): string =>
  `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Skrócony podgląd zamówienia Sellassist (bez danych osobowych). */
export const sanitizeSellassistOrder = (order: unknown): AppLogContext => {
  const row =
    order && typeof order === "object" ? (order as Record<string, unknown>) : {};
  const shipment = row.shipment;
  const shipmentObj =
    shipment && typeof shipment === "object"
      ? (shipment as Record<string, unknown>)
      : null;
  const deliveryAddress = row.delivery_address;
  const deliveryObj =
    deliveryAddress && typeof deliveryAddress === "object"
      ? (deliveryAddress as Record<string, unknown>)
      : null;

  return {
    keys: Object.keys(row),
    id: row.id ?? null,
    external_id: row.external_id ?? null,
    shopify_order_id: row.shopify_order_id ?? null,
    source_order_id: row.source_order_id ?? null,
    shipment_id: row.shipment_id ?? null,
    shipment_name: row.shipment_name ?? null,
    delivery_method: row.delivery_method ?? null,
    shipment: shipmentObj
      ? { id: shipmentObj.id ?? null, name: shipmentObj.name ?? null }
      : null,
    delivery_address: deliveryObj
      ? {
          pickup_point: deliveryObj.pickup_point ?? null,
          point_name: deliveryObj.point_name ?? null,
          company: deliveryObj.company ?? null,
          city: deliveryObj.city ?? null,
        }
      : null,
    additional_fields_count: Array.isArray(row.additional_fields)
      ? row.additional_fields.length
      : 0,
  };
};

/** Nagłówki żądania HTTP (bez sekretów). */
export const sanitizeRequestHeaders = (request: Request): AppLogContext => {
  const headers: AppLogContext = {};
  const interesting = [
    "content-type",
    "accept",
    "user-agent",
    "x-shopify-topic",
    "x-shopify-shop-domain",
    "x-shopify-webhook-id",
    "x-sellassist-webhook-secret",
  ];

  for (const name of interesting) {
    const value = request.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }

  const hasSecretQuery = new URL(request.url).searchParams.has("secret");
  headers.hasSecretQueryParam = hasSecretQuery;

  return headers;
};
