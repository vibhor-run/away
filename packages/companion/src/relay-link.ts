import {
  assertRelayUrlAllowed,
  CHANNEL_HEADER_BYTES,
  RelayToLaptopSchema,
  type LaptopToRelay,
} from "@away/protocol";
import { signRelayChallenge, type LaptopIdentity } from "./identity.ts";

export type RelayLinkState = "connecting" | "online" | "offline";

export interface RelayLinkHandlers {
  onChannelOpen(channel: number): void;
  onChannelData(channel: number, frame: Uint8Array): void;
  onChannelClose(channel: number): void;
  onStateChange?(state: RelayLinkState, detail?: string): void;
}

const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * The laptop's outgoing connection to the relay. Reconnects with backoff and detects dead
 * connections with an application-level ping, since a silently dropped network never closes
 * the socket by itself.
 */
export class RelayLink {
  #url: string;
  #identity: LaptopIdentity;
  #handlers: RelayLinkHandlers;
  #socket: WebSocket | undefined;
  #channels = new Set<number>();
  #stopped = false;
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #pingTimer: NodeJS.Timeout | undefined;
  #pongTimer: NodeJS.Timeout | undefined;

  constructor(relayUrl: string, identity: LaptopIdentity, handlers: RelayLinkHandlers) {
    assertRelayUrlAllowed(relayUrl);
    this.#url = new URL("/v1/laptop", relayUrl).toString();
    this.#identity = identity;
    this.#handlers = handlers;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close(1000, "companion stopping");
  }

  send(channel: number, frame: Uint8Array): void {
    if (!this.#channels.has(channel) || this.#socket?.readyState !== WebSocket.OPEN) return;
    const data = new Uint8Array(CHANNEL_HEADER_BYTES + frame.length);
    new DataView(data.buffer).setUint32(0, channel);
    data.set(frame, CHANNEL_HEADER_BYTES);
    this.#socket.send(data);
  }

  closeChannel(channel: number): void {
    if (!this.#channels.delete(channel)) return;
    this.#sendControl({ t: "close", ch: channel });
    this.#handlers.onChannelClose(channel);
  }

  #connect(): void {
    this.#handlers.onStateChange?.("connecting");
    const socket = new WebSocket(this.#url);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    let ready = false;

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") {
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        if (bytes.length < CHANNEL_HEADER_BYTES) return;
        const channel = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
        if (this.#channels.has(channel)) this.#handlers.onChannelData(channel, bytes.subarray(CHANNEL_HEADER_BYTES));
        return;
      }
      const parsed = RelayToLaptopSchema.safeParse(safeJson(event.data));
      if (!parsed.success) return;
      const message = parsed.data;
      switch (message.t) {
        case "challenge":
          this.#sendControl({ t: "auth", id: this.#identity.laptopId, sig: signRelayChallenge(this.#identity, message.nonce) });
          return;
        case "ready":
          ready = true;
          this.#attempt = 0;
          this.#startHeartbeat();
          this.#handlers.onStateChange?.("online");
          return;
        case "open":
          this.#channels.add(message.ch);
          this.#handlers.onChannelOpen(message.ch);
          return;
        case "close":
          if (this.#channels.delete(message.ch)) this.#handlers.onChannelClose(message.ch);
          return;
        case "pong":
          clearTimeout(this.#pongTimer);
          return;
      }
    };

    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#stopHeartbeat();
      for (const channel of this.#channels) this.#handlers.onChannelClose(channel);
      this.#channels.clear();
      this.#handlers.onStateChange?.("offline", event.reason || (ready ? "connection lost" : "could not connect"));
      if (!this.#stopped) this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(): void {
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.#attempt++);
    this.#reconnectTimer = setTimeout(() => this.#connect(), base / 2 + Math.random() * (base / 2));
  }

  #startHeartbeat(): void {
    this.#pingTimer = setInterval(() => {
      this.#sendControl({ t: "ping" });
      this.#pongTimer = setTimeout(() => this.#socket?.close(4000, "heartbeat timeout"), PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  #stopHeartbeat(): void {
    clearInterval(this.#pingTimer);
    clearTimeout(this.#pongTimer);
  }

  #sendControl(message: LaptopToRelay): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
