import { createPublicKey, randomBytes, verify } from "node:crypto";
import websocket from "@fastify/websocket";
import {
  CHANNEL_HEADER_BYTES,
  LaptopToRelaySchema,
  RELAY_AUTH_CONTEXT,
  RELAY_PROTOCOL_VERSION,
  RelayCloseCode,
  type RelayToLaptop,
} from "@away/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";

/**
 * The relay lets a laptop and its phones reach each other with outgoing connections only.
 * It authenticates laptops by their routing id but cannot read or forge channel frames:
 * those are end-to-end encrypted between phone and laptop (docs/security.md).
 */

export interface RelayOptions {
  logger?: boolean;
  maxChannelsPerLaptop?: number;
  authTimeoutMs?: number;
  heartbeatMs?: number;
}

interface LaptopLink {
  id: string;
  socket: WebSocket;
  channels: Map<number, WebSocket>;
  nextChannel: number;
}

/** Largest Noise frame (65535) plus the channel header, with headroom for control messages. */
const MAX_PAYLOAD_BYTES = 70 * 1024;

export async function buildRelay(options: RelayOptions = {}): Promise<FastifyInstance> {
  const maxChannels = options.maxChannelsPerLaptop ?? 32;
  const authTimeoutMs = options.authTimeoutMs ?? 10_000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;

  const app = Fastify({ logger: options.logger ?? false });
  await app.register(websocket, { options: { maxPayload: MAX_PAYLOAD_BYTES } });

  const laptops = new Map<string, LaptopLink>();
  const alive = new WeakMap<WebSocket, boolean>();
  const sockets = new Set<WebSocket>();

  function track(socket: WebSocket) {
    sockets.add(socket);
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));
    socket.on("close", () => sockets.delete(socket));
    // Unclean client disconnects surface as errors; the close handler does the cleanup.
    socket.on("error", () => {});
  }

  // Drops sockets that stop answering WebSocket pings (for example after a network change).
  const heartbeat = setInterval(() => {
    for (const socket of sockets) {
      if (!alive.get(socket)) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, heartbeatMs);
  app.addHook("onClose", async () => clearInterval(heartbeat));

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/v1/laptop", { websocket: true }, (socket) => {
    track(socket);
    const nonce = randomBytes(32).toString("base64url");
    let link: LaptopLink | undefined;
    const send = (message: RelayToLaptop) => socket.send(JSON.stringify(message));
    const authTimer = setTimeout(() => socket.close(RelayCloseCode.authFailed, "auth timeout"), authTimeoutMs);
    send({ t: "challenge", nonce, version: RELAY_PROTOCOL_VERSION });

    socket.on("message", (data: RawData, isBinary: boolean) => {
      const bytes = data as Buffer;
      if (!link) {
        clearTimeout(authTimer);
        const id = !isBinary ? authenticate(bytes.toString("utf8"), nonce) : undefined;
        if (!id) return socket.close(RelayCloseCode.authFailed, "auth failed");
        const previous = laptops.get(id);
        if (previous) previous.socket.close(RelayCloseCode.replaced, "replaced by a newer connection");
        link = { id, socket, channels: new Map(), nextChannel: 0 };
        laptops.set(id, link);
        return send({ t: "ready" });
      }
      if (isBinary) {
        if (bytes.length < CHANNEL_HEADER_BYTES) return;
        link.channels.get(bytes.readUInt32BE(0))?.send(bytes.subarray(CHANNEL_HEADER_BYTES), { binary: true });
        return;
      }
      const parsed = LaptopToRelaySchema.safeParse(safeJson(bytes.toString("utf8")));
      if (!parsed.success) return;
      if (parsed.data.t === "ping") send({ t: "pong" });
      if (parsed.data.t === "close") {
        const phone = link.channels.get(parsed.data.ch);
        link.channels.delete(parsed.data.ch);
        phone?.close(RelayCloseCode.closedByLaptop, "closed by laptop");
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (!link) return;
      if (laptops.get(link.id) === link) laptops.delete(link.id);
      for (const phone of link.channels.values()) phone.close(RelayCloseCode.laptopDisconnected, "laptop disconnected");
      link.channels.clear();
    });
  });

  app.get<{ Params: { laptopId: string } }>("/v1/connect/:laptopId", { websocket: true }, (socket, request) => {
    track(socket);
    const link = laptops.get(request.params.laptopId);
    if (!link) return socket.close(RelayCloseCode.laptopOffline, "laptop offline");
    if (link.channels.size >= maxChannels) return socket.close(RelayCloseCode.tooManyChannels, "too many channels");

    link.nextChannel = (link.nextChannel + 1) % 0x1_0000_0000;
    const ch = link.nextChannel;
    link.channels.set(ch, socket);
    link.socket.send(JSON.stringify({ t: "open", ch } satisfies RelayToLaptop));

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) return socket.close(1003, "binary frames only");
      const header = Buffer.alloc(CHANNEL_HEADER_BYTES);
      header.writeUInt32BE(ch);
      link.socket.send(Buffer.concat([header, data as Buffer]), { binary: true });
    });
    socket.on("close", () => {
      if (link.channels.get(ch) !== socket) return;
      link.channels.delete(ch);
      link.socket.send(JSON.stringify({ t: "close", ch } satisfies RelayToLaptop));
    });
  });

  return app;
}

/** Returns the laptop id if the auth message carries a valid signature over our nonce. */
function authenticate(text: string, nonce: string): string | undefined {
  const parsed = LaptopToRelaySchema.safeParse(safeJson(text));
  if (!parsed.success || parsed.data.t !== "auth") return undefined;
  const { id, sig } = parsed.data;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: id }, format: "jwk" });
    const ok = verify(null, Buffer.from(RELAY_AUTH_CONTEXT + nonce), key, Buffer.from(sig, "base64url"));
    return ok ? id : undefined;
  } catch {
    return undefined;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
