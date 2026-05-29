import { appLog } from "../utils/appLogger.server";

export type DeliveryType = "pickup" | "courier" | "unknown";

const PICKUP_POINT_CODE_PATTERN = /\b([A-Z0-9]{5,})\b/g;

export const isPickupDeliveryTitle = (
  shippingTitle: string | null | undefined,
): boolean => {
  if (!shippingTitle?.trim()) {
    return false;
  }

  const normalized = shippingTitle.toLowerCase();
  return normalized.includes("paczkomat") || normalized.includes("pickup");
};

export const isCourierDeliveryTitle = (
  shippingTitle: string | null | undefined,
): boolean => {
  if (!shippingTitle?.trim()) {
    return false;
  }

  const normalized = shippingTitle.toLowerCase();
  if (normalized.includes("paczkomat") || normalized.includes("pickup")) {
    return false;
  }

  return normalized.includes("kurier");
};

export const isCourierShippingCode = (
  shippingCode: string | null | undefined,
): boolean => {
  if (!shippingCode?.trim()) {
    return false;
  }

  return shippingCode.toLowerCase().includes("kurier");
};

export const getPointIdFromShippingCode = (
  shippingCode: string | null | undefined,
): string | null => {
  if (!shippingCode) {
    return null;
  }

  try {
    const parsed = JSON.parse(shippingCode) as { pointId?: string };
    if (parsed.pointId?.trim()) {
      return parsed.pointId.trim();
    }
  } catch {
    // non-JSON
  }

  return null;
};

export const getPointIdFromShippingTitle = (
  shippingTitle: string | null | undefined,
): string | null => {
  if (!shippingTitle?.trim()) {
    return null;
  }

  const normalized = shippingTitle.toUpperCase();
  const matches = normalized.match(PICKUP_POINT_CODE_PATTERN) ?? [];
  return matches.find((candidate) => /\d/.test(candidate)) ?? null;
};

export const resolveDeliveryType = ({
  shippingTitle,
  shippingCode,
  logContext,
}: {
  shippingTitle: string | null | undefined;
  shippingCode: string | null | undefined;
  logContext?: { runId?: string; source?: string };
}): DeliveryType => {
  const courierByTitle = isCourierDeliveryTitle(shippingTitle);
  const courierByCode = isCourierShippingCode(shippingCode);
  const pickupByTitle = isPickupDeliveryTitle(shippingTitle);
  const pointIdFromCode = getPointIdFromShippingCode(shippingCode);
  const pointIdFromTitle = getPointIdFromShippingTitle(shippingTitle);

  let result: DeliveryType = "unknown";
  let reason = "no-match";

  if (courierByTitle || courierByCode) {
    result = "courier";
    reason = courierByTitle ? "courier-title" : "courier-code";
  } else if (pickupByTitle) {
    result = "pickup";
    reason = "pickup-title";
  } else if (pointIdFromCode) {
    result = "pickup";
    reason = "pickup-code-pointId";
  }

  if (logContext) {
    appLog.debug("delivery:resolve-type", {
      ...logContext,
      shippingTitle: shippingTitle ?? null,
      shippingCodePreview: shippingCode?.slice(0, 200) ?? null,
      checks: {
        courierByTitle,
        courierByCode,
        pickupByTitle,
        pointIdFromCode,
        pointIdFromTitle,
      },
      result,
      reason,
    });
  }

  return result;
};

const PACZKOMAT_POINT_ID_PATTERN = /^[A-Z0-9]{5,}$/i;
const DISTANCE_ONLY_PATTERN = /^\d+([.,]\d+)?\s*km$/i;

export const isValidPaczkomatPointId = (value: string | null | undefined): boolean => {
  if (!value?.trim()) {
    return false;
  }

  const normalized = value.trim();
  if (DISTANCE_ONLY_PATTERN.test(normalized)) {
    return false;
  }

  return PACZKOMAT_POINT_ID_PATTERN.test(normalized) && /\d/.test(normalized);
};

export const isSellassistPaczkomatShipment = (
  shipmentLabel: string | null | undefined,
): boolean => {
  if (!shipmentLabel?.trim()) {
    return false;
  }

  const normalized = shipmentLabel.toLowerCase();
  return normalized.includes("paczkomat") || normalized === "subscription";
};

export const isSellassistCourierShipment = (
  shipmentLabel: string | null | undefined,
): boolean => {
  if (!shipmentLabel?.trim()) {
    return false;
  }

  return shipmentLabel.toLowerCase().includes("kurier");
};
