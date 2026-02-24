import { Router } from "express";
import { decodeTrackingToken } from "@email-tracker/shared";
import { recordOpenEvent } from "../services/openRecorder.js";
import { recordSenderHeartbeat } from "../services/senderHeartbeat.js";

const TRANSPARENT_PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

export const trackRouter = Router();

trackRouter.get("/t/:token.gif", (req, res) => {
  const openedAtIso = new Date().toISOString();
  const token = req.params.token;

  try {
    const payload = decodeTrackingToken(token);
    const ipAddress = getRequestIp(req);
    const userAgent = req.get("user-agent") || null;

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
