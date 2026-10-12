import {
  FINAL_COMMAND_STATUSES,
  ServerMessageSchema,
  type ClientMessage,
  type Command,
  type CommandStatus,
  type SessionEvent,
  type SessionSummary,
} from "@away/protocol";
import type { StaticKeyPair, Transport } from "@away/secure-channel";
import type { PairedLaptop } from "./pair.ts";
import { openSecureSocket } from "./secure-socket.ts";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "rejected" | "stopped";

/** `submitted` means stored on this device only; the laptop has not acknowledged it yet. */
export type TrackedStatus = "submitted" | CommandStatus;

export interface TrackedCommand {
  commandId: string;
  command: Command;
  status: TrackedStatus;
  result?: unknown;
  error?: string;
}

export interface SessionEventMessage {
  sessionId: string;
  seq: number;
  at: string;
  event: SessionEvent;
}

export interface AwayClientOptions {
  /** Generates command ids. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
  heartbeatMs?: number;
}

const STATUS_RANK: Record<TrackedStatus, number> = {
  submitted: 0,
  received: 1,
  accepted: 2,
  completed: 3,
  failed: 3,
  interrupted: 3,
};
const PONG_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 10_000;

/**
 * Device-side connection to a paired laptop. Keeps reconnecting until stopped, resends
 * unfinished commands with their original ids (the laptop de-duplicates them), and resumes
 * session subscriptions from the last event seen.
 */
export class AwayClient {
  #laptop: PairedLaptop;
  #keys: StaticKeyPair;
  #newId: () => string;
  #heartbeatMs: number;
  #state: ConnectionState = "disconnected";
  #socket: WebSocket | undefined;
  #transport: Transport | undefined;
  #commands = new Map<string, TrackedCommand>();
  #waiters = new Map<string, ((command: TrackedCommand) => void)[]>();
  #subscriptions = new Map<string, number>();
  #stopped = true;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;
  #nextPing = 0;

  readonly listeners = {
    state: new Set<(state: ConnectionState, detail?: string) => void>(),
    command: new Set<(command: TrackedCommand) => void>(),
    sessionEvent: new Set<(message: SessionEventMessage) => void>(),
    sessionUpdated: new Set<(session: SessionSummary) => void>(),
  };

  constructor(laptop: PairedLaptop, keys: StaticKeyPair, options: AwayClientOptions = {}) {
    this.#laptop = laptop;
    this.#keys = keys;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    this.#teardown();
    this.#setState("stopped");
  }

  /** Simulates a network drop: closes the socket but keeps reconnecting. For testing. */
  dropConnection(): void {
    this.#socket?.close(4000, "dropped");
  }

