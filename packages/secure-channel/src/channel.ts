/// <reference path="./noise-handshake.d.ts" />
import Noise from "noise-handshake";
import CipherState from "noise-handshake/cipher.js";

/**
 * Noise_IK_25519_ChaChaPoly_BLAKE2b handshakes and transport, built on noise-handshake.
 * See docs/security.md. Away does not implement cryptographic primitives itself.
 */

const PROLOGUE = Buffer.from("away/secure-channel/v1");
/** Noise frames are at most 65535 bytes, including the 16-byte tag and our 1-byte fragment header. */
const MAX_CHUNK = 65535 - 16 - 1;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MORE = 0;
const FINAL = 1;

export interface Handshake {
  transport: Transport;
  /** Decrypted handshake payload sent by the peer. */
  payload: Uint8Array;
}

/** Phone side: knows the laptop's static key in advance. */
export class Initiator {
  #noise: Noise;

  constructor(local: { publicKey: Uint8Array; secretKey: Uint8Array }, remotePublicKey: Uint8Array) {
    this.#noise = new Noise("IK", true, { publicKey: buf(local.publicKey), secretKey: buf(local.secretKey) });
    this.#noise.initialise(PROLOGUE, buf(remotePublicKey));
  }

  /** First handshake message. The payload is encrypted to the laptop's static key. */
  start(payload: Uint8Array): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.#noise.send(buf(payload)));
  }

  /** Processes the laptop's reply. Throws if it was not produced by the expected laptop. */
  finish(reply: Uint8Array): Handshake {
    const payload = this.#noise.recv(buf(reply));
    if (!this.#noise.complete) throw new Error("Noise handshake did not complete");
    return { payload: new Uint8Array(payload), transport: new Transport(this.#noise.tx, this.#noise.rx) };
  }
}

export interface IncomingHandshake {
  /** The initiator's authenticated static public key. */
  remotePublicKey: Uint8Array;
  payload: Uint8Array;
  /** Completes the handshake. Only call after deciding the remote key is allowed. */
  accept(replyPayload: Uint8Array): { reply: Uint8Array; transport: Transport };
}

/** Laptop side: processes a first handshake message. Throws if it is malformed or forged. */
export function respond(local: { publicKey: Uint8Array; secretKey: Uint8Array }, message: Uint8Array): IncomingHandshake {
  const noise = new Noise("IK", false, { publicKey: buf(local.publicKey), secretKey: buf(local.secretKey) });
  noise.initialise(PROLOGUE);
  const payload = noise.recv(buf(message));
  if (!noise.rs) throw new Error("Noise handshake carried no initiator key");
  return {
    remotePublicKey: new Uint8Array(noise.rs),
    payload: new Uint8Array(payload),
    accept(replyPayload) {
      const reply = noise.send(buf(replyPayload));
      if (!noise.complete) throw new Error("Noise handshake did not complete");
      return { reply: new Uint8Array(reply), transport: new Transport(noise.tx, noise.rx) };
    },
  };
}

/**
 * Ordered, authenticated encryption after the handshake. Nonces are counters, so a replayed,
 * reordered, dropped or altered frame fails to decrypt. Treat any thrown error as fatal.
 */
export class Transport {
  #send: CipherState;
  #receive: CipherState;
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #broken = false;

  constructor(sendKey: Buffer, receiveKey: Buffer) {
    this.#send = new CipherState(sendKey);
    this.#receive = new CipherState(receiveKey);
  }

  /** Encrypts one message into one or more frames, which must be delivered in order. */
  seal(message: Uint8Array): Uint8Array<ArrayBuffer>[] {
    const frames: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0;
    do {
      const chunk = message.subarray(offset, offset + MAX_CHUNK);
      offset += chunk.length;
      const header = offset >= message.length ? FINAL : MORE;
      frames.push(new Uint8Array(this.#send.encrypt(Buffer.concat([Buffer.of(header), chunk]))));
    } while (offset < message.length);
    return frames;
  }

  /** Decrypts one frame. Returns the full message once its final fragment arrives. */
  open(frame: Uint8Array): Uint8Array | undefined {
    if (this.#broken) throw new Error("Secure channel is closed after a decryption failure");
    let plaintext: Buffer;
    try {
      plaintext = this.#receive.decrypt(buf(frame));
    } catch (error) {
      this.#broken = true;
      throw new Error("Secure channel frame failed authentication", { cause: error });
    }
    const header = plaintext[0];
    if (header !== MORE && header !== FINAL) {
      this.#broken = true;
      throw new Error("Secure channel frame has an invalid header");
    }
    this.#fragments.push(plaintext.subarray(1));
    this.#fragmentBytes += plaintext.length - 1;
    if (this.#fragmentBytes > MAX_MESSAGE_BYTES) {
      this.#broken = true;
      throw new Error("Secure channel message is too large");
    }
    if (header === MORE) return undefined;
    const message = new Uint8Array(Buffer.concat(this.#fragments));
    this.#fragments = [];
    this.#fragmentBytes = 0;
    return message;
  }
}

function buf(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
