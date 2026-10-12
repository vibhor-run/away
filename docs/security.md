# Away security design

Status: implemented for local development. **Not reviewed and not deployed.** Do not run a public relay until the open items below are resolved.

## Goals

- The relay forwards traffic but cannot read or forge application messages.
- Only devices the laptop owner explicitly paired can control the laptop, and pairing can be revoked.
- A captured message cannot be replayed to repeat an action.
- Provider credentials (API keys, OAuth tokens) never leave the laptop.
- A phone can only start agents in project folders the laptop owner registered. Away exposes no generic shell or filesystem API.

## Keys

Each companion (laptop) has two long-term key pairs stored in `~/.away/identity.json` (file mode 0600):

| Key | Algorithm | Purpose |
|---|---|---|
| Relay key | Ed25519 (Node `crypto`) | Proves to the relay that the laptop owns its routing id. The routing id is this public key. |
| Noise static key | X25519 | Authenticates the laptop to phones and establishes end-to-end encryption. |

Each phone has its own X25519 Noise static key. The laptop stores the public keys of paired devices in its SQLite database.

## Relay

- The laptop connects to `wss://relay/v1/laptop`, receives a random challenge, and signs `away-relay-auth-v1\n<challenge>` with its relay key. The relay accepts the connection only if the signature verifies against the claimed id. This stops anyone else from receiving connections meant for that laptop.
- A phone connects to `wss://relay/v1/connect/<laptopId>`. The relay assigns a channel id and forwards opaque binary frames between that phone socket and the laptop socket.
- The relay never authenticates phones. Phones are authenticated end to end by the laptop.
- The relay limits frame size and channels per laptop, and drops idle sockets.

## End-to-end channel: Noise IK

Each phone connection runs a [Noise](https://noiseprotocol.org/noise.html) `IK` handshake (`Noise_IK_25519_ChaChaPoly_BLAKE2b`) using `noise-handshake` (Holepunch) over libsodium. Away does not implement cryptographic primitives or handshake logic itself.

- The phone is the initiator and already knows the laptop's static key from pairing (the `K` in IK). A relay that substitutes its own key cannot complete the handshake.
- The laptop learns the phone's static key from the handshake (the `I`) and accepts the channel only if that key belongs to a paired, non-revoked device, or if the first message carries a valid pairing token.
- After the handshake, every message uses ChaCha20-Poly1305 with a counter nonce, in order. A replayed, reordered, dropped, or modified frame fails decryption and the channel is closed.
- Each connection uses fresh ephemeral keys, so frames from one connection cannot be replayed into another. Messages after the handshake are forward secret: a later compromise of a long-term key does not decrypt them. The first handshake payload (the hello, or the pairing token) is encrypted to the laptop's static key, so it is not forward secret; a stolen laptop key would reveal past hellos and already-used pairing tokens.
- Messages larger than one Noise frame (65,535 bytes) are split into fragments inside the encrypted channel.

## Pairing

1. On the laptop, `away pair` creates a pairing offer: a random 32-byte token, single use, valid for 5 minutes, stored only as its SHA-256 hash.
2. The offer is shown as a URL (later a QR code): `away://pair?v=1&relay=…&laptop=<relay id>&key=<laptop Noise key>&token=<token>`. It must travel out of band (camera, not network), because it carries the laptop key that defeats a malicious relay.
3. The phone generates its own key pair and runs the IK handshake with the token and a device name in the first handshake payload. That payload is encrypted to the laptop's static key.
4. The laptop checks the token hash, expiry, and single use, then stores the phone's public key as a paired device.

A replayed first handshake message is harmless: the token is consumed on first use, and an attacker without the phone's keys cannot finish the handshake or send valid frames.

## Commands and replay

- Every client command carries a client-generated command id. The laptop stores it before acting, and a repeated id returns the stored status instead of running the command again. This makes reconnect retries safe. It is not exactly-once execution: if Away crashes after a prompt reached the agent, the outcome is reported as unknown and the prompt is never resent automatically.
- Command ids are scoped to the device that sent them.

## Revocation

`away devices revoke <id>` marks a device revoked. New handshakes from that key are refused, and a running companion closes the device's open channels when it next checks (on every received command).

## Open items before any public deployment

- Independent review of this design and its implementation.
- The laptop's long-term keys are in a 0600 file, not the OS keychain (planned: Electron `safeStorage` / macOS Keychain).
- Pairing offers are printed as text in the terminal. Anyone who can see the offer within 5 minutes can pair. A QR code shown in the desktop app, plus a confirmation on the laptop, is planned.
- The relay has basic limits but no per-IP rate limiting, abuse protection, or TLS termination of its own. It must run behind TLS (`wss://`). Clients refuse plain `ws://` except to localhost.
- Phones can open channels to any laptop id they know. Unauthenticated handshakes are cheap to reject, but this is not yet rate limited.
- The relay sees metadata: laptop ids, IP addresses, connection times, and message sizes and timing.
- The React Native crypto backend has not been chosen or verified (`noise-handshake` uses `sodium-universal`, which needs a libsodium binding on mobile).
- No key rotation and no laptop-key reset flow yet.
- Approval answers and question answers travel over the encrypted channel and are executed by the agent. Codex questions flagged `isSecret` are not treated specially: they are shown and answered like any other question, and the question text is kept in the event log.
- The event log in `away.db` keeps prompts and agent output indefinitely. There is no retention limit or per-session deletion yet.
