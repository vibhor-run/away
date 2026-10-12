import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { capOutput, type AgentSession, type PromptDisposition } from "@away/adapter-core";
import type { AgentEvent, InputResponse, Question } from "@away/protocol";

/**
 * Drives Claude Code through the official Agent SDK in streaming-input mode: one long-lived
 * Claude Code process per session, prompts pushed as user messages, permission prompts and
 * AskUserQuestion delivered through `canUseTool`.
 */

export type QueryFunction = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

export interface ClaudeSessionOptions {
  query: QueryFunction;
  /** The user's installed `claude` executable, so their version and login are used. */
  executable: string;
  cwd: string;
  resumeSessionId?: string;
  startupTimeoutMs: number;
  closeTimeoutMs: number;
}

const STDERR_TAIL_LINES = 50;

interface PendingInput {
  resolve: (response: InputResponse) => void;
}

export class ClaudeSession implements AgentSession {
  #query!: Query;
  #input = new MessageQueue<SDKUserMessage>();
  #listeners = new Set<(event: AgentEvent) => void>();
  #pendingInputs = new Map<string, PendingInput>();
  #messageText = new Map<string, string[]>();
  #currentMessageId: string | undefined;
  #sessionId: string;
  #running = false;
  #interrupted = false;
  #closing = false;
  #done: Promise<void> = Promise.resolve();
  #stderrTail: string[] = [];
  /** Resolves the in-flight sendPrompt when Claude Code first reacts to it. */
  #awaitingAck: { resolve: () => void; reject: (error: Error) => void } | undefined;

