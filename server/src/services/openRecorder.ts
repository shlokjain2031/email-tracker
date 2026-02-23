import type Database from "better-sqlite3";
import type { TrackingPayload } from "@email-tracker/shared";
import { getDb, initDb } from "../db/sqlite.js";
import { resolveGeoFromIp } from "./geoip.js";

const DEDUP_WINDOW_MS = Number(process.env.DEDUP_WINDOW_MS || 30_000);
const SELF_OPEN_GUARD_MS = Number(process.env.SELF_OPEN_GUARD_MS || 7_000);

export interface RecordOpenInput {
  payload: TrackingPayload;
  ipAddress: string | null;
  userAgent: string | null;
  openedAtIso: string;
}

export interface RecordOpenResult {
  isDuplicate: boolean;
  isSuppressedLikelySender: boolean;
  openCount: number;
}

interface CountRow {
  open_count: number;
}

const db = getDb();
initDb(db);
const upsertTrackedEmailStmt = db.prepare(`
  INSERT INTO tracked_emails (email_id, user_id, recipient, sender_email, sent_at, open_count)
  VALUES (@email_id, @user_id, @recipient, @sender_email, @sent_at, 0)
  ON CONFLICT(email_id) DO UPDATE SET
    user_id = excluded.user_id,
    recipient = excluded.recipient,
    sender_email = COALESCE(excluded.sender_email, tracked_emails.sender_email),
    sent_at = excluded.sent_at
`);

const findRecentDuplicateStmt = db.prepare(`
  SELECT id
  FROM open_events
  WHERE email_id = ?
    AND IFNULL(ip_address, '') = IFNULL(?, '')
    AND IFNULL(user_agent, '') = IFNULL(?, '')
    AND opened_at >= ?
  ORDER BY opened_at DESC
  LIMIT 1
`);

const findRecentDuplicateByAgentStmt = db.prepare(`
  SELECT id
  FROM open_events
  WHERE email_id = ?
    AND IFNULL(user_agent, '') = IFNULL(?, '')
    AND opened_at >= ?
  ORDER BY opened_at DESC
  LIMIT 1
`);

const findRecentDuplicateProxyStmt = db.prepare(`
  SELECT id
  FROM open_events
  WHERE email_id = ?
    AND opened_at >= ?
    AND (
      LOWER(IFNULL(user_agent, '')) LIKE '%googleimageproxy%'
      OR LOWER(IFNULL(user_agent, '')) LIKE '%google image proxy%'
      OR LOWER(IFNULL(user_agent, '')) LIKE '%ggpht.com%'
    )
  ORDER BY opened_at DESC
  LIMIT 1
`);

const findLikelySenderFingerprintStmt = db.prepare(`
  SELECT id
  FROM open_events
  WHERE email_id = ?
    AND IFNULL(ip_address, '') = IFNULL(?, '')
    AND IFNULL(user_agent, '') = IFNULL(?, '')
    AND opened_at <= ?
  ORDER BY opened_at ASC
  LIMIT 1
`);

const insertOpenEventStmt = db.prepare(`
  INSERT INTO open_events (
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
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'other', ?)
`);

const incrementOpenCountStmt = db.prepare(`
  UPDATE tracked_emails
  SET open_count = open_count + 1
  WHERE email_id = ?
`);

const getOpenCountStmt = db.prepare(`
  SELECT open_count
  FROM tracked_emails
  WHERE email_id = ?
`);

