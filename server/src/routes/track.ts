import { Router } from "express";
import { decodeTrackingToken } from "@email-tracker/shared";
import { recordOpenEvent } from "../services/openRecorder.js";

const TRANSPARENT_PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const SUPPRESSION_TTL_MS = 10_000;
const LATENCY_SAMPLE_LIMIT = 1_000;
const SUPPRESSION_EVENT_LIMIT = 5_000;
const SUPPRESSION_MAP_LIMIT = 10_000;
const GOOGLE_PROXY_UA_TOKEN = "googleimageproxy";
const GOOGLE_PROXY_IP_PREFIXES = ["66.249.", "64.233.", "74.125."];

interface SuppressionEntry {
  createdAtMs: number;
}

interface SuppressionDebugEvent {
  event: "mark_suppress_next" | "google_proxy_hit" | "suppression_consumed" | "suppression_expired";
  email_id: string;
  at_ms: number;
  ip: string;
  user_agent: string;
  delta_ms?: number;
  pending_suppression?: boolean;
}

// Event-based, email-scoped suppression store with consume-once semantics.
// TTL exists only as stale-entry cleanup fallback, not suppression logic.
const suppressionMap = new Map<string, SuppressionEntry>();
const latencySamples: number[] = [];
const suppressionDebugEvents: SuppressionDebugEvent[] = [];
let suppressSignalCount = 0;

export const trackRouter = Router();

trackRouter.post("/mark-suppress-next", (req, res) => {
  const nowMs = Date.now();
  cleanupExpiredSuppressions(nowMs);

  const signal = markSuppressNext(req.body?.email_id, req, nowMs);
  if (!signal.ok) {
    res.status(400).json({ ok: false, error: "email_id is required" });
    return;
  }

  res.json({ ok: true, email_id: signal.emailId, recorded_at_ms: signal.recordedAtMs });
});

function markSuppressNext(
  rawEmailId: unknown,
  req: {
    ip?: string;
    headers: Record<string, unknown>;
    socket?: { remoteAddress?: string };
    get?: (headerName: string) => string | undefined;
    path?: string;
  },
  nowMs: number
):
  | { ok: true; emailId: string; recordedAtMs: number }
  | { ok: false } {
  const emailId = String(rawEmailId || "").trim();
  if (!emailId) {
    return { ok: false };
  }

  suppressionMap.set(emailId, { createdAtMs: nowMs });
  enforceSuppressionMapLimit();

  suppressSignalCount += 1;
  pushSuppressionDebugEvent({
    event: "mark_suppress_next",
    email_id: emailId,
    at_ms: nowMs,
    ip: normalizeIp(getRequestIp(req)),
    user_agent: String(req.get?.("user-agent") || "")
  });

  // eslint-disable-next-line no-console
  console.info(
    JSON.stringify({
      event: "suppress_signal_received",
      endpoint: req.path,
      email_id: emailId,
      at_ms: nowMs,
      map_size: suppressionMap.size
    })
  );

  return { ok: true, emailId, recordedAtMs: nowMs };
}

