import { capOutput, JsonlChildProcess, type AgentSession, type PromptDisposition } from "@away/adapter-core";
import type { AgentEvent, InputResponse } from "@away/protocol";
import { contentText, PiRecordSchemas, PiStateSchema, type PiRecord, type PiRecordType } from "./records.ts";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface PiSessionOptions {
  command: string;
  cwd: string;
  resumeSessionId?: string;
  /** Run without persisting a Pi session (`--no-session`). Used for smoke tests. */
  ephemeral?: boolean;
  startupTimeoutMs: number;
  closeTimeoutMs: number;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

export class PiSession implements AgentSession {
  #process!: JsonlChildProcess;
  #listeners = new Set<(event: AgentEvent) => void>();
  #pending = new Map<string, PendingRequest>();
  #nextRequestId = 0;
  #nextMessageId = 0;
  #currentAssistantMessageId: string | undefined;
  #running = false;
  #closing = false;
  #nativeSessionId: string | undefined;

  private constructor() {}

  static async start(options: PiSessionOptions): Promise<PiSession> {
    const args = ["--mode", "rpc"];
    if (options.resumeSessionId) args.push("--session", options.resumeSessionId);
    if (options.ephemeral) args.push("--no-session");

    const session = new PiSession();
    session.#process = await JsonlChildProcess.spawn({
      command: options.command,
      args,
      cwd: options.cwd,
      closeTimeoutMs: options.closeTimeoutMs,
      onRecord: (record) => session.#handleRecordValue(record),
      onExit: (code, signal) => {
        const error = new Error(`Pi exited (code ${code}, signal ${signal})`);
        for (const pending of session.#pending.values()) pending.reject(error);
        session.#pending.clear();
        session.#emit({ type: "process_exited", code, signal, expected: session.#closing });
      },
    });
    try {
      const state = PiStateSchema.parse(await session.#request({ type: "get_state" }, options.startupTimeoutMs));
      session.#nativeSessionId = state.sessionId;
      return session;
    } catch (error) {
      await session.close();
      // The stderr tail is for local logs only, so it is kept out of the message clients may see.
      throw Object.assign(new Error(`Pi did not start: ${(error as Error).message}`, { cause: error }), {
        stderrTail: session.stderrTail(),
      });
    }
  }

  get nativeSessionId(): string | undefined {
    return this.#nativeSessionId;
  }

  /** Last lines Pi wrote to stderr. Local diagnostics only; may contain sensitive paths. */
  stderrTail(): string {
    return this.#process.stderrTail();
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async sendPrompt(text: string): Promise<PromptDisposition> {
    const data = await this.#request({ type: "prompt", message: text });
    const disposition = (data as { disposition?: unknown } | undefined)?.disposition;
    if (disposition === "started" || disposition === "queued" || disposition === "handled") return disposition;
    throw new Error(`Pi returned an unknown prompt disposition: ${String(disposition)}`);
  }

  /** Stops the current turn. Pi responds once the session is idle again. */
  async interrupt(): Promise<void> {
    await this.#request({ type: "abort" });
  }

  async respondToInput(requestId: string, response: InputResponse): Promise<void> {
    const record =
      response.kind === "value"
        ? { type: "extension_ui_response", id: requestId, value: response.value }
        : response.kind === "confirm"
          ? { type: "extension_ui_response", id: requestId, confirmed: response.confirmed }
          : { type: "extension_ui_response", id: requestId, cancelled: true };
    await this.#write(record);
  }

  /** Ends the Pi process: closes stdin (Pi's orderly shutdown), then escalates to signals. */
  async close(): Promise<void> {
    this.#closing = true;
    await this.#process.close();
  }

  async #request(command: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const id = `away-${++this.#nextRequestId}`;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      if (timeoutMs !== undefined) {
        setTimeout(() => {
          if (this.#pending.delete(id)) reject(new Error(`Pi did not answer ${String(command.type)} within ${timeoutMs}ms`));
        }, timeoutMs).unref();
      }
    });
    try {
      await this.#write({ ...command, id });
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return response;
  }

  async #write(record: Record<string, unknown>): Promise<void> {
    await this.#process.write(record);
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #handleRecordValue(record: unknown): void {
    const type = (record as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !(type in PiRecordSchemas)) return;
    const parsed = PiRecordSchemas[type as PiRecordType].safeParse(record);
    if (parsed.success) this.#handleRecord(parsed.data as PiRecord<PiRecordType>);
  }

  #handleRecord(record: PiRecord<PiRecordType>): void {
    switch (record.type) {
      case "response":
        return this.#handleResponse(record as PiRecord<"response">);
      case "extension_ui_request":
        return this.#handleUiRequest(record as PiRecord<"extension_ui_request">);
      case "agent_start":
        // Retries and queued follow-ups start further low-level runs; report one run until settled.
        if (!this.#running) {
          this.#running = true;
          this.#emit({ type: "run_started" });
        }
        return;
      case "agent_settled":
        this.#running = false;
        this.#emit({ type: "run_settled", aborted: (record as PiRecord<"agent_settled">).aborted });
        return;
      case "message_start": {
        const { message } = record as PiRecord<"message_start">;
        if (message.role === "assistant") {
          this.#currentAssistantMessageId = `pi-msg-${++this.#nextMessageId}`;
          this.#emit({ type: "assistant_message_started", messageId: this.#currentAssistantMessageId });
        }
        return;
      }
      case "message_update": {
        const { assistantMessageEvent: update } = record as PiRecord<"message_update">;
        const messageId = this.#currentAssistantMessageId;
        if (!messageId || update.delta === undefined || update.contentIndex === undefined) return;
        if (update.type === "text_delta" || update.type === "thinking_delta") {
          this.#emit({ type: update.type, messageId, blockIndex: update.contentIndex, delta: update.delta });
        }
        return;
      }
      case "message_end": {
        const { message } = record as PiRecord<"message_end">;
        if (message.role === "assistant") {
          const messageId = this.#currentAssistantMessageId ?? `pi-msg-${++this.#nextMessageId}`;
          this.#currentAssistantMessageId = undefined;
          this.#emit({
            type: "message_completed",
            messageId,
            role: "assistant",
            text: contentText(message.content),
            ...(message.stopReason !== undefined && { stopReason: message.stopReason }),
            ...(message.errorMessage !== undefined && { errorMessage: message.errorMessage }),
          });
        } else if (message.role === "user") {
          this.#emit({
            type: "message_completed",
            messageId: `pi-msg-${++this.#nextMessageId}`,
            role: "user",
            text: contentText(message.content),
          });
        }
        return;
      }
      case "tool_execution_start": {
        const { toolCallId, toolName, args } = record as PiRecord<"tool_execution_start">;
        this.#emit({ type: "tool_started", toolCallId, toolName, args });
        return;
      }
      case "tool_execution_update": {
        const { toolCallId, partialResult } = record as PiRecord<"tool_execution_update">;
        this.#emit({ type: "tool_updated", toolCallId, ...capOutput(contentText(partialResult?.content)) });
        return;
      }
      case "tool_execution_end": {
        const { toolCallId, result, isError } = record as PiRecord<"tool_execution_end">;
        this.#emit({ type: "tool_finished", toolCallId, isError, ...capOutput(contentText(result?.content)) });
        return;
      }
      case "auto_retry_start": {
        const { attempt, maxAttempts, errorMessage } = record as PiRecord<"auto_retry_start">;
        const reason = errorMessage ? `: ${errorMessage}` : "";
        this.#emit({ type: "notice", level: "warning", message: `Retrying (${attempt}/${maxAttempts})${reason}` });
        return;
      }
      case "auto_retry_end": {
        const { success, finalError } = record as PiRecord<"auto_retry_end">;
        if (!success) this.#emit({ type: "notice", level: "error", message: `Retries failed: ${finalError ?? "unknown error"}` });
        return;
      }
      case "compaction_start":
        this.#emit({ type: "notice", level: "info", message: "Compacting conversation context" });
        return;
      case "compaction_end": {
        const { errorMessage } = record as PiRecord<"compaction_end">;
        if (errorMessage) this.#emit({ type: "notice", level: "error", message: `Compaction failed: ${errorMessage}` });
        return;
      }
      case "extension_error": {
        const { error } = record as PiRecord<"extension_error">;
        this.#emit({ type: "notice", level: "error", message: `Pi extension error: ${error}` });
        return;
      }
    }
  }

  #handleResponse(record: PiRecord<"response">): void {
    if (!record.id) return;
    const pending = this.#pending.get(record.id);
    if (!pending) return;
    this.#pending.delete(record.id);
    if (record.success) pending.resolve(record.data);
    else pending.reject(new Error(record.error ?? `Pi rejected ${record.command}`));
  }

  #handleUiRequest(record: PiRecord<"extension_ui_request">): void {
    if (DIALOG_METHODS.has(record.method)) {
      this.#emit({
        type: "input_requested",
        requestId: record.id,
        kind: record.method as "select" | "confirm" | "input" | "editor",
        title: record.title ?? "",
        ...(record.message !== undefined && { message: record.message }),
        ...(record.options !== undefined && { options: record.options }),
        ...(record.placeholder !== undefined && { placeholder: record.placeholder }),
        ...(record.prefill !== undefined && { prefill: record.prefill }),
        ...(record.timeout !== undefined && { timeoutMs: record.timeout }),
      });
    } else if (record.method === "notify" && record.message) {
      this.#emit({ type: "notice", level: record.notifyType ?? "info", message: record.message });
    }
    // Status, widget, title and editor-text updates are terminal UI hints; Away ignores them.
  }
}