const txn = db.transaction((input: RecordOpenInput): RecordOpenResult => {
  upsertTrackedEmailStmt.run({
    email_id: input.payload.email_id,
    user_id: input.payload.user_id,
    recipient: input.payload.recipient,
    sender_email: input.payload.sender_email ?? null,
    sent_at: input.payload.sent_at
  });

  const dedupeThreshold = new Date(Date.parse(input.openedAtIso) - DEDUP_WINDOW_MS).toISOString();
  const duplicateRow = findRecentDuplicateStmt.get(
    input.payload.email_id,
    input.ipAddress,
    input.userAgent,
    dedupeThreshold
  ) as { id: number } | undefined;

  const duplicateByAgentRow = isLikelyProxyAgent(input.userAgent)
    ? (findRecentDuplicateByAgentStmt.get(input.payload.email_id, input.userAgent, dedupeThreshold) as
        | { id: number }
        | undefined)
    : undefined;

  const duplicateByProxyWindowRow = isLikelyProxyAgent(input.userAgent)
    ? (findRecentDuplicateProxyStmt.get(input.payload.email_id, dedupeThreshold) as { id: number } | undefined)
    : undefined;

  const isDuplicate = Boolean(duplicateRow || duplicateByAgentRow || duplicateByProxyWindowRow);
  const sentAtMs = Date.parse(input.payload.sent_at);
  const openedAtMs = Date.parse(input.openedAtIso);
  const isWithinInitialSenderWindow =
    Number.isFinite(sentAtMs) &&
    Number.isFinite(openedAtMs) &&
    openedAtMs >= sentAtMs &&
    openedAtMs - sentAtMs <= SELF_OPEN_GUARD_MS;

  const senderWindowUpperBoundIso = Number.isFinite(sentAtMs)
    ? new Date(sentAtMs + SELF_OPEN_GUARD_MS).toISOString()
    : null;

  const hasStrongFingerprint = Boolean(input.ipAddress && input.userAgent);
  const priorLikelySenderFingerprint =
    hasStrongFingerprint && senderWindowUpperBoundIso
      ? (findLikelySenderFingerprintStmt.get(
          input.payload.email_id,
          input.ipAddress,
          input.userAgent,
          senderWindowUpperBoundIso
        ) as { id: number } | undefined)
      : undefined;

  const isSuppressedLikelySender = isWithinInitialSenderWindow || Boolean(priorLikelySenderFingerprint);

  const geo = resolveGeoFromIp(input.ipAddress);

  insertOpenEventStmt.run(
    input.payload.email_id,
    input.payload.user_id,
    input.payload.recipient,
    input.openedAtIso,
    input.ipAddress,
    input.userAgent,
    geo.geo_country,
    geo.geo_region,
    geo.geo_city,
    geo.latitude,
    geo.longitude,
    isDuplicate || isSuppressedLikelySender ? 1 : 0
  );

  if (!isDuplicate && !isSuppressedLikelySender) {
    incrementOpenCountStmt.run(input.payload.email_id);
  }

  const row = getOpenCountStmt.get(input.payload.email_id) as CountRow | undefined;

  return {
    isDuplicate,
    isSuppressedLikelySender,
    openCount: row?.open_count ?? 0
  };
});

export function recordOpenEvent(input: RecordOpenInput, database: Database.Database = db): RecordOpenResult {
  if (database !== db) {
    return runWithDatabase(input, database);
  }

  return txn(input);
}

