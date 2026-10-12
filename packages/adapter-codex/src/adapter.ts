import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentAdapter, AgentAvailability, StartSessionOptions } from "@away/adapter-core";
import type { AgentCapabilities } from "@away/protocol";
import { CodexSession } from "./session.ts";

const execFileAsync = promisify(execFile);

/** The app-server protocol was verified against codex-cli 0.162.1 (it is marked experimental). */
const MIN_VERIFIED = [0, 162, 0] as const;

export interface CodexAdapterOptions {
  /** Codex executable. Defaults to `codex` on PATH, which uses the user's own config and login. */
  command?: string;
  /** Keep threads out of ~/.codex/sessions. */
  ephemeral?: boolean;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly capabilities: AgentCapabilities = {
    resume: true,
    interrupt: true,
    // Codex asks before commands and file changes, depending on the user's approval policy.
    toolApprovals: true,
    userInput: true,
  };

  #options: Required<CodexAdapterOptions>;

  constructor(options: CodexAdapterOptions = {}) {
    this.#options = {
      command: options.command ?? "codex",
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
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
    const version = match?.[0] ?? stdout.trim();
    const parts = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [];
    const supported = parts.length === 3 && compare(parts, MIN_VERIFIED) >= 0;
    return {
      installed: true,
      supported,
      version,
      ...(!supported && { reason: `Away is verified with codex-cli ${MIN_VERIFIED.join(".")}+` }),
    };
  }

  startSession(options: StartSessionOptions): Promise<CodexSession> {
    return CodexSession.start({
      command: this.#options.command,
      cwd: options.cwd,
      ephemeral: this.#options.ephemeral,
      startupTimeoutMs: this.#options.startupTimeoutMs,
      closeTimeoutMs: this.#options.closeTimeoutMs,
      ...(options.resumeSessionId !== undefined && { resumeSessionId: options.resumeSessionId }),
    });
  }
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
