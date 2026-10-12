import {
  ClientHelloSchema,
  ClientMessageSchema,
  type ServerHello,
  type ServerMessage,
} from "@away/protocol";
import { encodeKey, respond, type Transport } from "@away/secure-channel";
import type { LaptopIdentity } from "./identity.ts";
import type { RelayLink } from "./relay-link.ts";
import type { Outbox, SessionManager, Subscriber } from "./sessions.ts";
import type { Store } from "./store.ts";

interface Connection extends Subscriber {
  channel: number;
  deviceId: string;
  transport: Transport;
}

type Log = (message: string) => void;

/**
 * Terminates end-to-end encrypted channels from paired devices. Each relay channel starts
 * with a Noise IK handshake; only paired, non-revoked devices (or a valid pairing token) are
 * accepted. Afterwards every frame is decrypted, validated, and dispatched.
 */
export class DeviceServer implements Outbox {
  #identity: LaptopIdentity;
  #store: Store;
  #relay: RelayLink | undefined;
  #sessions: SessionManager | undefined;
  #log: Log;
  /** Channels whose handshake has not finished. */
  #handshaking = new Set<number>();
  #connections = new Map<number, Connection>();

  constructor(identity: LaptopIdentity, store: Store, log: Log = () => {}) {
    this.#identity = identity;
    this.#store = store;
    this.#log = log;
  }

  attach(relay: RelayLink, sessions: SessionManager): void {
    this.#relay = relay;
    this.#sessions = sessions;
  }

  onChannelOpen(channel: number): void {
    this.#handshaking.add(channel);
  }

  onChannelClose(channel: number): void {
    this.#handshaking.delete(channel);
    const connection = this.#connections.get(channel);
    if (!connection) return;
    this.#connections.delete(channel);
    this.#sessions?.unsubscribe(connection);
  }

  onChannelData(channel: number, frame: Uint8Array): void {
    if (this.#handshaking.delete(channel)) return this.#handshake(channel, frame);
    const connection = this.#connections.get(channel);
    if (!connection) return;
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = connection.transport.open(frame);
    } catch {
      // Tampered, replayed, or reordered frame: the channel cannot be trusted any more.
      return this.#relay?.closeChannel(channel);
    }
    if (plaintext) this.#onMessage(connection, plaintext);
  }

  toDevice(deviceId: string, message: ServerMessage): void {
    for (const connection of this.#connections.values()) {
      if (connection.deviceId === deviceId) connection.send(message);
    }
  }

  toAll(message: ServerMessage): void {
    for (const connection of this.#connections.values()) connection.send(message);
  }

  /** Closes every open channel of a device, for example after revocation. */
  disconnectDevice(deviceId: string): void {
    for (const connection of [...this.#connections.values()]) {
      if (connection.deviceId === deviceId) this.#relay?.closeChannel(connection.channel);
    }
  }

  #handshake(channel: number, message: Uint8Array): void {
    let incoming;
    try {
      incoming = respond(this.#identity.noise, message);
    } catch {
      return this.#relay?.closeChannel(channel);
    }
    const publicKey = encodeKey(incoming.remotePublicKey);
    const hello = ClientHelloSchema.safeParse(safeJson(new TextDecoder().decode(incoming.payload)));

    let reply: ServerHello;
    let deviceId: string | undefined;
    if (!hello.success) {
      reply = { type: "rejected", reason: "Invalid hello" };
    } else if (hello.data.type === "pair") {
      if (this.#store.consumePairingToken(hello.data.token)) {
        const device = this.#store.addDevice(publicKey, hello.data.deviceName);
        deviceId = device.id;
        this.#log(`Paired device "${device.name}" (${device.id})`);
      }
      reply = deviceId
        ? { type: "accepted", deviceId, laptopName: this.#identity.name }
        : { type: "rejected", reason: "Pairing code is invalid, expired, or already used" };
    } else {
      const device = this.#store.findDeviceByKey(publicKey);
      if (device && !device.revokedAt) deviceId = device.id;
      reply = deviceId
        ? { type: "accepted", deviceId, laptopName: this.#identity.name }
        : { type: "rejected", reason: device ? "This device was revoked" : "This device is not paired" };
    }

    // The handshake completes even for a rejection so the reason reaches the device encrypted.
    const { reply: replyFrame, transport } = incoming.accept(new TextEncoder().encode(JSON.stringify(reply)));
    this.#relay?.send(channel, replyFrame);
    if (!deviceId) return this.#relay?.closeChannel(channel);

    const connection: Connection = {
      channel,
      deviceId,
      transport,
      send: (serverMessage) => {
        const bytes = new TextEncoder().encode(JSON.stringify(serverMessage));
        for (const frame of transport.seal(bytes)) this.#relay?.send(channel, frame);
      },
    };
    this.#connections.set(channel, connection);
  }

  #onMessage(connection: Connection, plaintext: Uint8Array): void {
    const device = this.#store.getDevice(connection.deviceId);
    if (!device || device.revokedAt) return this.#relay?.closeChannel(connection.channel);

    const parsed = ClientMessageSchema.safeParse(safeJson(new TextDecoder().decode(plaintext)));
    if (!parsed.success) return connection.send({ type: "error", message: "Invalid message" });
    const message = parsed.data;
    const sessions = this.#sessions!;
    switch (message.type) {
      case "command":
        void sessions.execute(connection.deviceId, message.commandId, message.command);
        return;
      case "subscribe":
        return sessions.subscribe(connection, message.sessionId, message.afterSeq);
      case "unsubscribe":
        return sessions.unsubscribe(connection, message.sessionId);
      case "ping":
        return connection.send({ type: "pong", nonce: message.nonce });
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
