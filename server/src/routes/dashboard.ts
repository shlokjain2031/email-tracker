import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { getDb } from "../db/sqlite.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TrackedEmailRow {
  email_id: string;
  user_id: string;
  recipient: string;
  sent_at: string;
  open_count: number;
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

const listEmailsStmt = db.prepare(`
  SELECT
    email_id,
    user_id,
    recipient,
    sent_at,
    open_count,
    created_at
  FROM tracked_emails
  ORDER BY datetime(created_at) DESC
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
    sent_at: row.sent_at,
    open_count: row.open_count,
    opened: row.open_count > 0,
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
