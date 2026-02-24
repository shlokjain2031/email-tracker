import { Router } from "express";
import { decodeTrackingToken } from "@email-tracker/shared";
import { recordOpenEvent } from "../services/openRecorder.js";
import { recordSenderHeartbeat } from "../services/senderHeartbeat.js";

const TRANSPARENT_PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const LATENCY_SAMPLE_LIMIT = 1_000;
const SENDER_VIEWING_LIMIT = 5_000;
const GOOGLE_PROXY_UA_TOKEN = "googleimageproxy";
const GOOGLE_PROXY_IP_PREFIXES = ["66.249.", "64.233.", "74.125."];

// In-memory benchmark state used only for TTL calibration runs.
// Server-side timestamps are the source of truth to avoid client clock skew.
const senderViewingMap = new Map<string, number>();
const latencySamples: number[] = [];
const suppressSignalEvents: Array<{ endpoint: string; email_id: string; at_ms: number; ip: string; user_agent: string }> = [];
let suppressSignalCount = 0;

export const trackRouter = Router();

trackRouter.post("/sender-viewing", (req, res) => {
  const signal = recordSenderSignalTimestamp(req.body?.email_id, "/sender-viewing", req);
  if (!signal.ok) {
    res.status(400).json({ ok: false, error: "email_id is required" });
    return;
  }

  res.json({ ok: true, email_id: signal.emailId, recorded_at_ms: signal.recordedAtMs });
});

trackRouter.post("/mark-suppress-next", (req, res) => {
  const signal = recordSenderSignalTimestamp(req.body?.email_id, "/mark-suppress-next", req);
  if (!signal.ok) {
    res.status(400).json({ ok: false, error: "email_id is required" });
    return;
  }

  res.json({ ok: true, email_id: signal.emailId, recorded_at_ms: signal.recordedAtMs });
});

function recordSenderSignalTimestamp(
  rawEmailId: unknown,
  endpoint: string,
  req: { ip?: string; headers: Record<string, unknown>; socket?: { remoteAddress?: string }; get?: (headerName: string) => string | undefined } | null
):
  | { ok: true; emailId: string; recordedAtMs: number }
  | { ok: false } {
  const emailId = String(rawEmailId || "").trim();
  if (!emailId) {
    return { ok: false };
  }

  const nowMs = Date.now();
  senderViewingMap.set(emailId, nowMs);
  enforceSenderViewingMapLimit();

  suppressSignalCount += 1;
  suppressSignalEvents.push({
    endpoint,
    email_id: emailId,
    at_ms: nowMs,
    ip: normalizeIp(req ? getRequestIp(req) : null),
    user_agent: String(req?.get?.("user-agent") || "")
  });
  if (suppressSignalEvents.length > 50) {
    suppressSignalEvents.splice(0, suppressSignalEvents.length - 50);
  }

  // eslint-disable-next-line no-console
  console.info(
    JSON.stringify({
      event: "suppress_signal_received",
      endpoint,
      email_id: emailId,
      at_ms: nowMs,
      map_size: senderViewingMap.size
    })
  );

  return { ok: true, emailId, recordedAtMs: nowMs };
}