  /** Queues a command. It is sent now if connected, otherwise after the next reconnect. */
  send(command: Command): TrackedCommand {
    const tracked: TrackedCommand = { commandId: this.#newId(), command, status: "submitted" };
    this.#commands.set(tracked.commandId, tracked);
    this.#emitCommand(tracked);
    this.#sendCommand(tracked);
    return tracked;
  }

  /** Resolves when the command reaches a final status. */
  waitForFinal(commandId: string): Promise<TrackedCommand> {
    const tracked = this.#commands.get(commandId);
    if (tracked && FINAL_COMMAND_STATUSES.has(tracked.status as CommandStatus)) return Promise.resolve(tracked);
    return new Promise((resolve) => {
      const list = this.#waiters.get(commandId) ?? [];
      list.push(resolve);
      this.#waiters.set(commandId, list);
    });
  }

  /** Sends a command and returns its result, throwing if it failed. */
  async request<T = unknown>(command: Command): Promise<T> {
    const final = await this.waitForFinal(this.send(command).commandId);
    if (final.status !== "completed") throw new Error(final.error ?? `Command ${final.status}`);
    return final.result as T;
  }

  /** Follows a session's events from `afterSeq`. Duplicate events are dropped by sequence number. */
  subscribe(sessionId: string, afterSeq = 0): void {
    this.#subscriptions.set(sessionId, Math.max(afterSeq, this.#subscriptions.get(sessionId) ?? 0));
    this.#sendMessage({ type: "subscribe", sessionId, afterSeq: this.#subscriptions.get(sessionId)! });
  }

  unsubscribe(sessionId: string): void {
    this.#subscriptions.delete(sessionId);
    this.#sendMessage({ type: "unsubscribe", sessionId });
  }

  pendingCommands(): TrackedCommand[] {
    return [...this.#commands.values()].filter((command) => !FINAL_COMMAND_STATUSES.has(command.status as CommandStatus));
  }

  async #connect(): Promise<void> {
    this.#setState("connecting");
    let secure;
    try {
      secure = await openSecureSocket(this.#laptop.relayUrl, this.#laptop.laptopId, this.#laptop.laptopKey, this.#keys, {
        type: "connect",
      });
    } catch (error) {
      return this.#afterDisconnect((error as Error).message);
    }
    if (this.#stopped) return void secure.socket.close();
    if (secure.hello.type === "rejected") {
      secure.socket.close();
      this.#stopped = true;
      return this.#setState("rejected", secure.hello.reason);
    }

    this.#socket = secure.socket;
    this.#transport = secure.transport;
    this.#attempt = 0;
    secure.socket.onmessage = (event) => {
      if (typeof event.data === "string") return;
      let plaintext: Uint8Array | undefined;
      try {
        plaintext = this.#transport?.open(new Uint8Array(event.data as ArrayBuffer));
      } catch {
        return this.#socket?.close(4000, "decryption failed");
      }
      if (plaintext) this.#onMessage(plaintext);
    };
    secure.socket.onclose = (event) => {
      if (this.#socket !== secure.socket) return;
      this.#teardown();
      this.#afterDisconnect(event.reason || "connection lost");
    };
    this.#startHeartbeat();
    this.#setState("connected");

    // Resend unfinished commands with their original ids; the laptop answers with stored status.
    for (const tracked of this.pendingCommands()) this.#sendCommand(tracked);
    for (const [sessionId, afterSeq] of this.#subscriptions) this.#sendMessage({ type: "subscribe", sessionId, afterSeq });
  }

  #afterDisconnect(detail: string): void {
    if (this.#stopped) return;
    this.#setState("disconnected", detail);
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.#attempt++);
    this.#reconnectTimer = setTimeout(() => void this.#connect(), delay);
  }

  #teardown(): void {
    clearInterval(this.#heartbeatTimer);
    clearTimeout(this.#pongTimer);
    const socket = this.#socket;
    this.#socket = undefined;
    this.#transport = undefined;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.close();
    }
  }

  #startHeartbeat(): void {
    this.#heartbeatTimer = setInterval(() => {
      this.#sendMessage({ type: "ping", nonce: ++this.#nextPing });
      clearTimeout(this.#pongTimer);
      this.#pongTimer = setTimeout(() => this.#socket?.close(4000, "heartbeat timeout"), PONG_TIMEOUT_MS);
    }, this.#heartbeatMs);
  }

  #onMessage(plaintext: Uint8Array): void {
    let parsed;
    try {
      parsed = ServerMessageSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
    } catch {
      return;
    }
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case "command_status": {
        const tracked = this.#commands.get(message.commandId);
        // Ignore stale or repeated statuses, such as the laptop answering a resent command.
        if (!tracked || STATUS_RANK[message.status] <= STATUS_RANK[tracked.status]) return;
        tracked.status = message.status;
        if (message.result !== undefined) tracked.result = message.result;
        if (message.error !== undefined) tracked.error = message.error;
        this.#emitCommand(tracked);
        if (FINAL_COMMAND_STATUSES.has(message.status)) {
          for (const resolve of this.#waiters.get(tracked.commandId) ?? []) resolve(tracked);
          this.#waiters.delete(tracked.commandId);
        }
        return;
      }
      case "session_event": {
        const lastSeq = this.#subscriptions.get(message.sessionId);
        if (lastSeq === undefined || message.seq <= lastSeq) return;
        this.#subscriptions.set(message.sessionId, message.seq);
        for (const listener of this.listeners.sessionEvent) listener(message);
        return;
      }
      case "session_updated":
        for (const listener of this.listeners.sessionUpdated) listener(message.session);
        return;
      case "pong":
        clearTimeout(this.#pongTimer);
        return;
      case "subscribed":
      case "error":
        return;
    }
  }

  #sendCommand(tracked: TrackedCommand): void {
    this.#sendMessage({ type: "command", commandId: tracked.commandId, command: tracked.command });
  }

  #sendMessage(message: ClientMessage): void {
    if (this.#state !== "connected" || !this.#transport || !this.#socket) return;
    for (const frame of this.#transport.seal(new TextEncoder().encode(JSON.stringify(message)))) this.#socket.send(frame);
  }

  #emitCommand(tracked: TrackedCommand): void {
    for (const listener of this.listeners.command) listener({ ...tracked });
  }

  #setState(state: ConnectionState, detail?: string): void {
    this.#state = state;
    for (const listener of this.listeners.state) listener(state, detail);
  }
}
