import type { TrackingPayload } from "./types.js";

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding ? normalized + "=".repeat(4 - padding) : normalized;
  return Buffer.from(padded, "base64").toString("utf8");
}

export function encodeTrackingToken(payload: TrackingPayload): string {
  return toBase64Url(JSON.stringify(payload));
}

export function decodeTrackingToken(token: string): TrackingPayload {
  const decoded = fromBase64Url(token);
  const payload = JSON.parse(decoded) as Partial<TrackingPayload>;

  if (!payload.user_id || !payload.email_id || !payload.recipient || !payload.sent_at) {
    throw new Error("Invalid tracking token payload");
  }

  return {
    user_id: payload.user_id,
    email_id: payload.email_id,
    recipient: payload.recipient,
    sent_at: payload.sent_at
  };
}
