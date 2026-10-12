import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@away/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapter.ts";
import type { CodexSession } from "../src/session.ts";

const fakeCodex = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "away-codex-test-"));
const adapter = new CodexAdapter({ command: fakeCodex, startupTimeoutMs: 5_000, closeTimeoutMs: 1_000 });
const open: CodexSession[] = [];

async function start(resumeSessionId?: string) {
  const session = await adapter.startSession({ cwd, ...(resumeSessionId !== undefined && { resumeSessionId }) });
  open.push(session);
  const events: AgentEvent[] = [];
  session.onEvent((event) => events.push(event));
  return { session, events };
}

async function waitFor(events: AgentEvent[], predicate: (event: AgentEvent) => boolean): Promise<AgentEvent> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const found = events.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting for event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settled = (events: AgentEvent[]) => waitFor(events, (event) => event.type === "run_settled");

afterEach(async () => {
  await Promise.all(open.splice(0).map((session) => session.close()));
});

describe("CodexAdapter", () => {
  it("detects the installed version", async () => {
    expect(await adapter.detect()).toEqual({ installed: true, supported: true, version: "0.162.1" });
  });

  it("starts or resumes a thread", async () => {
    expect((await start()).session.nativeSessionId).toBe("thread-1");
    expect((await start("thread-9")).session.nativeSessionId).toBe("thread-9");
  });

  it("refuses to start when Codex is logged out", async () => {
    process.env.FAKE_CODEX_LOGGED_OUT = "1";
    try {
      await expect(adapter.startSession({ cwd })).rejects.toThrow(/not logged in/);
    } finally {
      delete process.env.FAKE_CODEX_LOGGED_OUT;
    }
  });
});

describe("CodexSession", () => {
  it("streams an agent message", async () => {
    const { session, events } = await start();
    expect(await session.sendPrompt("hello")).toBe("started");
    expect(await settled(events)).toEqual({ type: "run_settled", aborted: false });
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "message_completed",
      "assistant_message_started",
      "text_delta",
      "text_delta",
      "message_completed",
      "run_settled",
    ]);
    expect(events.find((event) => event.type === "message_completed")).toMatchObject({ role: "user", text: "hello" });
    expect(events.findLast((event) => event.type === "message_completed")).toMatchObject({ role: "assistant", text: "Hello there" });
  });

  it("asks for command approval and runs the command when allowed", async () => {
    const { session, events } = await start();
    await session.sendPrompt("run");
    const request = await waitFor(events, (event) => event.type === "input_requested");
    expect(request).toMatchObject({
      kind: "approval",
      tool: { name: "command", input: { command: "echo hi", cwd: "/work" } },
      allowAlways: true,
    });
    if (request.type !== "input_requested") throw new Error("unreachable");
    await session.respondToInput(request.requestId, { kind: "approval", decision: "allow" });
    await settled(events);
    expect(events).toContainEqual({ type: "input_resolved", requestId: request.requestId });
    expect(events).toContainEqual({ type: "tool_finished", toolCallId: "exec-1", output: "hi\n", truncated: false, isError: false });
  });

  it("reports a declined command", async () => {
    const { session, events } = await start();
    await session.sendPrompt("run");
    const request = await waitFor(events, (event) => event.type === "input_requested");
    if (request.type !== "input_requested") throw new Error("unreachable");
    await session.respondToInput(request.requestId, { kind: "approval", decision: "deny" });
    await settled(events);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_finished", isError: true, output: "[declined]\n" }));
  });

  it("maps allow_always to acceptForSession", async () => {
    const { session, events } = await start();
    await session.sendPrompt("run");
    const request = await waitFor(events, (event) => event.type === "input_requested");
    if (request.type !== "input_requested") throw new Error("unreachable");
    await session.respondToInput(request.requestId, { kind: "approval", decision: "allow_always" });
    await settled(events);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_finished", isError: false }));
  });

  it("forwards structured questions and answers them by id", async () => {
    const { session, events } = await start();
    await session.sendPrompt("ask");
    const request = await waitFor(events, (event) => event.type === "input_requested");
    expect(request).toMatchObject({
      kind: "questions",
      questions: [{ id: "color", question: "Pick a color", options: [{ label: "red" }, { label: "blue" }], allowOther: false }],
    });
    if (request.type !== "input_requested") throw new Error("unreachable");
    await session.respondToInput(request.requestId, { kind: "answers", answers: { color: ["blue"] } });
    await settled(events);
    expect(events).toContainEqual(expect.objectContaining({ type: "message_completed", text: "answer:blue" }));
  });

  it("reports a failed turn", async () => {
    const { session, events } = await start();
    await session.sendPrompt("fail");
    expect(await settled(events)).toEqual({ type: "run_settled", aborted: false, error: "usage limit" });
    expect(events).toContainEqual({ type: "notice", level: "error", message: "usage limit" });
  });

  it("interrupts a turn and refuses overlapping turns", async () => {
    const { session, events } = await start();
    await session.sendPrompt("slow");
    await waitFor(events, (event) => event.type === "text_delta");
    await expect(session.sendPrompt("again")).rejects.toThrow(/already working/);
    await session.interrupt();
    expect(await settled(events)).toEqual({ type: "run_settled", aborted: true });
    expect(await session.sendPrompt("hello")).toBe("started");
  });

  it("settles a turn that completes before turn/start is answered", async () => {
    const { session, events } = await start();
    await session.sendPrompt("early");
    expect(await settled(events)).toEqual({ type: "run_settled", aborted: false });
    expect(await session.sendPrompt("hello")).toBe("started");
  });

  it("answers unsupported server requests with an error instead of hanging", async () => {
    const { session, events } = await start();
    await session.sendPrompt("unknown");
    await waitFor(events, (event) => event.type === "notice");
    await settled(events);
    expect(session.nativeSessionId).toBe("thread-1");
  });
});
