import type { TrackingPayload } from "./types.js";

type CompactTrackingTokenPayload = [string, string, string, string, string?];

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
  const compactPayload: CompactTrackingTokenPayload = [
    payload.user_id,
    payload.email_id,
    payload.recipient,
    payload.sent_at,
    payload.sender_email
  ];

  if (!compactPayload[4]) {
    compactPayload.length = 4;
  }

  return toBase64Url(JSON.stringify(compactPayload));
}

export function decodeTrackingToken(token: string): TrackingPayload {
  const decoded = fromBase64Url(token);
  const parsed = JSON.parse(decoded) as Partial<TrackingPayload> | CompactTrackingTokenPayload;

  if (Array.isArray(parsed)) {
    const [user_id, email_id, recipient, sent_at, sender_email] = parsed;
    if (!user_id || !email_id || !recipient || !sent_at) {
      throw new Error("Invalid tracking token payload");
    }

    return {
      user_id,
      email_id,
      recipient,
      sender_email,
      sent_at
    };
  }

  const payload = parsed as Partial<TrackingPayload>;
  if (!payload.user_id || !payload.email_id || !payload.recipient || !payload.sent_at) {
    throw new Error("Invalid tracking token payload");
  }

  return {
    user_id: payload.user_id,
    email_id: payload.email_id,
    recipient: payload.recipient,
    sender_email: payload.sender_email,
    sent_at: payload.sent_at
  };
}
