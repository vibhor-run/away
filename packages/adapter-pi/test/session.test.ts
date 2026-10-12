import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@away/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { PiAdapter } from "../src/adapter.ts";
import type { PiSession } from "../src/session.ts";

const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "away-pi-test-"));
const adapter = new PiAdapter({ command: fakePi, startupTimeoutMs: 5_000, closeTimeoutMs: 1_000 });
const open: PiSession[] = [];

async function start(resumeSessionId?: string) {
  const session = await adapter.startSession({ cwd, ...(resumeSessionId !== undefined && { resumeSessionId }) });
  open.push(session);
  const events: AgentEvent[] = [];
  session.onEvent((event) => events.push(event));
  return { session, events };
}

function waitFor(events: AgentEvent[], predicate: (event: AgentEvent) => boolean): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3_000;
    const check = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() > deadline) return reject(new Error("timed out waiting for event"));
      setTimeout(check, 10);
    };
    check();
  });
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((session) => session.close()));
});

describe("PiAdapter", () => {
  it("detects a supported version", async () => {
    expect(await adapter.detect()).toEqual({ installed: true, supported: true, version: "1.1.0" });
  });

  it("reports a missing executable instead of throwing", async () => {
    const missing = new PiAdapter({ command: join(cwd, "no-such-pi") });
    expect(await missing.detect()).toMatchObject({ installed: false, supported: false });
    await expect(missing.startSession({ cwd })).rejects.toThrow(/ENOENT/);
  });

  it("reads the native session id and passes --session when resuming", async () => {
    expect((await start()).session.nativeSessionId).toBe("fake-session");
    expect((await start("abc-123")).session.nativeSessionId).toBe("abc-123");
  });
});

describe("PiSession", () => {
  it("streams text and keeps U+2028 inside a delta", async () => {
    const { session, events } = await start();
    expect(await session.sendPrompt("hello")).toBe("started");
    await waitFor(events, (event) => event.type === "run_settled");
    expect(events.map((event) => event.type)).toEqual([
      "message_completed",
      "run_started",
      "assistant_message_started",
      "text_delta",
      "text_delta",
      "message_completed",
      "run_settled",
    ]);
    expect(events[0]).toMatchObject({ role: "user", text: "hello" });
    expect(events[3]).toMatchObject({ delta: "Hi " });
    expect(events[5]).toMatchObject({ role: "assistant", text: "Hi  there", stopReason: "stop" });
  });

  it("maps tool lifecycle events", async () => {
    const { session, events } = await start();
    await session.sendPrompt("tool");
    await waitFor(events, (event) => event.type === "run_settled");
    expect(events.filter((event) => event.type.startsWith("tool_"))).toEqual([
      { type: "tool_started", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } },
      { type: "tool_updated", toolCallId: "call-1", output: "a", truncated: false },
      { type: "tool_finished", toolCallId: "call-1", output: "a\nb", truncated: false, isError: false },
    ]);
  });

  it("rejects a prompt while the agent is busy instead of queueing it", async () => {
    const { session, events } = await start();
    await session.sendPrompt("slow");
    await waitFor(events, (event) => event.type === "text_delta");
    await expect(session.sendPrompt("again")).rejects.toThrow(/already streaming/);
  });

  it("interrupts a running turn without ending the process", async () => {
    const { session, events } = await start();
    await session.sendPrompt("slow");
    await waitFor(events, (event) => event.type === "text_delta");
    await session.interrupt();
    expect(events.at(-1)).toEqual({ type: "run_settled", aborted: true });
    expect(await session.sendPrompt("hello")).toBe("started");
    expect(events.some((event) => event.type === "process_exited")).toBe(false);
  });

  it("round-trips an input request", async () => {
    const { session, events } = await start();
    await session.sendPrompt("ask");
    const request = await waitFor(events, (event) => event.type === "input_requested");
    expect(request).toMatchObject({ requestId: "ui-1", kind: "confirm", title: "Allow?", timeoutMs: 60000 });
    await session.respondToInput("ui-1", { kind: "confirm", confirmed: true });
    const reply = await waitFor(events, (event) => event.type === "message_completed" && event.role === "assistant");
    expect(reply).toMatchObject({ text: "confirmed:true" });
  });

  it("reports an unexpected exit and fails pending requests", async () => {
    const { session, events } = await start();
    await expect(session.sendPrompt("crash")).rejects.toThrow(/exited/);
    expect(await waitFor(events, (event) => event.type === "process_exited")).toEqual({
      type: "process_exited",
      code: 3,
      signal: null,
      expected: false,
    });
  });

  it("closes gracefully by ending stdin", async () => {
    const { session, events } = await start();
    await session.close();
    expect(events).toEqual([{ type: "process_exited", code: 0, signal: null, expected: true }]);
  });
});
