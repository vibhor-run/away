import { generateKeyPairSync, sign } from "node:crypto";
import { RELAY_AUTH_CONTEXT, RelayCloseCode } from "@away/protocol";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRelay } from "../src/relay.ts";

let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  app = await buildRelay();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  base = `ws://127.0.0.1:${address.port}`;
});
afterAll(() => app.close());

class Client {
  socket: WebSocket;
  messages: (string | Uint8Array)[] = [];
  closed: Promise<{ code: number }>;
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";
    this.socket.onmessage = (event) =>
      this.messages.push(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
    this.closed = new Promise((resolve) => (this.socket.onclose = (event) => resolve({ code: event.code })));
  }
  async next(predicate: (message: string | Uint8Array) => boolean = () => true) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("timed out");
  }
  async json() {
    return JSON.parse((await this.next((message) => typeof message === "string")) as string);
  }
}

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { id: publicKey.export({ format: "jwk" }).x!, privateKey };
}

async function connectLaptop(laptop = identity(), forgeWith?: ReturnType<typeof identity>) {
  const client = new Client(`${base}/v1/laptop`);
  const challenge = await client.json();
  const signer = forgeWith ?? laptop;
  const sig = sign(null, Buffer.from(RELAY_AUTH_CONTEXT + challenge.nonce), signer.privateKey).toString("base64url");
  client.socket.send(JSON.stringify({ t: "auth", id: laptop.id, sig }));
  return { client, laptop };
}

describe("relay", () => {
  it("authenticates a laptop that signs the challenge", async () => {
    const { client } = await connectLaptop();
    expect(await client.json()).toEqual({ t: "ready" });
    client.socket.close();
  });

  it("rejects a laptop id signed by a different key", async () => {
    const { client } = await connectLaptop(identity(), identity());
    expect((await client.closed).code).toBe(RelayCloseCode.authFailed);
  });

  it("closes a phone connection to an offline laptop", async () => {
    const phone = new Client(`${base}/v1/connect/${identity().id}`);
    expect((await phone.closed).code).toBe(RelayCloseCode.laptopOffline);
  });

  it("forwards frames both ways and reports channel close", async () => {
    const { client: laptop, laptop: id } = await connectLaptop();
    await laptop.json();
    const phone = new Client(`${base}/v1/connect/${id.id}`);
    const { ch } = await laptop.json();

    if (phone.socket.readyState !== WebSocket.OPEN) await new Promise((resolve) => (phone.socket.onopen = resolve));
    phone.socket.send(new Uint8Array([1, 2, 3]));
    const fromPhone = (await laptop.next((message) => typeof message !== "string")) as Uint8Array;
    expect(Buffer.from(fromPhone).readUInt32BE(0)).toBe(ch);
    expect([...fromPhone.subarray(4)]).toEqual([1, 2, 3]);

    const toPhone = Buffer.alloc(6);
    toPhone.writeUInt32BE(ch);
    toPhone.set([9, 8], 4);
    laptop.socket.send(toPhone);
    expect([...((await phone.next()) as Uint8Array)]).toEqual([9, 8]);

    phone.socket.close();
    expect(await laptop.json()).toEqual({ t: "close", ch });
    laptop.socket.close();
  });

  it("closes phones when their laptop disconnects", async () => {
    const { client: laptop, laptop: id } = await connectLaptop();
    await laptop.json();
    const phone = new Client(`${base}/v1/connect/${id.id}`);
    await laptop.json();
    laptop.socket.close();
    expect((await phone.closed).code).toBe(RelayCloseCode.laptopDisconnected);
  });

  it("replaces an older connection for the same laptop", async () => {
    const id = identity();
    const first = await connectLaptop(id);
    await first.client.json();
    const second = await connectLaptop(id);
    expect(await second.client.json()).toEqual({ t: "ready" });
    expect((await first.client.closed).code).toBe(RelayCloseCode.replaced);
    second.client.socket.close();
  });
});
