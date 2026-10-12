import type { AgentAdapter } from "@away/adapter-core";
import { formatPairingOffer } from "@away/protocol";
import { encodeKey } from "@away/secure-channel";
import { DeviceServer } from "./device-server.ts";
import { loadOrCreateIdentity, type LaptopIdentity } from "./identity.ts";
import { RelayLink, type RelayLinkState } from "./relay-link.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

export interface CompanionOptions {
  dataDir: string;
  relayUrl: string;
  adapters: AgentAdapter[];
  log?: (message: string) => void;
  onRelayState?: (state: RelayLinkState, detail?: string) => void;
}

export interface Companion {
  identity: LaptopIdentity;
  store: Store;
  devices: DeviceServer;
  sessions: SessionManager;
  /** Ends agent processes and disconnects from the relay. */
  stop(): Promise<void>;
}

export function startCompanion(options: CompanionOptions): Companion {
  const log = options.log ?? (() => {});
  const identity = loadOrCreateIdentity(options.dataDir);
  const store = new Store(options.dataDir);
  const { endedSessions } = store.reconcileAfterRestart();
  if (endedSessions.length > 0) log(`Marked ${endedSessions.length} session(s) from a previous run as ended`);

  const devices = new DeviceServer(identity, store, log);
  const sessions = new SessionManager(store, options.adapters, devices, log);
  const relay = new RelayLink(options.relayUrl, identity, {
    onChannelOpen: (channel) => devices.onChannelOpen(channel),
    onChannelData: (channel, frame) => devices.onChannelData(channel, frame),
    onChannelClose: (channel) => devices.onChannelClose(channel),
    ...(options.onRelayState && { onStateChange: options.onRelayState }),
  });
  devices.attach(relay, sessions);
  relay.start();

  return {
    identity,
    store,
    devices,
    sessions,
    async stop() {
      relay.stop();
      await sessions.shutdown();
      store.close();
    },
  };
}

/** Creates a single-use pairing offer for this laptop. Works while `away serve` is running. */
export function createPairingOffer(dataDir: string, relayUrl: string): string {
  const identity = loadOrCreateIdentity(dataDir);
  const store = new Store(dataDir);
  try {
    return formatPairingOffer({
      relayUrl,
      laptopId: identity.laptopId,
      laptopKey: encodeKey(identity.noise.publicKey),
      token: store.createPairingToken(),
    });
  } finally {
    store.close();
  }
}
