// This device's key pair and paired laptop, stored in the iOS Keychain / Android Keystore.
import type { PairedLaptop } from "@away/client";
import { decodeKey, encodeKey, generateStaticKeyPair, type StaticKeyPair } from "@away/secure-channel";
import * as SecureStore from "expo-secure-store";

const KEY = "away.device";

export interface DeviceState {
  keys: StaticKeyPair;
  laptop?: PairedLaptop;
}

export async function loadDeviceState(): Promise<DeviceState> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return { keys: generateStaticKeyPair() };
  const stored = JSON.parse(raw) as { publicKey: string; secretKey: string; laptop?: PairedLaptop };
  return {
    keys: { publicKey: decodeKey(stored.publicKey), secretKey: decodeKey(stored.secretKey) },
    ...(stored.laptop && { laptop: stored.laptop }),
  };
}

export async function saveDeviceState(state: DeviceState): Promise<void> {
  const stored = { publicKey: encodeKey(state.keys.publicKey), secretKey: encodeKey(state.keys.secretKey), laptop: state.laptop };
  await SecureStore.setItemAsync(KEY, JSON.stringify(stored));
}
