import Database from "better-sqlite3";
import { dbPath } from "./config.js";
import type { Workspace } from "./types.js";

let db: Database.Database;

// Cached prepared statements (initialized in initDb)
let stmtGetByChannel: Database.Statement;
let stmtUpsert: Database.Statement;
let stmtUpdateSession: Database.Statement;
let stmtClearSession: Database.Statement;

export function initDb(): void {
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      name TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      channel_id TEXT UNIQUE,
      current_session_id TEXT
    );
  `);

  stmtGetByChannel = db.prepare(
    "SELECT name, cwd, channel_id, current_session_id FROM workspaces WHERE channel_id = ?",
  );
  stmtUpsert = db.prepare(
    `INSERT INTO workspaces (name, cwd, channel_id, current_session_id)
     VALUES (@name, @cwd, @channel_id, @current_session_id)
     ON CONFLICT(name) DO UPDATE SET
       cwd = excluded.cwd,
       channel_id = excluded.channel_id,
       current_session_id = excluded.current_session_id`,
  );
  stmtUpdateSession = db.prepare(
    "UPDATE workspaces SET current_session_id = ? WHERE name = ?",
  );
  stmtClearSession = db.prepare(
    "UPDATE workspaces SET current_session_id = NULL WHERE name = ?",
  );
}

export function getWorkspaceByChannel(
  channelId: string,
): Workspace | undefined {
  return stmtGetByChannel.get(channelId) as Workspace | undefined;
}

export function upsertWorkspace(ws: Workspace): void {
  stmtUpsert.run(ws);
}

export function updateSessionId(
  name: string,
  sessionId: string,
): void {
  stmtUpdateSession.run(sessionId, name);
}

export function clearSession(name: string): void {
  stmtClearSession.run(name);
}
