import { z } from "zod";

// Control protocol between the relay and a laptop. Binary WebSocket messages carry channel
// data: a 4-byte big-endian channel id followed by an opaque (end-to-end encrypted) frame.
// Phones send and receive raw opaque frames with no header.

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_AUTH_CONTEXT = "away-relay-auth-v1\n";
export const CHANNEL_HEADER_BYTES = 4;

/** WebSocket close codes used by the relay (4000–4999 are application-defined). */
export const RelayCloseCode = {
  authFailed: 4001,
  replaced: 4002,
  laptopOffline: 4004,
  laptopDisconnected: 4005,
  tooManyChannels: 4029,
  closedByLaptop: 4010,
} as const;

export const RelayToLaptopSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("challenge"), nonce: z.string(), version: z.number() }),
  z.object({ t: z.literal("ready") }),
  z.object({ t: z.literal("open"), ch: z.number().int() }),
  z.object({ t: z.literal("close"), ch: z.number().int() }),
  z.object({ t: z.literal("pong") }),
]);
export type RelayToLaptop = z.infer<typeof RelayToLaptopSchema>;

export const LaptopToRelaySchema = z.discriminatedUnion("t", [
  /** `id` is the base64url raw Ed25519 public key; `sig` signs RELAY_AUTH_CONTEXT + nonce. */
  z.object({ t: z.literal("auth"), id: z.string(), sig: z.string() }),
  z.object({ t: z.literal("close"), ch: z.number().int() }),
  z.object({ t: z.literal("ping") }),
]);
export type LaptopToRelay = z.infer<typeof LaptopToRelaySchema>;
