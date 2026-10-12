import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@away/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../src/adapter.ts";
import type { ClaudeSession } from "../src/session.ts";

// A fake `claude` executable for detect(), and a fake SDK query() driven by prompt text.
const dir = mkdtempSync(join(tmpdir(), "away-claude-test-"));
const fakeClaude = join(dir, "claude");
writeFileSync(fakeClaude, '#!/bin/sh\necho "2.1.280 (Claude Code)"\n');
chmodSync(fakeClaude, 0o755);

let lastOptions: Options | undefined;

function fakeQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  lastOptions = options;
  let interrupted = false;
  let closed = false;
  const canUseTool = options!.canUseTool as CanUseTool;
  const base = { session_id: "s", uuid: "00000000-0000-0000-0000-000000000000", parent_tool_use_id: null };
  const assistant = (id: string, content: unknown[]) =>
    ({ type: "assistant", ...base, message: { id, content, stop_reason: "end_turn" } }) as unknown as SDKMessage;
  const result = (fields: Record<string, unknown> = {}) =>
    ({ type: "result", subtype: "success", is_error: false, result: "", ...base, ...fields }) as unknown as SDKMessage;

  async function* run(): AsyncGenerator<SDKMessage, void> {
    for await (const message of prompt) {
      if (closed) return;
      const text = message.message.content as string;
      if (text === "hello") {
        yield { type: "stream_event", ...base, event: { type: "message_start", message: { id: "m1" } } } as unknown as SDKMessage;
        yield { type: "stream_event", ...base, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } } } as unknown as SDKMessage;
        yield { type: "stream_event", ...base, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "there" } } } as unknown as SDKMessage;
        // The SDK delivers one content block per assistant message.
        yield assistant("m1", [{ type: "text", text: "Hi " }]);
        yield assistant("m1", [{ type: "text", text: "there" }]);
        yield result();
      } else if (text === "tool") {
        yield assistant("m2", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]);
        const decision = await canUseTool("Bash", { command: "ls" }, {
          signal: new AbortController().signal,
          suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }],
          toolUseID: "t1",
          requestId: "r1",
          title: "Claude wants to run ls",
        } as Parameters<CanUseTool>[2]);
        yield { type: "user", ...base, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify(decision), is_error: decision?.behavior === "deny" }] } } as unknown as SDKMessage;
        yield result();
      } else if (text === "ask") {
        const decision = await canUseTool(
          "AskUserQuestion",
          { questions: [{ question: "Which db?", header: "DB", multiSelect: false, options: [{ label: "sqlite", description: "local" }, { label: "postgres", description: "server" }] }] },
          { signal: new AbortController().signal, toolUseID: "t2", requestId: "r2" } as Parameters<CanUseTool>[2],
        );
        yield assistant("m3", [{ type: "text", text: JSON.stringify(decision) }]);
        yield result();
      } else if (text === "slow") {
        yield { type: "stream_event", ...base, event: { type: "message_start", message: { id: "m4" } } } as unknown as SDKMessage;
        while (!interrupted) {
          yield { type: "stream_event", ...base, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "." } } } as unknown as SDKMessage;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        yield result({ subtype: "error_during_execution", is_error: true, errors: [] });
      } else if (text === "fail") {
        yield result({ is_error: true, result: "API Error: 529 overloaded" });
      } else if (text === "boom") {
        throw new Error("process crashed");
      }
    }
  }

  const generator = run();
  return Object.assign(generator, {
    initializationResult: async () => ({}),
    interrupt: async () => {
      interrupted = true;
      return undefined;
    },
    close: () => {
      closed = true;
      void generator.return(undefined);
    },
  }) as unknown as Query;
}

const adapter = new ClaudeAdapter({ command: fakeClaude, query: fakeQuery, closeTimeoutMs: 500 });
const open: ClaudeSession[] = [];

