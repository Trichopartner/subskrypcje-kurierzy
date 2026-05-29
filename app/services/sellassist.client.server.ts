import { appLog } from "../utils/appLogger.server";

type SellassistJson = Record<string, unknown>;

const getSellassistConfig = (): { baseUrl: string; apiKey: string } => {
  const account = process.env.SELLASSIST_ACCOUNT?.trim();
  const apiKey = process.env.SELLASSIST_API_KEY?.trim();
  const baseUrlFromEnv = process.env.SELLASSIST_API_BASE_URL?.trim();

  if (!apiKey) {
    throw new Error("SELLASSIST_API_KEY is not configured");
  }

  if (baseUrlFromEnv) {
    return { baseUrl: baseUrlFromEnv.replace(/\/$/, ""), apiKey };
  }

  if (!account) {
    throw new Error("SELLASSIST_ACCOUNT or SELLASSIST_API_BASE_URL is not configured");
  }

  return {
    baseUrl: `https://${account}.sellasist.pl/api/v1`,
    apiKey,
  };
};

const previewBody = (body: unknown, maxLen = 500): unknown => {
  if (body == null) {
    return null;
  }
  if (typeof body === "string") {
    return body.length > maxLen ? `${body.slice(0, maxLen)}…` : body;
  }
  try {
    const json = JSON.stringify(body);
    return json.length > maxLen ? `${json.slice(0, maxLen)}…` : body;
  } catch {
    return String(body).slice(0, maxLen);
  }
};

const sellassistRequest = async <T>(
  path: string,
  init?: RequestInit,
): Promise<T> => {
  const { baseUrl, apiKey } = getSellassistConfig();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const method = (init?.method ?? "GET").toUpperCase();
  const startedAt = Date.now();

  appLog.info("sellassist:api-request", {
    method,
    path,
    urlHost: new URL(url).host,
    hasBody: Boolean(init?.body),
    bodyPreview:
      typeof init?.body === "string" ? previewBody(init.body, 300) : null,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        apikey: apiKey,
        "X-Api-Key": apiKey,
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    appLog.error("sellassist:api-network-error", {
      path,
      method,
      durationMs: Date.now() - startedAt,
      error:
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : error,
    });
    throw error;
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    appLog.error("sellassist:api-error", {
      path,
      method,
      status: response.status,
      durationMs,
      responsePreview: previewBody(body),
      responseLength: text.length,
    });
    throw new Error(`Sellassist API ${response.status} for ${path}`);
  }

  appLog.info("sellassist:api-success", {
    path,
    method,
    status: response.status,
    durationMs,
    responsePreview: previewBody(body),
    responseLength: text.length,
  });

  return body as T;
};

export const getSellassistOrder = async (
  orderId: string,
): Promise<SellassistJson> => {
  return sellassistRequest<SellassistJson>(`/orders/${encodeURIComponent(orderId)}`);
};

export type SellassistShipment = {
  id: string;
  name: string;
};

export const listSellassistShipments = async (): Promise<SellassistShipment[]> => {
  const data = await sellassistRequest<unknown>("/shipments");
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as SellassistJson).shipments)
      ? ((data as SellassistJson).shipments as unknown[])
      : [];

  return rows
    .map((row) => {
      const item = row as SellassistJson;
      const id = String(item.id ?? item.shipment_id ?? "").trim();
      const name = String(
        item.name ?? item.title ?? item.translation ?? item.label ?? "",
      ).trim();
      if (!id || !name) {
        return null;
      }
      return { id, name };
    })
    .filter((item): item is SellassistShipment => item !== null);
};

export const updateSellassistOrder = async (
  orderId: string,
  body: SellassistJson,
): Promise<SellassistJson> => {
  return sellassistRequest<SellassistJson>(`/orders/${encodeURIComponent(orderId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
};