function runWithDatabase(input: RecordOpenInput, database: Database.Database): RecordOpenResult {
  const localTxn = database.transaction((txInput: RecordOpenInput): RecordOpenResult => {
    database
      .prepare(
        `
      INSERT INTO tracked_emails (email_id, user_id, recipient, sender_email, sent_at, open_count)
      VALUES (@email_id, @user_id, @recipient, @sender_email, @sent_at, 0)
      ON CONFLICT(email_id) DO UPDATE SET
        user_id = excluded.user_id,
        recipient = excluded.recipient,
        sender_email = COALESCE(excluded.sender_email, tracked_emails.sender_email),
        sent_at = excluded.sent_at
    `
      )
      .run({
        email_id: txInput.payload.email_id,
        user_id: txInput.payload.user_id,
        recipient: txInput.payload.recipient,
        sender_email: txInput.payload.sender_email ?? null,
        sent_at: txInput.payload.sent_at
      });

    const dedupeThreshold = new Date(Date.parse(txInput.openedAtIso) - DEDUP_WINDOW_MS).toISOString();
    const duplicateRow = database
      .prepare(
        `
      SELECT id
      FROM open_events
      WHERE email_id = ?
        AND IFNULL(ip_address, '') = IFNULL(?, '')
        AND IFNULL(user_agent, '') = IFNULL(?, '')
        AND opened_at >= ?
      ORDER BY opened_at DESC
      LIMIT 1
    `
      )
      .get(txInput.payload.email_id, txInput.ipAddress, txInput.userAgent, dedupeThreshold) as
      | { id: number }
      | undefined;

    const duplicateByAgentRow = isLikelyProxyAgent(txInput.userAgent)
      ? (database
          .prepare(
            `
      SELECT id
      FROM open_events
      WHERE email_id = ?
        AND IFNULL(user_agent, '') = IFNULL(?, '')
        AND opened_at >= ?
      ORDER BY opened_at DESC
      LIMIT 1
    `
          )
          .get(txInput.payload.email_id, txInput.userAgent, dedupeThreshold) as { id: number } | undefined)
      : undefined;

    const duplicateByProxyWindowRow = isLikelyProxyAgent(txInput.userAgent)
      ? (database
          .prepare(
            `
      SELECT id
      FROM open_events
      WHERE email_id = ?
        AND opened_at >= ?
        AND (
          LOWER(IFNULL(user_agent, '')) LIKE '%googleimageproxy%'
          OR LOWER(IFNULL(user_agent, '')) LIKE '%google image proxy%'
          OR LOWER(IFNULL(user_agent, '')) LIKE '%ggpht.com%'
        )
      ORDER BY opened_at DESC
      LIMIT 1
    `
          )
          .get(txInput.payload.email_id, dedupeThreshold) as { id: number } | undefined)
      : undefined;

    const isDuplicate = Boolean(duplicateRow || duplicateByAgentRow || duplicateByProxyWindowRow);
    const sentAtMs = Date.parse(txInput.payload.sent_at);
    const openedAtMs = Date.parse(txInput.openedAtIso);
    const isWithinInitialSenderWindow =
      Number.isFinite(sentAtMs) &&
      Number.isFinite(openedAtMs) &&
      openedAtMs >= sentAtMs &&
      openedAtMs - sentAtMs <= SELF_OPEN_GUARD_MS;

    const senderWindowUpperBoundIso = Number.isFinite(sentAtMs)
      ? new Date(sentAtMs + SELF_OPEN_GUARD_MS).toISOString()
      : null;

    const hasStrongFingerprint = Boolean(txInput.ipAddress && txInput.userAgent);
    const priorLikelySenderFingerprint =
      hasStrongFingerprint && senderWindowUpperBoundIso
        ? (database
            .prepare(
              `
      SELECT id
      FROM open_events
      WHERE email_id = ?
        AND IFNULL(ip_address, '') = IFNULL(?, '')
        AND IFNULL(user_agent, '') = IFNULL(?, '')
        AND opened_at <= ?
      ORDER BY opened_at ASC
      LIMIT 1
    `
            )
            .get(txInput.payload.email_id, txInput.ipAddress, txInput.userAgent, senderWindowUpperBoundIso) as
            | { id: number }
            | undefined)
        : undefined;

    const isSuppressedLikelySender = isWithinInitialSenderWindow || Boolean(priorLikelySenderFingerprint);
    const geo = resolveGeoFromIp(txInput.ipAddress);

    database
      .prepare(
        `
      INSERT INTO open_events (
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
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'other', ?)
    `
      )
      .run(
        txInput.payload.email_id,
        txInput.payload.user_id,
        txInput.payload.recipient,
        txInput.openedAtIso,
        txInput.ipAddress,
        txInput.userAgent,
        geo.geo_country,
        geo.geo_region,
        geo.geo_city,
        geo.latitude,
        geo.longitude,
        isDuplicate || isSuppressedLikelySender ? 1 : 0
      );

    if (!isDuplicate && !isSuppressedLikelySender) {
      database
        .prepare(
          `
        UPDATE tracked_emails
        SET open_count = open_count + 1
        WHERE email_id = ?
      `
        )
        .run(txInput.payload.email_id);
    }

    const row = database
      .prepare(
        `
      SELECT open_count
      FROM tracked_emails
      WHERE email_id = ?
    `
      )
      .get(txInput.payload.email_id) as CountRow | undefined;

    return {
      isDuplicate,
      isSuppressedLikelySender,
      openCount: row?.open_count ?? 0
    };
  });

  return localTxn(input);
}

function isLikelyProxyAgent(userAgent: string | null): boolean {
  const ua = String(userAgent || "").toLowerCase();
  return ua.includes("googleimageproxy") || ua.includes("google image proxy") || ua.includes("ggpht.com");
}
