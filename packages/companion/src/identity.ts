import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { RELAY_AUTH_CONTEXT } from "@away/protocol";
import { decodeKey, encodeKey, generateStaticKeyPair, type StaticKeyPair } from "@away/secure-channel";

/**
 * The laptop's long-term keys (docs/security.md). Stored in a file readable only by the
 * current user. Moving them to the OS keychain is an open item.
 */
export interface LaptopIdentity {
  name: string;
  /** Relay routing id: the base64url raw Ed25519 public key. */
  laptopId: string;
  relayKey: KeyObject;
  noise: StaticKeyPair;
}

interface IdentityFile {
  version: 1;
  name: string;
  relayPrivateKey: { kty: string; crv: string; d: string; x: string };
  noise: { publicKey: string; secretKey: string };
}

export function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

export function loadOrCreateIdentity(dataDir: string): LaptopIdentity {
  ensureDataDir(dataDir);
  const path = join(dataDir, "identity.json");
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const noise = generateStaticKeyPair();
    const file: IdentityFile = {
      version: 1,
      name: hostname(),
      relayPrivateKey: privateKey.export({ format: "jwk" }) as IdentityFile["relayPrivateKey"],
      noise: { publicKey: encodeKey(noise.publicKey), secretKey: encodeKey(noise.secretKey) },
    };
    // "wx" fails instead of overwriting if another process created the file first.
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600, flag: "wx" });
  }
  chmodSync(path, 0o600);
  const file = JSON.parse(readFileSync(path, "utf8")) as IdentityFile;
  const relayKey = createPrivateKey({ key: file.relayPrivateKey, format: "jwk" });
  const laptopId = createPublicKey(relayKey).export({ format: "jwk" }).x;
  if (!laptopId) throw new Error("Identity file has an invalid relay key");
  return {
    name: file.name,
    laptopId,
    relayKey,
    noise: { publicKey: decodeKey(file.noise.publicKey), secretKey: decodeKey(file.noise.secretKey) },
  };
}

export function signRelayChallenge(identity: LaptopIdentity, nonce: string): string {
  return sign(null, Buffer.from(RELAY_AUTH_CONTEXT + nonce), identity.relayKey).toString("base64url");
}
