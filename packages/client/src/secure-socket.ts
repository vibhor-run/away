import { assertRelayUrlAllowed, ServerHelloSchema, type ClientHello, type ServerHello } from "@away/protocol";
import { decodeKey, Initiator, type StaticKeyPair, type Transport } from "@away/secure-channel";

export interface SecureSocket {
  socket: WebSocket;
  transport: Transport;
  hello: ServerHello;
}

const HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * Opens a relay channel to a laptop and runs the Noise IK handshake. Resolves once the laptop
 * answered; a `rejected` hello still resolves so callers can show the reason.
 */
export function openSecureSocket(
  relayUrl: string,
  laptopId: string,
  laptopKey: string,
  keys: StaticKeyPair,
  hello: ClientHello,
): Promise<SecureSocket> {
  assertRelayUrlAllowed(relayUrl);
  const url = new URL(`/v1/connect/${encodeURIComponent(laptopId)}`, relayUrl);
  const initiator = new Initiator(keys, decodeKey(laptopKey));
  // A string, not a URL object: React Native's WebSocket only accepts strings.
  const socket = new WebSocket(url.toString());
  socket.binaryType = "arraybuffer";

  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.onmessage = null;
      socket.onclose = null;
      socket.close();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Timed out connecting to the laptop")), HANDSHAKE_TIMEOUT_MS);
    socket.onopen = () => socket.send(initiator.start(new TextEncoder().encode(JSON.stringify(hello))));
    socket.onclose = (event) => fail(new Error(closeReason(event.code, event.reason)));
    socket.onmessage = (event) => {
      if (typeof event.data === "string") return fail(new Error("Unexpected text frame from relay"));
      try {
        const { transport, payload } = initiator.finish(new Uint8Array(event.data as ArrayBuffer));
        const parsed = ServerHelloSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
        clearTimeout(timer);
        socket.onmessage = null;
        socket.onclose = null;
        resolve({ socket, transport, hello: parsed });
      } catch {
        fail(new Error("The laptop could not be authenticated"));
      }
    };
  });
}

export function closeReason(code: number, reason: string): string {
  if (code === 4004) return "The laptop is offline";
  if (code === 4005) return "The laptop disconnected";
  return reason || `Connection closed (${code})`;
}
