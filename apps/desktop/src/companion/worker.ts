// Runs the headless companion in an Electron utilityProcess: a separate Node.js process, so the
// agents keep running independently of the window. main.ts talks to it with parentPort messages.
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ClaudeAdapter } from "@away/adapter-claude";
import { CodexAdapter } from "@away/adapter-codex";
import { PiAdapter } from "@away/adapter-pi";
import { createPairingOffer, startCompanion } from "@away/companion";
import type { WorkerMessage, WorkerRequest } from "../shared/api";

interface ParentPort {
  on(event: "message", listener: (event: { data: { id: number; request: WorkerRequest } }) => void): void;
  postMessage(message: WorkerMessage): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
const dataDir = process.env.AWAY_HOME ?? join(homedir(), ".away");
const relayUrl = process.env.AWAY_RELAY_URL ?? "ws://127.0.0.1:8787";
const command = (name: string) => (process.env[name] ? { command: process.env[name] } : {});

const companion = startCompanion({
  dataDir,
  relayUrl,
  adapters: [
    new PiAdapter(command("AWAY_PI_COMMAND")),
    new ClaudeAdapter(command("AWAY_CLAUDE_COMMAND")),
    new CodexAdapter(command("AWAY_CODEX_COMMAND")),
  ],
  log: (message) => console.log(`[companion] ${message}`),
  onRelayState: (state, detail) => parentPort.postMessage({ event: "relay", state, detail: detail ?? null }),
});

async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case "info":
      return { laptopName: companion.identity.name, relayUrl };
    case "pair":
      return createPairingOffer(dataDir, relayUrl);
    case "listProjects":
      return companion.store.listProjects();
    case "addProject": {
      const path = realpathSync(request.path);
      if (!statSync(path).isDirectory()) throw new Error(`${path} is not a folder`);
      return companion.store.addProject(path, basename(path));
    }
    case "removeProject":
      return companion.store.removeProject(request.id);
    case "listDevices":
      return companion.store.listDevices().map(({ id, name, pairedAt, revokedAt }) => ({ id, name, pairedAt, revokedAt }));
    case "revokeDevice":
      companion.store.revokeDevice(request.id);
      companion.devices.disconnectDevice(request.id);
      return null;
    case "listSessions":
      return companion.store.listSessions();
    case "stop":
      await companion.stop();
      setImmediate(() => process.exit(0));
      return null;
  }
}

parentPort.on("message", async ({ data }) => {
  try {
    parentPort.postMessage({ id: data.id, result: await handle(data.request) });
  } catch (error) {
    parentPort.postMessage({ id: data.id, error: (error as Error).message });
  }
});
