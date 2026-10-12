import { describe, expect, it } from "vitest";
import { generateStaticKeyPair, Initiator, respond, type Transport } from "../src/index.ts";

const text = (value: string) => new TextEncoder().encode(value);
const read = (value: Uint8Array | undefined) => new TextDecoder().decode(value);

function connect(laptop = generateStaticKeyPair(), phone = generateStaticKeyPair()) {
  const initiator = new Initiator(phone, laptop.publicKey);
  const incoming = respond(laptop, initiator.start(text("hello")));
  const { reply, transport: laptopSide } = incoming.accept(text("welcome"));
  const finished = initiator.finish(reply);
  return { incoming, finished, phoneSide: finished.transport, laptopSide, laptop, phone };
}

function deliver(from: Transport, to: Transport, message: Uint8Array) {
  let result: Uint8Array | undefined;
  for (const frame of from.seal(message)) result = to.open(frame);
  return result;
}

describe("Noise IK channel", () => {
  it("authenticates both sides and carries handshake payloads", () => {
    const { incoming, finished, phone } = connect();
    expect(incoming.remotePublicKey).toEqual(phone.publicKey);
    expect(read(incoming.payload)).toBe("hello");
    expect(read(finished.payload)).toBe("welcome");
  });

  it("encrypts in both directions", () => {
    const { phoneSide, laptopSide } = connect();
    expect(read(deliver(phoneSide, laptopSide, text("ping")))).toBe("ping");
    expect(read(deliver(laptopSide, phoneSide, text("pong")))).toBe("pong");
  });

  it("fails when the responder is not the expected laptop", () => {
    const expected = generateStaticKeyPair();
    const impostor = generateStaticKeyPair();
    const initiator = new Initiator(generateStaticKeyPair(), expected.publicKey);
    expect(() => respond(impostor, initiator.start(text("hello")))).toThrow();
  });

  it("rejects tampered, replayed and reordered frames", () => {
    const tampered = connect();
    const [frame] = tampered.phoneSide.seal(text("rm"));
    frame![frame!.length - 1]! ^= 1;
    expect(() => tampered.laptopSide.open(frame!)).toThrow(/authentication/);

    const replayed = connect();
    const [first] = replayed.phoneSide.seal(text("prompt"));
    replayed.laptopSide.open(first!);
    expect(() => replayed.laptopSide.open(first!)).toThrow();

    const reordered = connect();
    const [a] = reordered.phoneSide.seal(text("a"));
    const [b] = reordered.phoneSide.seal(text("b"));
    expect(() => reordered.laptopSide.open(b!)).toThrow();
    void a;
  });

  it("rejects frames replayed from an earlier connection with the same keys", () => {
    const laptop = generateStaticKeyPair();
    const phone = generateStaticKeyPair();
    const earlier = connect(laptop, phone);
    const [captured] = earlier.phoneSide.seal(text("prompt"));
    const later = connect(laptop, phone);
    expect(() => later.laptopSide.open(captured!)).toThrow();
  });

  it("fragments messages larger than one Noise frame", () => {
    const { phoneSide, laptopSide } = connect();
    const big = new Uint8Array(200_000).map((_, index) => index % 251);
    const frames = phoneSide.seal(big);
    expect(frames.length).toBe(4);
    expect(frames.every((frame) => frame.length <= 65535)).toBe(true);
    const received = frames.map((frame) => laptopSide.open(frame));
    expect(received.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(received[3]).toEqual(big);
  });
});
