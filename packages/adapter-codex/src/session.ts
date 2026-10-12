import { capOutput, JsonlChildProcess, type AgentSession, type PromptDisposition } from "@away/adapter-core";
import type { AgentEvent, InputResponse } from "@away/protocol";
import {
  AccountResponseSchema,
  CommandApprovalParamsSchema,
  FileChangeApprovalParamsSchema,
  NotificationSchemas,
  ThreadItemSchema,
  ThreadResponseSchema,
  TurnResponseSchema,
  UserInputRequestParamsSchema,
  type NotificationMethod,
  type ThreadItem,
} from "./records.ts";

/**
 * Drives `codex app-server`: JSON-RPC 2.0 over stdio as JSONL, with the "jsonrpc" field omitted
 * on the wire. Codex sends approval and question *requests* to us; we answer them by id.
 */

export interface CodexSessionOptions {
  command: string;
  cwd: string;
  resumeSessionId?: string;
  /** Keep the thread out of ~/.codex/sessions. Used for smoke tests. */
  ephemeral?: boolean;
  startupTimeoutMs: number;
  closeTimeoutMs: number;
}

type RpcId = string | number;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/** A request from Codex waiting for the user. */
interface ServerRequest {
  rpcId: RpcId;
  method: string;
}

const CLIENT_INFO = { name: "away", title: "Away", version: "0.0.0" };

export class CodexSession implements AgentSession {
  #process!: JsonlChildProcess;
  #listeners = new Set<(event: AgentEvent) => void>();
  #pending = new Map<string, PendingRequest>();
  #serverRequests = new Map<string, ServerRequest>();
  #items = new Map<string, ThreadItem>();
  #commandOutput = new Map<string, string>();
  #nextRequestId = 0;
  #threadId = "";
  /**
   * The turn in progress. `id` is unknown until turn/start answers, and Codex may report the
   * turn's start or even its completion before that answer is processed.
   */
  #turn: { id?: string; started: boolean } | undefined;
  #closing = false;

  private constructor() {}