  private constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  static async start(options: ClaudeSessionOptions): Promise<ClaudeSession> {
    // A new session gets an id chosen by us, so it is known before the first prompt.
    const session = new ClaudeSession(options.resumeSessionId ?? randomUUID());
    session.#query = options.query({
      prompt: session.#input,
      options: {
        cwd: options.cwd,
        pathToClaudeCodeExecutable: options.executable,
        ...(options.resumeSessionId ? { resume: options.resumeSessionId } : { sessionId: session.#sessionId }),
        // Match the normal CLI: its system prompt, and all settings sources (user, project, local),
        // which is also the SDK default. permissionMode is left to the user's settings.
        systemPrompt: { type: "preset", preset: "claude_code" },
        includePartialMessages: true,
        canUseTool: (toolName, input, toolOptions) => session.#canUseTool(toolName, input, toolOptions),
        env: { ...stringEnv(process.env), CLAUDE_AGENT_SDK_CLIENT_APP: "away/0.0.0" },
        stderr: (data) => {
          session.#stderrTail.push(...data.split("\n").filter(Boolean));
          session.#stderrTail.splice(0, Math.max(0, session.#stderrTail.length - STDERR_TAIL_LINES));
        },
      },
    });
    session.#done = session.#consume();
    try {
      await withTimeout(session.#query.initializationResult(), options.startupTimeoutMs, "Claude Code did not start in time");
      return session;
    } catch (error) {
      await session.close(options.closeTimeoutMs);
      throw Object.assign(new Error(`Claude Code did not start: ${(error as Error).message}`, { cause: error }), {
        stderrTail: session.stderrTail(),
      });
    }
  }

  get nativeSessionId(): string {
    return this.#sessionId;
  }

  stderrTail(): string {
    return this.#stderrTail.join("\n");
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Resolves once Claude Code starts responding to the prompt, which is when it has accepted it. */
  async sendPrompt(text: string): Promise<PromptDisposition> {
    if (this.#running) throw new Error("Claude Code is already working on a turn");
    if (this.#closing || this.#input.ended) throw new Error("Claude Code session is closed");
    this.#running = true;
    this.#interrupted = false;
    const acknowledged = new Promise<void>((resolve, reject) => (this.#awaitingAck = { resolve, reject }));
    this.#input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    try {
      await acknowledged;
    } catch (error) {
      this.#running = false;
      throw error;
    }
    return "started";
  }

  async interrupt(): Promise<void> {
    if (!this.#running) return;
    this.#interrupted = true;
    await this.#query.interrupt();
  }

  async respondToInput(requestId: string, response: InputResponse): Promise<void> {
    const pending = this.#pendingInputs.get(requestId);
    if (!pending) throw new Error("Claude Code is no longer waiting for this request");
    this.#pendingInputs.delete(requestId);
    this.#emit({ type: "input_resolved", requestId });
    pending.resolve(response);
  }

  /** Ends the input stream (orderly shutdown), then force-closes the Claude Code process. */
  async close(timeoutMs = 5_000): Promise<void> {
    if (this.#closing) return this.#done;
    this.#closing = true;
    for (const [requestId, pending] of this.#pendingInputs) {
      this.#pendingInputs.delete(requestId);
      pending.resolve({ kind: "cancel" });
    }
    this.#input.end();
    const finished = await Promise.race([this.#done.then(() => true), sleep(timeoutMs).then(() => false)]);
    if (!finished) this.#query.close();
    await this.#done;
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  async #consume(): Promise<void> {
    let failure: Error | undefined;
    try {
      for await (const message of this.#query) this.#handle(message);
    } catch (error) {
      failure = error as Error;
      if (!this.#closing) this.#emit({ type: "notice", level: "error", message: `Claude Code stopped: ${failure.message}` });
    }
    this.#awaitingAck?.reject(failure ?? new Error("Claude Code ended the session"));
    this.#awaitingAck = undefined;
    if (this.#running) {
      this.#running = false;
      this.#emit({ type: "run_settled", aborted: this.#closing, ...(!this.#closing && { error: "Claude Code stopped" }) });
    }
    // The SDK does not expose the process exit code.
    this.#emit({ type: "process_exited", code: null, signal: null, expected: this.#closing });
  }

  #handle(message: SDKMessage): void {
    // Informational system messages can trail the previous turn, so only turn output counts as the ack.
    const turnOutput = message.type === "stream_event" || message.type === "assistant" || message.type === "user" || message.type === "result";
    if (turnOutput) this.#acknowledge();
    switch (message.type) {
      case "stream_event": {
        if (message.parent_tool_use_id !== null) return;
        const event = message.event;
        if (event.type === "message_start") {
          this.#emit({ type: "assistant_message_started", messageId: event.message.id });
        } else if (event.type === "content_block_delta") {
          const messageId = this.#currentMessageId ?? "";
          if (event.delta.type === "text_delta") {
            this.#emit({ type: "text_delta", messageId, blockIndex: event.index, delta: event.delta.text });
          } else if (event.delta.type === "thinking_delta") {
            this.#emit({ type: "thinking_delta", messageId, blockIndex: event.index, delta: event.delta.thinking });
          }
        }
        if (event.type === "message_start") this.#currentMessageId = event.message.id;
        return;
      }
      case "assistant": {
        const { id, content, stop_reason } = message.message;
        let textChanged = false;
        for (const block of content) {
          if (block.type === "tool_use") {
            this.#emit({ type: "tool_started", toolCallId: block.id, toolName: block.name, args: block.input });
          } else if (block.type === "text" && message.parent_tool_use_id === null) {
            // Streamed assistant messages usually carry one block each; collect them per message id.
            const blocks = this.#messageText.get(id) ?? [];
            blocks.push(block.text);
            this.#messageText.set(id, blocks);
            textChanged = true;
          }
        }
        if (textChanged || message.error) {
          this.#emit({
            type: "message_completed",
            messageId: id,
            role: "assistant",
            text: (this.#messageText.get(id) ?? []).join(""),
            ...(stop_reason ? { stopReason: stop_reason } : {}),
            ...(message.error ? { errorMessage: String(message.error) } : {}),
          });
        }
        return;
      }
      case "user": {
        const content = message.message.content;
        if (typeof content === "string") return;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const output = typeof block.content === "string" ? block.content : textOf(block.content);
          this.#emit({ type: "tool_finished", toolCallId: block.tool_use_id, isError: block.is_error === true, ...capOutput(output) });
        }
        return;
      }
      case "result": {
        this.#running = false;
        this.#messageText.clear();
        const failed = message.subtype !== "success" || message.is_error;
        const error =
          message.subtype === "success" ? message.result : message.errors.join("; ") || `Claude Code ended the turn (${message.subtype})`;
        this.#emit({
          type: "run_settled",
          aborted: this.#interrupted,
          ...(failed && !this.#interrupted && { error }),
        });
        return;
      }
      case "system":
        if (message.subtype === "api_retry") {
          this.#emit({
            type: "notice",
            level: "warning",
            message: `Retrying API request (${message.attempt}/${message.max_retries})`,
          });
        }
        return;
    }
  }

  /** Marks the in-flight prompt accepted the first time Claude Code acts on it. */
  #acknowledge(): void {
    if (!this.#running || !this.#awaitingAck) return;
    this.#awaitingAck.resolve();
    this.#awaitingAck = undefined;
    this.#emit({ type: "run_started" });
  }

  #canUseTool: CanUseTool = async (toolName, input, options) => {
    // A permission or question request also proves Claude Code is working on the prompt.
    this.#acknowledge();
    const requestId = randomUUID();
    const answered = new Promise<InputResponse>((resolve) => {
      this.#pendingInputs.set(requestId, { resolve });
      options.signal.addEventListener("abort", () => {
        if (!this.#pendingInputs.delete(requestId)) return;
        this.#emit({ type: "input_resolved", requestId });
        resolve({ kind: "cancel" });
      });
    });

    if (toolName === "AskUserQuestion") {
      const questions = parseQuestions(input);
      this.#emit({ type: "input_requested", requestId, kind: "questions", title: "Claude has a question", questions });
      const response = await answered;
      if (response.kind !== "answers") return { behavior: "deny", message: "The user dismissed the question" };
      const answers = Object.fromEntries(questions.map((question) => [question.id, (response.answers[question.id] ?? []).join(", ")]));
      return { behavior: "allow", updatedInput: { ...input, answers } };
    }

    const description = options.description ?? options.decisionReason;
    this.#emit({
      type: "input_requested",
      requestId,
      kind: "approval",
      title: options.title ?? `Allow ${options.displayName ?? toolName}?`,
      ...(description ? { message: description } : {}),
      tool: { name: toolName, input },
      allowAlways: Boolean(options.suggestions?.length) && !options.suppressAlwaysAllowRule,
    });
    return toPermissionResult(await answered, input, options.suggestions);
  };
}

function toPermissionResult(
  response: InputResponse,
  input: Record<string, unknown>,
  suggestions: Parameters<CanUseTool>[2]["suggestions"],
): PermissionResult {
  if (response.kind === "approval") {
    if (response.decision === "allow") return { behavior: "allow", updatedInput: input };
    if (response.decision === "allow_always") {
      return { behavior: "allow", updatedInput: input, ...(suggestions && { updatedPermissions: suggestions }) };
    }
    return { behavior: "deny", message: response.message ?? "Denied from Away" };
  }
  if (response.kind === "cancel") return { behavior: "deny", message: "Cancelled from Away", interrupt: true };
  return { behavior: "deny", message: "Away sent an answer this request does not accept" };
}

/** AskUserQuestion input: 1–4 questions, each identified by its text (sdk-tools.d.ts). */
function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.map((entry: unknown) => {
    const question = entry as { question?: string; header?: string; multiSelect?: boolean; options?: { label?: string; description?: string }[] };
    return {
      id: String(question.question ?? ""),
      ...(question.header ? { header: question.header } : {}),
      question: String(question.question ?? ""),
      options: (question.options ?? []).map((option) => ({
        label: String(option.label ?? ""),
        ...(option.description ? { description: option.description } : {}),
      })),
      multiSelect: question.multiSelect === true,
      allowOther: true,
    };
  });
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : block.type === "image" ? "[image]" : ""))
    .join("");
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms))),
  ]);
}

/** An async iterable fed by push(); the SDK reads prompts from it. */
class MessageQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | undefined;
  ended = false;

  push(item: T): void {
    if (this.ended) throw new Error("Queue has ended");
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = undefined;
      resolve({ value: item, done: false });
    } else this.#items.push(item);
  }

  end(): void {
    this.ended = true;
    this.#waiting?.({ value: undefined, done: true });
    this.#waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.#waiting = resolve));
      },
    };
  }
}