async function start(resumeSessionId?: string) {
  const session = await adapter.startSession({ cwd: dir, ...(resumeSessionId !== undefined && { resumeSessionId }) });
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

describe("ClaudeAdapter", () => {
  it("detects the installed CLI", async () => {
    expect(await adapter.detect()).toEqual({ installed: true, supported: true, version: "2.1.280" });
    expect(await new ClaudeAdapter({ command: "definitely-not-claude" }).detect()).toMatchObject({ installed: false });
  });

  it("uses the installed CLI with the user's settings and the Claude Code system prompt", async () => {
    const { session } = await start();
    expect(lastOptions).toMatchObject({
      pathToClaudeCodeExecutable: fakeClaude,
      cwd: dir,
      sessionId: session.nativeSessionId,
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
    });
    // Omitted so Claude Code applies the user's own settings and permission mode.
    expect(lastOptions).not.toHaveProperty("settingSources");
    expect(lastOptions).not.toHaveProperty("permissionMode");
  });

  it("resumes by session id", async () => {
    const { session } = await start("11111111-2222-3333-4444-555555555555");
    expect(session.nativeSessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(lastOptions).toMatchObject({ resume: "11111111-2222-3333-4444-555555555555" });
    expect(lastOptions).not.toHaveProperty("sessionId");
  });
});

describe("ClaudeSession", () => {
  it("streams text and assembles a message delivered block by block", async () => {
    const { session, events } = await start();
    expect(await session.sendPrompt("hello")).toBe("started");
    expect(await settled(events)).toEqual({ type: "run_settled", aborted: false });
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" && event.delta)).toEqual(["Hi ", "there"]);
    expect(events.findLast((event) => event.type === "message_completed")).toMatchObject({ messageId: "m1", text: "Hi there" });
  });

  it("asks for tool approval and offers allow-always when Claude suggests a rule", async () => {
    const { session, events } = await start();
    await session.sendPrompt("tool");
    const request = await waitFor(events, (event) => event.type === "input_requested");
    expect(request).toMatchObject({
      kind: "approval",
      title: "Claude wants to run ls",
      tool: { name: "Bash", input: { command: "ls" } },
      allowAlways: true,
    });
    if (request.type !== "input_requested") throw new Error("unreachable");
    await session.respondToInput(request.requestId, { kind: "approval", decision: "allow_always" });
    await settled(events);
    const finished = events.find((event) => event.type === "tool_finished");
    expect(finished).toMatchObject({ toolCallId: "t1", isError: false });
    const decision = JSON.parse(finished?.type === "tool_finished" ? finished.output : "{}");
    expect(decision).toMatchObject({ behavior: "allow", updatedInput: { command: "ls" }, updatedPermissions: [{ type: "addRules" }] });
  });

  it("passes a denial back to Claude Code", async () => {
    const { session, events } = await start();
    await session.sendPrompt("tool");
    const request = await waitFor(events, (event) => event.type === "input_requested");
    if (request.type !== "input_requested") throw new Error("unreachable");
    await session.respondToInput(request.requestId, { kind: "approval", decision: "deny", message: "not now" });
    await settled(events);
    expect(events.find((event) => event.type === "tool_finished")).toMatchObject({ isError: true });
  });

  it("answers AskUserQuestion with labels keyed by question text", async () => {
    const { session, events } = await start();
    await session.sendPrompt("ask");
    const request = await waitFor(events, (event) => event.type === "input_requested");
    expect(request).toMatchObject({
      kind: "questions",
      questions: [{ id: "Which db?", header: "DB", options: [{ label: "sqlite" }, { label: "postgres" }], multiSelect: false }],
    });
    if (request.type !== "input_requested") throw new Error("unreachable");
    await session.respondToInput(request.requestId, { kind: "answers", answers: { "Which db?": ["sqlite"] } });
    await settled(events);
    const reply = events.findLast((event) => event.type === "message_completed");
    const decision = JSON.parse(reply?.type === "message_completed" ? reply.text : "{}");
    expect(decision).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which db?": "sqlite" } } });
  });

  it("interrupts a turn and keeps the session usable", async () => {
    const { session, events } = await start();
    await session.sendPrompt("slow");
    await waitFor(events, (event) => event.type === "text_delta");
    await expect(session.sendPrompt("again")).rejects.toThrow(/already working/);
    await session.interrupt();
    expect(await settled(events)).toEqual({ type: "run_settled", aborted: true });
    events.length = 0;
    expect(await session.sendPrompt("hello")).toBe("started");
    await settled(events);
  });

  it("reports a failed turn", async () => {
    const { session, events } = await start();
    await session.sendPrompt("fail");
    expect(await settled(events)).toEqual({ type: "run_settled", aborted: false, error: "API Error: 529 overloaded" });
  });

  it("reports an unexpected end of the Claude Code process", async () => {
    const { session, events } = await start();
    await expect(session.sendPrompt("boom")).rejects.toThrow(/process crashed/);
    expect(await waitFor(events, (event) => event.type === "process_exited")).toEqual({
      type: "process_exited",
      code: null,
      signal: null,
      expected: false,
    });
  });

  it("closes cleanly by ending the input stream", async () => {
    const { session, events } = await start();
    await session.close();
    expect(events).toEqual([{ type: "process_exited", code: null, signal: null, expected: true }]);
  });
});