trackRouter.get("/t/:token.gif", (req, res) => {
  const openedAtIso = new Date().toISOString();
  const token = req.params.token;

  try {
    const payload = decodeTrackingToken(token);
    const ipAddress = getRequestIp(req);
    const userAgent = req.get("user-agent") || null;

    // We only benchmark Gmail proxy timing so browser/direct hits do not skew TTL selection.
    maybeRecordGmailProxyLatency(payload.email_id, userAgent, ipAddress);

    const result = recordOpenEvent({
      payload,
      ipAddress,
      userAgent,
      openedAtIso
    });

    // eslint-disable-next-line no-console
    console.info(
      `[pixel-hit] email_id=${payload.email_id} duplicate=${result.isDuplicate ? 1 : 0} sender_suppressed=${result.isSenderSuppressed ? 1 : 0} counted=${!result.isDuplicate && !result.isSenderSuppressed ? 1 : 0} unique_open_count=${result.openCount} ip=${ipAddress || "-"}`
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Tracking pixel processing failed:", error);
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Content-Length", TRANSPARENT_PIXEL_GIF.length.toString());

  res.status(200).send(TRANSPARENT_PIXEL_GIF);
});

trackRouter.get("/metrics/gmail-proxy-latency", (_req, res) => {
  const stats = buildLatencyStats(latencySamples);
  res.json(stats);
});

trackRouter.get("/metrics/suppress-signals", (_req, res) => {
  res.json({
    count: suppressSignalCount,
    active_email_ids: senderViewingMap.size,
    recent: suppressSignalEvents
  });
});

trackRouter.get("/h/:token.gif", (req, res) => {
  const seenAtIso = new Date().toISOString();
  const token = req.params.token;

  try {
    const payload = decodeTrackingToken(token);
    const ipAddress = getRequestIp(req);
    const userAgent = req.get("user-agent") || null;

    recordSenderHeartbeat({
      payload,
      ipAddress,
      userAgent,
      seenAtIso
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Sender heartbeat processing failed:", error);
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Content-Length", TRANSPARENT_PIXEL_GIF.length.toString());

  res.status(200).send(TRANSPARENT_PIXEL_GIF);
});

function getRequestIp(req: { ip?: string; headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): string | null {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    const first = forwardedFor.split(",")[0]?.trim();
    return first || null;
  }

  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    const first = String(forwardedFor[0] || "").split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  return req.ip ?? req.socket?.remoteAddress ?? null;
}

function maybeRecordGmailProxyLatency(emailId: string, userAgent: string | null, ipAddress: string | null): void {
  if (!isGoogleImageProxyHit(userAgent, ipAddress)) {
    return;
  }

  const senderSeenAtMs = senderViewingMap.get(emailId);
  if (typeof senderSeenAtMs !== "number") {
    return;
  }

  const deltaMs = Math.max(0, Date.now() - senderSeenAtMs);
  latencySamples.push(deltaMs);
  if (latencySamples.length > LATENCY_SAMPLE_LIMIT) {
    latencySamples.splice(0, latencySamples.length - LATENCY_SAMPLE_LIMIT);
  }

  // Structured JSON log for downstream parsing/export.
  // eslint-disable-next-line no-console
  console.info(
    JSON.stringify({
      event: "gmail_proxy_latency_sample",
      email_id: emailId,
      delta_ms: deltaMs,
      user_agent: userAgent || "",
      ip: normalizeIp(ipAddress)
    })
  );
}

function isGoogleImageProxyHit(userAgent: string | null, ipAddress: string | null): boolean {
  const ua = String(userAgent || "").toLowerCase();
  if (!ua.includes(GOOGLE_PROXY_UA_TOKEN)) {
    return false;
  }

  const ip = normalizeIp(ipAddress);
  return GOOGLE_PROXY_IP_PREFIXES.some((prefix) => ip.startsWith(prefix));
}

function normalizeIp(ipAddress: string | null): string {
  const raw = String(ipAddress || "").trim().toLowerCase();
  if (!raw) {
    return "";
  }

  const unwrapped = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  const ipv4Match = unwrapped.match(/\d{1,3}(?:\.\d{1,3}){3}/);
  return ipv4Match?.[0] || unwrapped;
}

function enforceSenderViewingMapLimit(): void {
  if (senderViewingMap.size <= SENDER_VIEWING_LIMIT) {
    return;
  }

  const overflow = senderViewingMap.size - SENDER_VIEWING_LIMIT;
  const keys = senderViewingMap.keys();
  for (let i = 0; i < overflow; i += 1) {
    const key = keys.next().value;
    if (typeof key === "string") {
      senderViewingMap.delete(key);
    }
  }
}

function buildLatencyStats(samples: number[]): {
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
} {
  const count = samples.length;
  if (count === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      avg: null,
      p50: null,
      p90: null,
      p95: null,
      p99: null
    };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);

  return {
    count,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    avg: Math.round((sum / count) * 100) / 100,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99)
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) {
    return null;
  }

  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index] ?? null;
}
