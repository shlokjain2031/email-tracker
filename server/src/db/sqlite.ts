import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDbPath = path.resolve(__dirname, "../../data/tracker.db");

let dbInstance: Database.Database | null = null;

export function getDb(dbPath = process.env.DB_PATH ?? defaultDbPath): Database.Database {
  if (!dbInstance) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    dbInstance = new Database(dbPath);
    dbInstance.pragma("journal_mode = WAL");
    dbInstance.pragma("foreign_keys = ON");
  }

  return dbInstance;
}

export function initDb(db = getDb()): void {
  const schemaPath = resolveSchemaPath();
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  db.exec(schemaSql);

  ensureColumnExists(db, "tracked_emails", "sender_email", "TEXT");
}

function ensureColumnExists(db: Database.Database, table: string, column: string, definition: string): void {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = info.some((row) => row.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function resolveSchemaPath(): string {
  const candidates = [
    path.resolve(__dirname, "./schema.sql"),
    path.resolve(__dirname, "../../src/db/schema.sql")
  ];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("Could not locate schema.sql for database initialization");
  }

  return found;
}
