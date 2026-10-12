import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CommandStatus, Project, SessionEvent, SessionStatus } from "@away/protocol";

/**
 * Away-owned local state: paired devices, projects, sessions, an event log for reconnecting
 * clients, and command statuses for de-duplication. Native agent history stays with the agent.
 */

const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

const MIGRATIONS = [
  `
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    paired_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE pairing_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    added_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    native_session_id TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE events (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    at TEXT NOT NULL,
    event TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE TABLE commands (
    device_id TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (device_id, id)
  );
  `,
];

export interface Device {
  id: string;
  publicKey: string;
  name: string;
  pairedAt: string;
  revokedAt: string | null;
}

export interface SessionRow {
  id: string;
  agent: string;
  projectId: string;
  nativeSessionId: string | null;
  status: SessionStatus;
  createdAt: string;
  lastSeq: number;
}

export interface StoredEvent {
  seq: number;
  at: string;
  event: SessionEvent;
}

export interface CommandRecord {
  status: CommandStatus;
  result?: unknown;
  error?: string;
}

type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(join(dataDir, "away.db"));
    // WAL lets CLI commands (pair, revoke) write while `away serve` is running.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    // The log holds prompts and agent output: readable by the current user only.
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = join(dataDir, `away.db${suffix}`);
      if (existsSync(file)) chmodSync(file, 0o600);
    }
    const version = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    for (let index = version; index < MIGRATIONS.length; index++) {
      this.db.exec("BEGIN");
      this.db.exec(MIGRATIONS[index]!);
      this.db.exec(`PRAGMA user_version = ${index + 1}`);
      this.db.exec("COMMIT");
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- Pairing and devices ----

  /** Creates a single-use pairing token. Only its hash is stored. */
  createPairingToken(now = Date.now()): string {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM pairing_tokens WHERE expires_at < ?").run(now);
    this.db
      .prepare("INSERT INTO pairing_tokens (token_hash, expires_at) VALUES (?, ?)")
      .run(hashToken(token), now + PAIRING_TOKEN_TTL_MS);
    return token;
  }

  /** Atomically marks a token used. Returns false if it is unknown, expired, or already used. */
  consumePairingToken(token: string, now = Date.now()): boolean {
    const result = this.db
      .prepare("UPDATE pairing_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
      .run(now, hashToken(token), now);
    return result.changes === 1;
  }

  addDevice(publicKey: string, name: string): Device {
    const existing = this.findDeviceByKey(publicKey);
    if (existing && !existing.revokedAt) return existing;
    if (existing) this.db.prepare("DELETE FROM devices WHERE id = ?").run(existing.id);
    const device: Device = { id: randomUUID(), publicKey, name, pairedAt: new Date().toISOString(), revokedAt: null };
    this.db
      .prepare("INSERT INTO devices (id, public_key, name, paired_at) VALUES (?, ?, ?, ?)")
      .run(device.id, publicKey, name, device.pairedAt);
    return device;
  }

  findDeviceByKey(publicKey: string): Device | undefined {
    const row = this.db.prepare("SELECT * FROM devices WHERE public_key = ?").get(publicKey) as Row | undefined;
    return row && toDevice(row);
  }

  getDevice(id: string): Device | undefined {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    return row && toDevice(row);
  }

  listDevices(): Device[] {
    return (this.db.prepare("SELECT * FROM devices ORDER BY paired_at").all() as Row[]).map(toDevice);
  }

  revokeDevice(id: string): boolean {
    const result = this.db
      .prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id);
    return result.changes === 1;
  }

  // ---- Projects ----

  addProject(path: string, name: string): Project {
    const existing = this.db.prepare("SELECT * FROM projects WHERE path = ?").get(path) as Row | undefined;
    if (existing) return toProject(existing);
    const project = { id: randomUUID(), path, name };
    this.db
      .prepare("INSERT INTO projects (id, path, name, added_at) VALUES (?, ?, ?, ?)")
      .run(project.id, path, name, new Date().toISOString());
    return project;
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return row && toProject(row);
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY name").all() as Row[]).map(toProject);
  }

  removeProject(id: string): boolean {
    if (this.db.prepare("SELECT 1 FROM sessions WHERE project_id = ? LIMIT 1").get(id)) {
      throw new Error("Project has sessions; it cannot be removed yet");
    }
    return this.db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes === 1;
  }

  // ---- Sessions and events ----

  createSession(agent: string, projectId: string): SessionRow {
    const row: SessionRow = {
      id: randomUUID(),
      agent,
      projectId,
      nativeSessionId: null,
      status: "starting",
      createdAt: new Date().toISOString(),
      lastSeq: 0,
    };
    this.db
      .prepare("INSERT INTO sessions (id, agent, project_id, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, agent, projectId, row.status, row.createdAt);
    return row;
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row && toSession(row);
  }

  listSessions(): SessionRow[] {
    return (this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as Row[]).map(toSession);
  }

  updateSession(id: string, fields: { status?: SessionStatus; nativeSessionId?: string | null }): void {
    if (fields.status !== undefined) this.db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(fields.status, id);
    if (fields.nativeSessionId !== undefined) {
      this.db.prepare("UPDATE sessions SET native_session_id = ? WHERE id = ?").run(fields.nativeSessionId, id);
    }
  }

  appendEvent(sessionId: string, event: SessionEvent): StoredEvent {
    const at = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { last_seq } = this.db.prepare("SELECT last_seq FROM sessions WHERE id = ?").get(sessionId) as Row;
      const seq = Number(last_seq) + 1;
      this.db.prepare("UPDATE sessions SET last_seq = ? WHERE id = ?").run(seq, sessionId);
      this.db
        .prepare("INSERT INTO events (session_id, seq, at, event) VALUES (?, ?, ?, ?)")
        .run(sessionId, seq, at, JSON.stringify(event));
      this.db.exec("COMMIT");
      return { seq, at, event };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  eventsAfter(sessionId: string, afterSeq: number): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT seq, at, event FROM events WHERE session_id = ? AND seq > ? ORDER BY seq")
      .all(sessionId, afterSeq) as Row[];
    return rows.map((row) => ({
      seq: Number(row.seq),
      at: String(row.at),
      event: JSON.parse(String(row.event)) as SessionEvent,
    }));
  }

  // ---- Commands ----

  getCommand(deviceId: string, commandId: string): CommandRecord | undefined {
    const row = this.db
      .prepare("SELECT status, result, error FROM commands WHERE device_id = ? AND id = ?")
      .get(deviceId, commandId) as Row | undefined;
    if (!row) return undefined;
    return {
      status: row.status as CommandStatus,
      ...(row.result !== null && { result: JSON.parse(String(row.result)) as unknown }),
      ...(row.error !== null && { error: String(row.error) }),
    };
  }

  /** Records a new command. Returns false if this device already sent this id. */
  insertCommand(deviceId: string, commandId: string, kind: string, sessionId: string | undefined): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO commands (device_id, id, kind, session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'received', ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(deviceId, commandId, kind, sessionId ?? null, now, now);
    return result.changes === 1;
  }

  updateCommand(deviceId: string, commandId: string, record: CommandRecord): void {
    this.db
      .prepare("UPDATE commands SET status = ?, result = ?, error = ?, updated_at = ? WHERE device_id = ? AND id = ?")
      .run(
        record.status,
        record.result === undefined ? null : JSON.stringify(record.result),
        record.error ?? null,
        new Date().toISOString(),
        deviceId,
        commandId,
      );
  }

  /**
   * After a restart no agent process from the previous run is alive. Marks such sessions ended
   * and unfinished commands failed. Nothing is re-sent to an agent.
   */
  reconcileAfterRestart(): { endedSessions: string[] } {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE commands SET status = 'failed', updated_at = ?,
           error = CASE status
             WHEN 'accepted' THEN 'Away stopped while the agent was working; the outcome is unknown'
             ELSE 'Away stopped before this command finished' END
         WHERE status IN ('received', 'accepted')`,
      )
      .run(now);
    const ended = (this.db.prepare("SELECT id FROM sessions WHERE status != 'ended'").all() as Row[]).map((row) =>
      String(row.id),
    );
    for (const id of ended) {
      this.updateSession(id, { status: "ended" });
      this.appendEvent(id, { type: "session_status", status: "ended" });
    }
    return { endedSessions: ended };
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toDevice(row: Row): Device {
  return {
    id: String(row.id),
    publicKey: String(row.public_key),
    name: String(row.name),
    pairedAt: String(row.paired_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
  };
}

function toProject(row: Row): Project {
  return { id: String(row.id), path: String(row.path), name: String(row.name) };
}

function toSession(row: Row): SessionRow {
  return {
    id: String(row.id),
    agent: String(row.agent),
    projectId: String(row.project_id),
    nativeSessionId: row.native_session_id === null ? null : String(row.native_session_id),
    status: row.status as SessionStatus,
    createdAt: String(row.created_at),
    lastSeq: Number(row.last_seq),
  };
}
