import type { AgentCapabilities, AgentEvent, InputResponse } from "@away/protocol";

export interface AgentAvailability {
  installed: boolean;
  /** True when the installed version is one this adapter has been verified against. */
  supported: boolean;
  version?: string;
  reason?: string;
}

export interface StartSessionOptions {
  /** Project folder the agent runs in. Must be explicitly chosen by the user. */
  cwd: string;
  /** Native agent session id to reopen. Requires the `resume` capability. */
  resumeSessionId?: string;
}

export type PromptDisposition =
  /** The agent started a run for this prompt. A `run_settled` event follows. */
  | "started"
  /** The agent queued the prompt behind current work. */
  | "queued"
  /** The agent consumed the prompt without starting a run (for example a slash command). */
  | "handled";

/**
 * One live agent process bound to one native session.
 *
 * Three different "stop" operations exist and must not be confused:
 * - `interrupt()` stops the current turn; the process and session stay alive.
 * - A client disconnecting is not visible here at all; the session keeps running.
 * - `close()` ends the agent process.
 */
export interface AgentSession {
  /** The agent's own session id, if it has one. Used to resume later. */
  readonly nativeSessionId: string | undefined;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /** Resolves once the agent accepted the prompt. Rejects if the agent refused it. */
  sendPrompt(text: string): Promise<PromptDisposition>;
  interrupt(): Promise<void>;
  respondToInput(requestId: string, response: InputResponse): Promise<void>;
  close(): Promise<void>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  detect(): Promise<AgentAvailability>;
  startSession(options: StartSessionOptions): Promise<AgentSession>;
}
