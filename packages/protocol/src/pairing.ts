import { z } from "zod";

/**
 * A pairing offer shown on the laptop (as text, later as a QR code) and read by the phone.
 * It must travel out of band: it carries the laptop key that stops a relay from impersonating it.
 */
export interface PairingOffer {
  relayUrl: string;
  /** The laptop's relay routing id (its Ed25519 public key, base64url). */
  laptopId: string;
  /** The laptop's Noise static public key (X25519, base64url). */
  laptopKey: string;
  /** Single-use secret, base64url. */
  token: string;
}

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);

export function formatPairingOffer(offer: PairingOffer): string {
  const params = new URLSearchParams({
    v: "1",
    relay: offer.relayUrl,
    laptop: offer.laptopId,
    key: offer.laptopKey,
    token: offer.token,
  });
  return `away://pair?${params.toString()}`;
}

export function parsePairingOffer(text: string): PairingOffer {
  const url = new URL(text.trim());
  if (url.protocol !== "away:" || url.hostname !== "pair") throw new Error("Not an Away pairing offer");
  const params = url.searchParams;
  if (params.get("v") !== "1") throw new Error("Unsupported pairing offer version");
  return {
    relayUrl: z.url({ protocol: /^wss?$/ }).parse(params.get("relay")),
    laptopId: Base64Url.parse(params.get("laptop")),
    laptopKey: Base64Url.parse(params.get("key")),
    token: Base64Url.parse(params.get("token")),
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Relay traffic must use TLS (wss://) except to this machine during development. */
export function assertRelayUrlAllowed(relayUrl: string): void {
  const url = new URL(relayUrl);
  if (url.protocol === "wss:") return;
  if (url.protocol === "ws:" && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new Error(`Refusing insecure relay URL ${relayUrl}: use wss:// (ws:// is allowed only for localhost)`);
}