  static async start(options: CodexSessionOptions): Promise<CodexSession> {
    const session = new CodexSession();
    session.#process = await JsonlChildProcess.spawn({
      command: options.command,
      args: ["app-server"],
      cwd: options.cwd,
      closeTimeoutMs: options.closeTimeoutMs,
      onRecord: (record) => session.#handleRecord(record),
      onExit: (code, signal) => {
        const error = new Error(`Codex exited (code ${code}, signal ${signal})`);
        for (const pending of session.#pending.values()) pending.reject(error);
        session.#pending.clear();
        session.#emit({ type: "process_exited", code, signal, expected: session.#closing });
      },
    });
    try {
      await session.#request("initialize", { clientInfo: CLIENT_INFO }, options.startupTimeoutMs);
      await session.#process.write({ method: "initialized" });

      const account = AccountResponseSchema.parse(await session.#request("account/read", {}, options.startupTimeoutMs));
      if (!account.account && account.requiresOpenaiAuth) {
        throw new Error("Codex is not logged in. Run `codex login` on the laptop.");
      }

      // Only cwd is set, so model, approval policy, and sandbox come from the user's config.toml.
      const thread = ThreadResponseSchema.parse(
        options.resumeSessionId
          ? await session.#request("thread/resume", { threadId: options.resumeSessionId }, options.startupTimeoutMs)
          : await session.#request(
              "thread/start",
              { cwd: options.cwd, ...(options.ephemeral && { ephemeral: true }) },
              options.startupTimeoutMs,
            ),
      );
      session.#threadId = thread.thread.id;
      return session;
    } catch (error) {
      await session.close();
      throw Object.assign(new Error(`Codex did not start: ${(error as Error).message}`, { cause: error }), {
        stderrTail: session.#process.stderrTail(),
      });
    }
  }

  get nativeSessionId(): string {
    return this.#threadId;
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async sendPrompt(text: string): Promise<PromptDisposition> {
    // turn/start on an active turn would steer it; Away refuses instead of silently merging prompts.
    if (this.#turn) throw new Error("Codex is already working on a turn");
    const turn: { id?: string; started: boolean } = { started: false };
    this.#turn = turn;
    let response;
    try {
      response = TurnResponseSchema.parse(
        await this.#request("turn/start", { threadId: this.#threadId, input: [{ type: "text", text, text_elements: [] }] }),
      );
    } catch (error) {
      if (this.#turn === turn) this.#turn = undefined;
      throw error;
    }
    // Still the current turn unless it already completed while the response was in flight.
    if (this.#turn === turn) {
      turn.id = response.turn.id;
      this.#markStarted(turn);
    }
    return "started";
  }

  async interrupt(): Promise<void> {
    const turnId = this.#turn?.id;
    if (!turnId) return;
    await this.#request("turn/interrupt", { threadId: this.#threadId, turnId });
  }

  #markStarted(turn: { started: boolean }): void {
    if (turn.started) return;
    turn.started = true;
    this.#emit({ type: "run_started" });
  }

  async respondToInput(requestId: string, response: InputResponse): Promise<void> {
    const request = this.#serverRequests.get(requestId);
    if (!request) throw new Error("Codex is no longer waiting for this request");
    const result = toCodexResponse(request.method, response);
    this.#serverRequests.delete(requestId);
    await this.#process.write({ id: request.rpcId, result });
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#process.close();
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  async #request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = `away-${++this.#nextRequestId}`;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      if (timeoutMs !== undefined) {
        setTimeout(() => {
          if (this.#pending.delete(id)) reject(new Error(`Codex did not answer ${method} within ${timeoutMs}ms`));
        }, timeoutMs).unref();
      }
    });
    try {
      await this.#process.write({ method, id, params });
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return response;
  }

  #handleRecord(record: unknown): void {
    if (typeof record !== "object" || record === null) return;
    const message = record as { id?: RpcId; method?: unknown; params?: unknown; result?: unknown; error?: { message?: string } };
    if (typeof message.method === "string") {
      if (message.id !== undefined) return this.#handleServerRequest(message.id, message.method, message.params);
      return this.#handleNotification(message.method, message.params);
    }
    // Codex numbers its own requests separately, so only ids we issued are matched here.
    if (typeof message.id !== "string") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "Codex returned an error"));
    else pending.resolve(message.result);
  }

  #handleServerRequest(rpcId: RpcId, method: string, params: unknown): void {
    const requestId = `codex-${rpcId}`;
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const parsed = CommandApprovalParamsSchema.safeParse(params);
        if (!parsed.success) break;
        const { command, cwd, reason } = parsed.data;
        this.#serverRequests.set(requestId, { rpcId, method });
        this.#emit({
          type: "input_requested",
          requestId,
          kind: "approval",
          title: "Run this command?",
          ...(reason ? { message: reason } : {}),
          tool: { name: "command", input: { command, cwd } },
          allowAlways: true,
        });
        return;
      }
      case "item/fileChange/requestApproval": {
        const parsed = FileChangeApprovalParamsSchema.safeParse(params);
        if (!parsed.success) break;
        const item = this.#items.get(parsed.data.itemId);
        const changes = item?.type === "fileChange" ? item.changes.map(({ path, kind }) => ({ path, kind: kind.type })) : [];
        this.#serverRequests.set(requestId, { rpcId, method });
        this.#emit({
          type: "input_requested",
          requestId,
          kind: "approval",
          title: "Apply these file changes?",
          ...(parsed.data.reason ? { message: parsed.data.reason } : {}),
          tool: { name: "file_change", input: { changes } },
          allowAlways: true,
        });
        return;
      }
      case "item/tool/requestUserInput": {
        const parsed = UserInputRequestParamsSchema.safeParse(params);
        if (!parsed.success) break;
        this.#serverRequests.set(requestId, { rpcId, method });
        this.#emit({
          type: "input_requested",
          requestId,
          kind: "questions",
          title: "Codex has a question",
          questions: parsed.data.questions.map((question) => ({
            id: question.id,
            header: question.header,
            question: question.question,
            options: (question.options ?? []).map(({ label, description }) => ({ label, description })),
            multiSelect: false,
            allowOther: question.isOther || !question.options?.length,
          })),
        });
        return;
      }
      case "mcpServer/elicitation/request":
        // Away cannot render MCP elicitation forms yet; declining lets the tool continue or fail cleanly.
        this.#emit({ type: "notice", level: "warning", message: "Declined an MCP server's request for input (not supported in Away yet)" });
        void this.#process.write({ id: rpcId, result: { action: "decline", content: null, _meta: null } });
        return;
    }
    this.#emit({ type: "notice", level: "warning", message: `Codex asked for something Away does not support yet (${method})` });
    void this.#process.write({ id: rpcId, error: { code: -32601, message: `Away does not support ${method}` } });
  }

  #handleNotification(method: string, params: unknown): void {
    if (!(method in NotificationSchemas)) return;
    const parsed = NotificationSchemas[method as NotificationMethod].safeParse(params);
    if (!parsed.success) return;
    const data = parsed.data as { item?: unknown; itemId?: string; delta?: string };
    switch (method as NotificationMethod) {
      case "item/started":
        return this.#onItem(data.item, "started");
      case "item/completed":
        return this.#onItem(data.item, "completed");
      case "item/agentMessage/delta":
        return this.#emit({ type: "text_delta", messageId: data.itemId!, blockIndex: 0, delta: data.delta! });
      case "item/reasoning/summaryTextDelta":
        return this.#emit({ type: "thinking_delta", messageId: data.itemId!, blockIndex: 0, delta: data.delta! });
      case "item/commandExecution/outputDelta": {
        const output = (this.#commandOutput.get(data.itemId!) ?? "") + data.delta!;
        this.#commandOutput.set(data.itemId!, output);
        return this.#emit({ type: "tool_updated", toolCallId: data.itemId!, ...capOutput(output) });
      }
      case "turn/started":
        if (this.#turn) this.#markStarted(this.#turn);
        return;
      case "turn/completed": {
        const turn = (parsed.data as { turn: { id: string; status: string; error?: { message: string } | null } }).turn;
        const current = this.#turn;
        if (!current || (current.id !== undefined && current.id !== turn.id)) return;
        this.#markStarted(current);
        this.#turn = undefined;
        for (const requestId of this.#serverRequests.keys()) this.#emit({ type: "input_resolved", requestId });
        this.#serverRequests.clear();
        this.#items.clear();
        this.#commandOutput.clear();
        this.#emit({
          type: "run_settled",
          aborted: turn.status === "interrupted",
          ...(turn.status === "failed" && { error: turn.error?.message ?? "Codex reported a failed turn" }),
        });
        return;
      }
      case "error": {
        const { error, willRetry } = parsed.data as { error: { message: string }; willRetry: boolean };
        return this.#emit({
          type: "notice",
          level: willRetry ? "warning" : "error",
          message: willRetry ? `Retrying: ${error.message}` : error.message,
        });
      }
      case "serverRequest/resolved": {
        // Sent whether we answered or Codex cleared the request itself (for example on interrupt).
        const requestId = `codex-${(parsed.data as { requestId: RpcId }).requestId}`;
        this.#serverRequests.delete(requestId);
        this.#emit({ type: "input_resolved", requestId });
        return;
      }
    }
  }

  #onItem(raw: unknown, phase: "started" | "completed"): void {
    const parsed = ThreadItemSchema.safeParse(raw);
    if (!parsed.success) return;
    const item = parsed.data;
    if (phase === "started") this.#items.set(item.id, item);
    switch (item.type) {
      case "userMessage":
        if (phase === "completed") {
          const text = item.content.map((input) => input.text ?? "").join("");
          this.#emit({ type: "message_completed", messageId: item.id, role: "user", text });
        }
        return;
      case "agentMessage":
        if (phase === "started") this.#emit({ type: "assistant_message_started", messageId: item.id });
        else this.#emit({ type: "message_completed", messageId: item.id, role: "assistant", text: item.text });
        return;
      case "commandExecution":
        if (phase === "started") {
          this.#emit({ type: "tool_started", toolCallId: item.id, toolName: "command", args: { command: item.command, cwd: item.cwd } });
        } else {
          const output = item.aggregatedOutput ?? this.#commandOutput.get(item.id) ?? "";
          const isError = item.status !== "completed" || (item.exitCode !== null && item.exitCode !== 0);
          this.#emit({ type: "tool_finished", toolCallId: item.id, isError, ...capOutput(statusPrefix(item.status) + output) });
        }
        return;
      case "fileChange": {
        const summary = item.changes.map((change) => `${change.kind.type} ${change.path}`).join("\n");
        if (phase === "started") {
          this.#emit({ type: "tool_started", toolCallId: item.id, toolName: "file_change", args: { changes: item.changes.map(({ path }) => path) } });
        } else {
          const diff = item.changes.map((change) => change.diff).join("\n");
          this.#emit({
            type: "tool_finished",
            toolCallId: item.id,
            isError: item.status !== "completed",
            ...capOutput(`${statusPrefix(item.status)}${summary}\n${diff}`),
          });
        }
        return;
      }
      case "mcpToolCall":
        if (phase === "started") {
          this.#emit({ type: "tool_started", toolCallId: item.id, toolName: `${item.server}.${item.tool}`, args: item.arguments });
        } else {
          const output = item.error ? item.error.message : JSON.stringify(item.result ?? null);
          this.#emit({ type: "tool_finished", toolCallId: item.id, isError: item.status !== "completed", ...capOutput(output) });
        }
        return;
    }
  }
}

function statusPrefix(status: string): string {
  return status === "declined" ? "[declined]\n" : status === "failed" ? "[failed]\n" : "";
}

/** Maps Away's answer to the response shape Codex expects for each request method. */
function toCodexResponse(method: string, response: InputResponse): unknown {
  if (method === "item/tool/requestUserInput") {
    if (response.kind !== "answers") return { answers: {} };
    return {
      answers: Object.fromEntries(Object.entries(response.answers).map(([id, answers]) => [id, { answers }])),
    };
  }
  // Command and file-change approvals share the same decisions.
  if (response.kind === "cancel") return { decision: "cancel" };
  if (response.kind !== "approval") throw new Error("This request needs an approval decision");
  const decision = { allow: "accept", allow_always: "acceptForSession", deny: "decline" }[response.decision];
  return { decision };
}
