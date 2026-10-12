import type { AgentAdapter, AgentSession } from "@away/adapter-core";
import {
  FINAL_COMMAND_STATUSES,
  type AgentEvent,
  type AgentInfo,
  type Command,
  type CommandStatus,
  type ServerMessage,
  type SessionEvent,
  type SessionStatus,
  type SessionSummary,
} from "@away/protocol";
import type { CommandRecord, SessionRow, Store } from "./store.ts";

/** Where the session manager sends messages. Implemented by the device server. */
export interface Outbox {
  /** Every open connection of one paired device. */
  toDevice(deviceId: string, message: ServerMessage): void;
  /** Every open connection of every device. */
  toAll(message: ServerMessage): void;
}

/** A connection that can subscribe to session events. */
export interface Subscriber {
  send(message: ServerMessage): void;
}

interface ActivePrompt {
  deviceId: string;
  commandId: string;
  accepted: boolean;
  final: boolean;
  /** Stop reason and error of the last assistant message in this run. */
  lastStopReason?: string;
  lastError?: string;
}

interface LiveSession {
  agentSession: AgentSession;
  adapter: AgentAdapter;
  activePrompt?: ActivePrompt | undefined;
  pendingInputs: Set<string>;
}

type Log = (message: string) => void;

export class SessionManager {
  #store: Store;
  #adapters: Map<string, AgentAdapter>;
  #outbox: Outbox;
  #log: Log;
  #live = new Map<string, LiveSession>();
  /** Sessions whose agent process is being started, to refuse a concurrent second start. */
  #starting = new Set<string>();
  #shuttingDown = false;
  #subscribers = new Map<string, Set<Subscriber>>();

  constructor(store: Store, adapters: AgentAdapter[], outbox: Outbox, log: Log = () => {}) {
    this.#store = store;
    this.#adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.#outbox = outbox;
    this.#log = log;
  }

  /**
   * Runs a command at most once per (device, command id). A repeated id is answered with the
   * stored status, so clients can safely resend after reconnecting.
   */
  async execute(deviceId: string, commandId: string, command: Command): Promise<void> {
    const sessionId = "sessionId" in command ? command.sessionId : undefined;
    if (!this.#store.insertCommand(deviceId, commandId, command.kind, sessionId)) {
      const record = this.#store.getCommand(deviceId, commandId);
      if (record) this.#outbox.toDevice(deviceId, statusMessage(commandId, record));
      return;
    }
    this.#outbox.toDevice(deviceId, { type: "command_status", commandId, status: "received" });

    try {
      if (command.kind === "send_prompt") return await this.#sendPrompt(deviceId, commandId, command.sessionId, command.text);
      const result = await this.#run(command);
      this.#finish(deviceId, commandId, { status: "completed", ...(result !== undefined && { result }) });
    } catch (error) {
      this.#finish(deviceId, commandId, { status: "failed", error: (error as Error).message });
    }
  }

  /** Sends stored events after `afterSeq`, then live events. No gap or overlap is possible. */
  subscribe(subscriber: Subscriber, sessionId: string, afterSeq: number): void {
    const row = this.#store.getSession(sessionId);
    if (!row) return subscriber.send({ type: "error", message: `Unknown session ${sessionId}` });
    // Store reads and sends are synchronous, so no new event can interleave before registration.
    for (const stored of this.#store.eventsAfter(sessionId, afterSeq)) {
      subscriber.send({ type: "session_event", sessionId, ...stored });
    }
    subscriber.send({ type: "subscribed", sessionId, lastSeq: this.#store.getSession(sessionId)!.lastSeq });
    let set = this.#subscribers.get(sessionId);
    if (!set) this.#subscribers.set(sessionId, (set = new Set()));
    set.add(subscriber);
  }

  unsubscribe(subscriber: Subscriber, sessionId?: string): void {
    if (sessionId) return void this.#subscribers.get(sessionId)?.delete(subscriber);
    for (const set of this.#subscribers.values()) set.delete(subscriber);
  }

  /** Ends every agent process. Used when Away itself shuts down. */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    await Promise.all([...this.#live.keys()].map((id) => this.#closeSession(id)));
  }

  async #run(command: Exclude<Command, { kind: "send_prompt" }>): Promise<unknown> {
    switch (command.kind) {
      case "list_agents":
        return this.#listAgents();
      case "list_projects":
        return this.#store.listProjects();
      case "list_sessions":
        return this.#store.listSessions().map((row) => this.#summary(row));
      case "start_session":
        return this.#startSession(command.agent, command.projectId);
      case "resume_session":
        return this.#resumeSession(command.sessionId);
      case "interrupt": {
        const live = this.#requireLive(command.sessionId);
        if (!live.adapter.capabilities.interrupt) throw new Error(`${live.adapter.displayName} cannot interrupt a turn`);
        await live.agentSession.interrupt();
        return undefined;
      }
      case "respond_input": {
        const live = this.#requireLive(command.sessionId);
        if (!live.pendingInputs.delete(command.requestId)) throw new Error("This question was already answered or expired");
        await live.agentSession.respondToInput(command.requestId, command.response);
        return undefined;
      }
      case "close_session":
        await this.#closeSession(command.sessionId);
        return undefined;
    }
  }

  async #listAgents(): Promise<AgentInfo[]> {
    return Promise.all(
      [...this.#adapters.values()].map(async (adapter) => {
        const availability = await adapter.detect();
        return {
          id: adapter.id,
          displayName: adapter.displayName,
          capabilities: adapter.capabilities,
          installed: availability.installed,
          supported: availability.supported,
          ...(availability.version !== undefined && { version: availability.version }),
          ...(availability.reason !== undefined && { reason: availability.reason }),
        };
      }),
    );
  }

  async #startSession(agent: string, projectId: string): Promise<SessionSummary> {
    const adapter = this.#adapters.get(agent);
    if (!adapter) throw new Error(`Unknown agent ${agent}`);
    const project = this.#store.getProject(projectId);
    if (!project) throw new Error("Unknown project. Projects are added on the laptop.");
    const row = this.#store.createSession(agent, projectId);
    await this.#launch(row.id, adapter, project.path);
    return this.#summary(this.#store.getSession(row.id)!);
  }

