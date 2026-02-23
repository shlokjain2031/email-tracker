import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { getDb, initDb } from "../db/sqlite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TrackedEmailRow {
  email_id: string;
  user_id: string;
  recipient: string;
  sender_email: string | null;
  sent_at: string;
  unique_open_count: number;
  total_open_events: number;
  raw_open_events: number;
  last_opened_at: string | null;
  created_at: string;
}

interface OpenEventRow {
  id: number;
  email_id: string;
  user_id: string;
  recipient: string;
  opened_at: string;
  ip_address: string | null;
  user_agent: string | null;
  geo_country: string | null;
  geo_region: string | null;
  geo_city: string | null;
  latitude: number | null;
  longitude: number | null;
  device_type: string;
  is_duplicate: number;
}

const db = getDb();
initDb(db);

const listEmailsStmt = db.prepare(`
  SELECT
    te.email_id,
    te.user_id,
    te.recipient,
    te.sender_email,
    te.sent_at,
    te.open_count AS unique_open_count,
    COALESCE(oe.total_open_events, 0) AS total_open_events,
    COALESCE(oe.raw_open_events, 0) AS raw_open_events,
    oe.last_opened_at,
    te.created_at
  FROM tracked_emails te
  LEFT JOIN (
    SELECT
      email_id,
      COUNT(*) AS raw_open_events,
      SUM(CASE WHEN is_duplicate = 0 THEN 1 ELSE 0 END) AS total_open_events,
      MAX(CASE WHEN is_duplicate = 0 THEN opened_at ELSE NULL END) AS last_opened_at
    FROM open_events
    GROUP BY email_id
  ) oe ON oe.email_id = te.email_id
  ORDER BY datetime(te.created_at) DESC
`);

const listOpenEventsBaseSql = `
  SELECT
    id,
    email_id,
    user_id,
    recipient,
    opened_at,
    ip_address,
    user_agent,
    geo_country,
    geo_region,
    geo_city,
    latitude,
    longitude,
    device_type,
    is_duplicate
  FROM open_events
`;

export const dashboardRouter = Router();

dashboardRouter.get("/dashboard", (_req, res) => {
  const dashboardFilePath = resolveDashboardFilePath();
  res.sendFile(dashboardFilePath);
});

dashboardRouter.get("/dashboard/api/emails", (req, res) => {
  if (!isAuthorized(req.get("X-Tracker-Token"))) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const rows = listEmailsStmt.all() as TrackedEmailRow[];
  const items = rows.map((row) => ({
    email_id: row.email_id,
    user_id: row.user_id,
    recipient: row.recipient,
    sender_email: row.sender_email,
    sent_at: row.sent_at,
    unique_open_count: row.unique_open_count,
    total_open_events: row.total_open_events,
    raw_open_events: row.raw_open_events,
    last_opened_at: row.last_opened_at,
    opened: row.unique_open_count > 0,
    created_at: row.created_at
  }));

  res.json({ ok: true, items });
});

dashboardRouter.get("/dashboard/api/open-events", (req, res) => {
  if (!isAuthorized(req.get("X-Tracker-Token"))) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const emailId = String(req.query.email_id || "").trim();

  const query = emailId
    ? `${listOpenEventsBaseSql} WHERE email_id = ? ORDER BY datetime(opened_at) DESC`
    : `${listOpenEventsBaseSql} ORDER BY datetime(opened_at) DESC`;

  const rows = emailId
    ? ((db.prepare(query).all(emailId) as OpenEventRow[]) ?? [])
    : ((db.prepare(query).all() as OpenEventRow[]) ?? []);

  res.json({ ok: true, items: rows });
});

function isAuthorized(incomingToken: string | undefined): boolean {
  const expectedToken = process.env.DASHBOARD_TOKEN;
  if (!expectedToken) {
    return false;
  }

  return incomingToken === expectedToken;
}

function resolveDashboardFilePath(): string {
  const candidates = [
    path.resolve(__dirname, "../public/dashboard.html"),
    path.resolve(__dirname, "../../src/public/dashboard.html")
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("Could not locate dashboard.html");
  }

  return found;
}
