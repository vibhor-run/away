import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";

const freshStore = () => new Store(mkdtempSync(join(tmpdir(), "away-store-")));

describe("Store", () => {
  it("accepts a pairing token once and only before it expires", () => {
    const store = freshStore();
    const now = Date.now();
    const token = store.createPairingToken(now);
    expect(store.consumePairingToken("not-a-token", now)).toBe(false);
    expect(store.consumePairingToken(token, now)).toBe(true);
    expect(store.consumePairingToken(token, now)).toBe(false);

    const expiring = store.createPairingToken(now);
    expect(store.consumePairingToken(expiring, now + 5 * 60 * 1000 + 1)).toBe(false);
  });

  it("never stores pairing tokens in plain text", () => {
    const store = freshStore();
    const token = store.createPairingToken();
    const rows = store.db.prepare("SELECT token_hash FROM pairing_tokens").all() as { token_hash: string }[];
    expect(rows.map((row) => row.token_hash)).not.toContain(token);
  });

  it("treats a repeated command id as a duplicate", () => {
    const store = freshStore();
    expect(store.insertCommand("device", "cmd-1", "list_projects", undefined)).toBe(true);
    expect(store.insertCommand("device", "cmd-1", "list_projects", undefined)).toBe(false);
    expect(store.insertCommand("other-device", "cmd-1", "list_projects", undefined)).toBe(true);
  });

  it("after a crash, fails unfinished commands without resending and ends live sessions", () => {
    const store = freshStore();
    const project = store.addProject("/tmp/demo", "demo");
    const session = store.createSession("pi", project.id);
    store.updateSession(session.id, { status: "running" });
    store.insertCommand("device", "delivered", "send_prompt", session.id);
    store.updateCommand("device", "delivered", { status: "accepted" });
    store.insertCommand("device", "undelivered", "send_prompt", session.id);

    // Simulates a crash: no shutdown ran, the next start reconciles.
    expect(store.reconcileAfterRestart()).toEqual({ endedSessions: [session.id] });
    expect(store.getCommand("device", "delivered")).toEqual({
      status: "failed",
      error: "Away stopped while the agent was working; the outcome is unknown",
    });
    expect(store.getCommand("device", "undelivered")).toEqual({
      status: "failed",
      error: "Away stopped before this command finished",
    });
    expect(store.getSession(session.id)?.status).toBe("ended");
    expect(store.eventsAfter(session.id, 0).map((entry) => entry.event)).toEqual([{ type: "session_status", status: "ended" }]);
  });
});
