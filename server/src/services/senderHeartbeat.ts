import type { TrackingPayload } from "@email-tracker/shared";
import { getDb, initDb } from "../db/sqlite.js";

export interface RecordSenderHeartbeatInput {
  payload: TrackingPayload;
  ipAddress: string | null;
  userAgent: string | null;
  seenAtIso: string;
}

const db = getDb();
initDb(db);

const insertSenderHeartbeatStmt = db.prepare(`
  INSERT INTO sender_heartbeats (
    email_id,
    user_id,
    sender_email,
    seen_at,
    ip_address,
    user_agent
  )
  VALUES (?, ?, ?, ?, ?, ?)
`);

export function recordSenderHeartbeat(input: RecordSenderHeartbeatInput): void {
  insertSenderHeartbeatStmt.run(
    input.payload.email_id,
    input.payload.user_id,
    input.payload.sender_email ?? null,
    input.seenAtIso,
    input.ipAddress,
    input.userAgent
  );
}
