// React Native lacks Node's Buffer and Web Crypto. sodium-javascript reads crypto.getRandomValues
// once when it loads, so this file must be imported first (see index.ts).
import { Buffer } from "buffer";
import * as ExpoCrypto from "expo-crypto";

const globals = globalThis as unknown as {
  Buffer?: typeof Buffer;
  crypto?: { getRandomValues?: unknown; randomUUID?: unknown };
};
globals.Buffer ??= Buffer;
globals.crypto ??= {};
globals.crypto.getRandomValues ??= ExpoCrypto.getRandomValues;
globals.crypto.randomUUID ??= ExpoCrypto.randomUUID;
