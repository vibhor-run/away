#!/usr/bin/env node
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ClaudeAdapter } from "@away/adapter-claude";
import { CodexAdapter } from "@away/adapter-codex";
import { PiAdapter } from "@away/adapter-pi";
import { assertRelayUrlAllowed } from "@away/protocol";
import { createPairingOffer, startCompanion } from "./companion.ts";
import { ensureDataDir } from "./identity.ts";
import { Store } from "./store.ts";

const USAGE = `Usage: away <command>

  serve                      Connect to the relay and run agent sessions until stopped
  pair                       Print a single-use pairing offer (valid 5 minutes)
  projects add <path>        Allow a project folder to be used from paired devices
  projects list
  projects remove <id>
  devices list
  devices revoke <id>        Stop a device from connecting

Options:
  --relay <url>              Relay URL (default: $AWAY_RELAY_URL or ws://127.0.0.1:8787)
  --name <name>              Display name for "projects add"

Data is stored in $AWAY_HOME (default ~/.away). $AWAY_PI_COMMAND, $AWAY_CLAUDE_COMMAND and $AWAY_CODEX_COMMAND override agent executables.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { relay: { type: "string" }, name: { type: "string" }, help: { type: "boolean", short: "h" } },
});

const dataDir = process.env.AWAY_HOME ?? join(homedir(), ".away");
const relayUrl = values.relay ?? process.env.AWAY_RELAY_URL ?? "ws://127.0.0.1:8787";
const [command, subcommand, argument] = positionals;

function commandOverride(name: string): { command?: string } {
  const command = process.env[name];
  return command ? { command } : {};
}

function log(message: string) {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

function withStore<T>(action: (store: Store) => T): T {
  ensureDataDir(dataDir);
  const store = new Store(dataDir);
  try {
    return action(store);
  } finally {
    store.close();
  }
}

async function main() {
  if (values.help || !command) return console.log(USAGE);

  if (command === "serve") {
    assertRelayUrlAllowed(relayUrl);
    const companion = startCompanion({
      dataDir,
      relayUrl,
      adapters: [
        new PiAdapter(commandOverride("AWAY_PI_COMMAND")),
        new ClaudeAdapter(commandOverride("AWAY_CLAUDE_COMMAND")),
        new CodexAdapter(commandOverride("AWAY_CODEX_COMMAND")),
      ],
      log,
      onRelayState: (state, detail) => log(`Relay ${state}${detail ? ` (${detail})` : ""}`),
    });
    log(`Away companion "${companion.identity.name}" serving via ${relayUrl}. Press Ctrl+C to stop.`);
    log("Stopping Away ends running agent sessions and remote access.");
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      log("Stopping…");
      await companion.stop();
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  if (command === "pair") {
    assertRelayUrlAllowed(relayUrl);
    console.log(createPairingOffer(dataDir, relayUrl));
    console.error("Single use, valid for 5 minutes. Anyone with this text can pair, so share it only with your own device.");
    return;
  }

  if (command === "projects") {
    return withStore((store) => {
      if (subcommand === "add" && argument) {
        const path = realpathSync(resolve(argument));
        if (!statSync(path).isDirectory()) throw new Error(`${path} is not a directory`);
        const project = store.addProject(path, values.name ?? basename(path));
        console.log(`${project.id}  ${project.name}  ${project.path}`);
      } else if (subcommand === "list") {
        for (const project of store.listProjects()) console.log(`${project.id}  ${project.name}  ${project.path}`);
      } else if (subcommand === "remove" && argument) {
        console.log(store.removeProject(argument) ? "Removed" : "No such project");
      } else console.log(USAGE);
    });
  }

  if (command === "devices") {
    return withStore((store) => {
      if (subcommand === "list") {
        for (const device of store.listDevices()) {
          console.log(`${device.id}  ${device.name}  paired ${device.pairedAt}${device.revokedAt ? `  REVOKED ${device.revokedAt}` : ""}`);
        }
      } else if (subcommand === "revoke" && argument) {
        console.log(store.revokeDevice(argument) ? "Revoked" : "No such active device");
      } else console.log(USAGE);
    });
  }

  console.log(USAGE);
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
