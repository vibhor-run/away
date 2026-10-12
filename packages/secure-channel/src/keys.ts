/// <reference path="./noise-handshake.d.ts" />
import { generateKeyPair } from "noise-handshake/dh.js";

/** Long-term X25519 key pair used as the Noise static key. */
export interface StaticKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateStaticKeyPair(): StaticKeyPair {
  const { publicKey, secretKey } = generateKeyPair();
  return { publicKey: new Uint8Array(publicKey), secretKey: new Uint8Array(secretKey) };
}

// base64url via plain base64, because the Buffer polyfill used in React Native lacks "base64url".
export function encodeKey(key: Uint8Array): string {
  return Buffer.from(key).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeKey(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) throw new Error("Invalid key: not base64url");
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const key = new Uint8Array(Buffer.from(base64, "base64"));
  if (key.length !== 32) throw new Error("Invalid key: expected 32 bytes");
  return key;
}
