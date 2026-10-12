import { parsePairingOffer } from "@away/protocol";
import type { StaticKeyPair } from "@away/secure-channel";
import { openSecureSocket } from "./secure-socket.ts";

/** What a device remembers about a laptop after pairing. Contains no secrets of the laptop. */
export interface PairedLaptop {
  relayUrl: string;
  laptopId: string;
  laptopKey: string;
  laptopName: string;
  deviceId: string;
}

/** Pairs this device using an offer created by `away pair` on the laptop. */
export async function pairWithLaptop(offerText: string, deviceName: string, keys: StaticKeyPair): Promise<PairedLaptop> {
  const offer = parsePairingOffer(offerText);
  const { socket, hello } = await openSecureSocket(offer.relayUrl, offer.laptopId, offer.laptopKey, keys, {
    type: "pair",
    token: offer.token,
    deviceName,
  });
  socket.close(1000, "paired");
  if (hello.type === "rejected") throw new Error(hello.reason);
  return {
    relayUrl: offer.relayUrl,
    laptopId: offer.laptopId,
    laptopKey: offer.laptopKey,
    laptopName: hello.laptopName,
    deviceId: hello.deviceId,
  };
}
