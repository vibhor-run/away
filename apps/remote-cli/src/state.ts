import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PairedLaptop } from "@away/client";
import { decodeKey, encodeKey, generateStaticKeyPair, type StaticKeyPair } from "@away/secure-channel";

/** This device's key pair and paired laptop, in a file readable only by the current user. */
export interface DeviceState {
  keys: StaticKeyPair;
  laptop?: PairedLaptop;
}

const dir = process.env.AWAY_REMOTE_HOME ?? join(homedir(), ".away-remote");
const path = join(dir, "state.json");

export function loadState(): DeviceState {
  if (!existsSync(path)) return { keys: generateStaticKeyPair() };
  const file = JSON.parse(readFileSync(path, "utf8")) as { keys: { publicKey: string; secretKey: string }; laptop?: PairedLaptop };
  return {
    keys: { publicKey: decodeKey(file.keys.publicKey), secretKey: decodeKey(file.keys.secretKey) },
    ...(file.laptop && { laptop: file.laptop }),
  };
}

export function saveState(state: DeviceState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = {
    keys: { publicKey: encodeKey(state.keys.publicKey), secretKey: encodeKey(state.keys.secretKey) },
    laptop: state.laptop,
  };
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}
