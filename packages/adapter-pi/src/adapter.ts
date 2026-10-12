import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentAdapter, AgentAvailability, StartSessionOptions } from "@away/adapter-core";
import type { AgentCapabilities } from "@away/protocol";
import { PiSession } from "./session.ts";

const execFileAsync = promisify(execFile);

/** Pi versions this adapter was verified against. */
const SUPPORTED_MAJOR = 1;
const MIN_SUPPORTED_MINOR = 1;

export interface PiAdapterOptions {
  /** Pi executable. Defaults to `pi` on PATH, which uses the user's own Pi install and config. */
  command?: string;
  /** Use `--no-session` so nothing is written to Pi's session history. */
  ephemeral?: boolean;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
}

export class PiAdapter implements AgentAdapter {
  readonly id = "pi";
  readonly displayName = "Pi";
  readonly capabilities: AgentCapabilities = {
    resume: true,
    interrupt: true,
    // Pi does not gate tool calls behind approvals (see Pi docs/security.md).
    toolApprovals: false,
    // Pi extensions can open select/confirm/input/editor dialogs over RPC.
    userInput: true,
  };

  #options: Required<Omit<PiAdapterOptions, "ephemeral">> & { ephemeral: boolean };

  constructor(options: PiAdapterOptions = {}) {
    this.#options = {
      command: options.command ?? "pi",
      ephemeral: options.ephemeral ?? false,
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      closeTimeoutMs: options.closeTimeoutMs ?? 5_000,
    };
  }

  async detect(): Promise<AgentAvailability> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(this.#options.command, ["--version"], { timeout: 10_000 }));
    } catch (error) {
      return { installed: false, supported: false, reason: (error as Error).message };
    }
    const version = stdout.trim();
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    const supported =
      match !== null && Number(match[1]) === SUPPORTED_MAJOR && Number(match[2]) >= MIN_SUPPORTED_MINOR;
    return {
      installed: true,
      supported,
      version,
      ...(!supported && { reason: `Away is verified with Pi ${SUPPORTED_MAJOR}.${MIN_SUPPORTED_MINOR}+ (1.x)` }),
    };
  }

  startSession(options: StartSessionOptions): Promise<PiSession> {
    return PiSession.start({
      command: this.#options.command,
      cwd: options.cwd,
      ephemeral: this.#options.ephemeral,
      startupTimeoutMs: this.#options.startupTimeoutMs,
      closeTimeoutMs: this.#options.closeTimeoutMs,
      ...(options.resumeSessionId !== undefined && { resumeSessionId: options.resumeSessionId }),
    });
  }
}