  async #resumeSession(sessionId: string): Promise<SessionSummary> {
    const row = this.#store.getSession(sessionId);
    if (!row) throw new Error("Unknown session");
    if (this.#live.has(sessionId) || this.#starting.has(sessionId)) throw new Error("Session is already running");
    const adapter = this.#adapters.get(row.agent);
    if (!adapter?.capabilities.resume) throw new Error(`${adapter?.displayName ?? row.agent} cannot resume sessions`);
    if (!row.nativeSessionId) throw new Error("The agent did not report a session id to resume");
    const project = this.#store.getProject(row.projectId);
    if (!project) throw new Error("Unknown project");
    this.#setStatus(sessionId, "starting");
    await this.#launch(sessionId, adapter, project.path, row.nativeSessionId);
    return this.#summary(this.#store.getSession(sessionId)!);
  }

  async #launch(sessionId: string, adapter: AgentAdapter, cwd: string, resumeSessionId?: string): Promise<void> {
    this.#broadcastSummary(sessionId);
    let agentSession: AgentSession;
    this.#starting.add(sessionId);
    try {
      agentSession = await adapter.startSession({ cwd, ...(resumeSessionId !== undefined && { resumeSessionId }) });
    } catch (error) {
      const tail = (error as { stderrTail?: string }).stderrTail;
      this.#log(`${adapter.displayName} failed to start: ${(error as Error).message}${tail ? `\n${tail}` : ""}`);
      this.#setStatus(sessionId, "ended");
      throw error;
    } finally {
      this.#starting.delete(sessionId);
    }
    const live: LiveSession = { agentSession, adapter, pendingInputs: new Set() };
    this.#live.set(sessionId, live);
    this.#store.updateSession(sessionId, { nativeSessionId: agentSession.nativeSessionId ?? null });
    agentSession.onEvent((event) => this.#onAgentEvent(sessionId, live, event));
    this.#setStatus(sessionId, "idle");
  }

  async #sendPrompt(deviceId: string, commandId: string, sessionId: string, text: string): Promise<void> {
    const live = this.#requireLive(sessionId);
    // Away does not queue prompts behind running work: a second prompt is refused, not hidden.
    if (live.activePrompt) throw new Error("The agent is busy. Wait for it to finish or interrupt it.");
    const prompt: ActivePrompt = { deviceId, commandId, accepted: false, final: false };
    live.activePrompt = prompt;
    this.#append(sessionId, { type: "prompt_sent", commandId, text });
    this.#setStatus(sessionId, "running");