trackRouter.get("/t/:token.gif", (req, res) => {
  const nowMs = Date.now();
  const openedAtIso = new Date(nowMs).toISOString();
  const token = req.params.token;

  try {
    const payload = decodeTrackingToken(token);
    const ipAddress = getRequestIp(req);
    const userAgent = req.get("user-agent") || null;
    const emailId = payload.email_id;

    cleanupExpiredSuppressions(nowMs);

    const pendingSuppression = suppressionMap.get(emailId);
    const wasSuppressedBySignal = Boolean(pendingSuppression);
    const deltaMs = pendingSuppression ? Math.max(0, nowMs - pendingSuppression.createdAtMs) : null;

    if (pendingSuppression) {
      suppressionMap.delete(emailId);
      pushSuppressionDebugEvent({
        event: "suppression_consumed",
        email_id: emailId,
        at_ms: nowMs,
        ip: normalizeIp(ipAddress),
        user_agent: String(userAgent || ""),
        delta_ms: deltaMs ?? undefined
      });
    }

    const isGoogleProxyHit = isGoogleImageProxyHit(userAgent, ipAddress);
    if (isGoogleProxyHit) {
      pushSuppressionDebugEvent({
        event: "google_proxy_hit",
        email_id: emailId,
        at_ms: nowMs,
        ip: normalizeIp(ipAddress),
        user_agent: String(userAgent || ""),
        pending_suppression: wasSuppressedBySignal,
        delta_ms: deltaMs ?? undefined
      });

      if (wasSuppressedBySignal && typeof deltaMs === "number") {
        latencySamples.push(deltaMs);
        if (latencySamples.length > LATENCY_SAMPLE_LIMIT) {
          latencySamples.splice(0, latencySamples.length - LATENCY_SAMPLE_LIMIT);
        }

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
    }

    const result = recordOpenEvent({
      payload,
      ipAddress,
      userAgent,
      openedAtIso,
      forceSenderSuppressed: wasSuppressedBySignal,
      suppressionReason: wasSuppressedBySignal ? "mark_suppress_next" : null
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
  cleanupExpiredSuppressions(Date.now());
  const stats = buildLatencyStats(latencySamples);
  res.json(stats);
});

trackRouter.get("/metrics/suppress-signals", (_req, res) => {
  cleanupExpiredSuppressions(Date.now());
  res.json({
    count: suppressSignalCount,
    active_email_ids: suppressionMap.size,
    ttl_ms: SUPPRESSION_TTL_MS,
    recent: suppressionDebugEvents
  });
});

trackRouter.get("/metrics/suppression-debug", (_req, res) => {
  cleanupExpiredSuppressions(Date.now());

  const byEmail: Record<string, { marks: number[]; google_proxy_hits: number[]; consumed: number[]; expired: number[] }> = {};
  for (const item of suppressionDebugEvents) {
    const current = byEmail[item.email_id] || {
      marks: [],
      google_proxy_hits: [],
      consumed: [],
      expired: []
    };

    if (item.event === "mark_suppress_next") {
      current.marks.push(item.at_ms);
    } else if (item.event === "google_proxy_hit") {
      current.google_proxy_hits.push(item.at_ms);
    } else if (item.event === "suppression_consumed") {
      current.consumed.push(item.at_ms);
    } else if (item.event === "suppression_expired") {
      current.expired.push(item.at_ms);
    }

    byEmail[item.email_id] = current;
  }

  res.json({
    active_email_ids: suppressionMap.size,
    ttl_ms: SUPPRESSION_TTL_MS,
    recent_events: suppressionDebugEvents,
    by_email: byEmail
  });
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

function enforceSuppressionMapLimit(): void {
  if (suppressionMap.size <= SUPPRESSION_MAP_LIMIT) {
    return;
  }

  const overflow = suppressionMap.size - SUPPRESSION_MAP_LIMIT;
  const keys = suppressionMap.keys();
  for (let i = 0; i < overflow; i += 1) {
    const key = keys.next().value;
    if (typeof key === "string") {
      suppressionMap.delete(key);
    }
  }
}

function cleanupExpiredSuppressions(nowMs: number): void {
  for (const [emailId, entry] of suppressionMap.entries()) {
    if (nowMs - entry.createdAtMs <= SUPPRESSION_TTL_MS) {
      continue;
    }

    suppressionMap.delete(emailId);
    pushSuppressionDebugEvent({
      event: "suppression_expired",
      email_id: emailId,
      at_ms: nowMs,
      ip: "",
      user_agent: ""
    });
  }
}

function pushSuppressionDebugEvent(event: SuppressionDebugEvent): void {
  suppressionDebugEvents.push(event);
  if (suppressionDebugEvents.length > SUPPRESSION_EVENT_LIMIT) {
    suppressionDebugEvents.splice(0, suppressionDebugEvents.length - SUPPRESSION_EVENT_LIMIT);
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