    let disposition;
    try {
      disposition = await live.agentSession.sendPrompt(text);
    } catch (error) {
      this.#endPrompt(sessionId, live, { status: "failed", error: (error as Error).message });
      return;
    }
    if (prompt.final) return;
    if (disposition === "handled") this.#endPrompt(sessionId, live, { status: "completed" });
    else this.#markAccepted(prompt);
  }

  /**
   * Records that the agent took the prompt. Called on the agent's acceptance response or its
   * run_started event, whichever is processed first, so `accepted` always precedes the final status.
   */
  #markAccepted(prompt: ActivePrompt): void {
    if (prompt.accepted || prompt.final) return;
    prompt.accepted = true;
    this.#store.updateCommand(prompt.deviceId, prompt.commandId, { status: "accepted" });
    this.#outbox.toDevice(prompt.deviceId, { type: "command_status", commandId: prompt.commandId, status: "accepted" });
  }

  #onAgentEvent(sessionId: string, live: LiveSession, event: AgentEvent): void {
    this.#append(sessionId, event);
    const prompt = live.activePrompt;
    switch (event.type) {
      case "input_requested":
        live.pendingInputs.add(event.requestId);
        break;
      case "input_resolved":
        live.pendingInputs.delete(event.requestId);
        break;
      case "message_completed":
        if (prompt && event.role === "assistant") {
          if (event.stopReason !== undefined) prompt.lastStopReason = event.stopReason;
          if (event.errorMessage !== undefined) prompt.lastError = event.errorMessage;
        }
        break;
      case "run_started":
        if (prompt) this.#markAccepted(prompt);
        this.#setStatus(sessionId, "running");
        break;
      case "run_settled":
        // Agents may resolve open questions on their own (for example on timeout).
        live.pendingInputs.clear();
        if (prompt) {
          if (event.aborted) this.#endPrompt(sessionId, live, { status: "interrupted" });
          else if (event.error !== undefined) this.#endPrompt(sessionId, live, { status: "failed", error: event.error });
          else if (prompt.lastStopReason === "error") {
            this.#endPrompt(sessionId, live, { status: "failed", error: prompt.lastError ?? "The agent reported an error" });
          } else this.#endPrompt(sessionId, live, { status: "completed" });
        } else this.#setStatus(sessionId, "idle");
        break;
      case "process_exited":
        this.#live.delete(sessionId);
        if (prompt) {
          const error = this.#shuttingDown ? "Away was stopped while the agent was working" : "The agent process exited";
          this.#endPrompt(sessionId, live, { status: "failed", error });
        }
        if (!event.expected) this.#log(`${live.adapter.displayName} exited unexpectedly (code ${event.code})`);
        this.#setStatus(sessionId, "ended");
        break;
    }
  }

  #endPrompt(sessionId: string, live: LiveSession, record: CommandRecord): void {
    const prompt = live.activePrompt;
    if (!prompt || prompt.final) return;
    prompt.final = true;
    live.activePrompt = undefined;
    this.#finish(prompt.deviceId, prompt.commandId, record);
    if (this.#live.has(sessionId)) this.#setStatus(sessionId, "idle");
  }

  async #closeSession(sessionId: string): Promise<void> {
    await this.#requireLive(sessionId).agentSession.close();
  }

  #requireLive(sessionId: string): LiveSession {
    const live = this.#live.get(sessionId);
    if (!live) throw new Error(this.#store.getSession(sessionId) ? "Session is not running" : "Unknown session");
    return live;
  }

  #finish(deviceId: string, commandId: string, record: CommandRecord): void {
    if (!FINAL_COMMAND_STATUSES.has(record.status)) throw new Error(`${record.status} is not final`);
    this.#store.updateCommand(deviceId, commandId, record);
    this.#outbox.toDevice(deviceId, statusMessage(commandId, record));
  }

  #append(sessionId: string, event: SessionEvent): void {
    const stored = this.#store.appendEvent(sessionId, event);
    const message: ServerMessage = { type: "session_event", sessionId, ...stored };
    for (const subscriber of this.#subscribers.get(sessionId) ?? []) subscriber.send(message);
  }

  #setStatus(sessionId: string, status: SessionStatus): void {
    if (this.#store.getSession(sessionId)?.status === status) return;
    this.#store.updateSession(sessionId, { status });
    this.#append(sessionId, { type: "session_status", status });
    this.#broadcastSummary(sessionId);
  }

  #broadcastSummary(sessionId: string): void {
    const row = this.#store.getSession(sessionId);
    if (row) this.#outbox.toAll({ type: "session_updated", session: this.#summary(row) });
  }

  #summary(row: SessionRow): SessionSummary {
    const activeCommandId = this.#live.get(row.id)?.activePrompt?.commandId;
    return {
      id: row.id,
      agent: row.agent,
      projectId: row.projectId,
      projectName: this.#store.getProject(row.projectId)?.name ?? "unknown",
      status: row.status,
      lastSeq: row.lastSeq,
      createdAt: row.createdAt,
      ...(row.nativeSessionId !== null && { nativeSessionId: row.nativeSessionId }),
      ...(activeCommandId !== undefined && { activeCommandId }),
    };
  }
}

function statusMessage(commandId: string, record: CommandRecord): ServerMessage {
  return {
    type: "command_status",
    commandId,
    status: record.status satisfies CommandStatus,
    ...(record.result !== undefined && { result: record.result }),
    ...(record.error !== undefined && { error: record.error }),
  };
}
