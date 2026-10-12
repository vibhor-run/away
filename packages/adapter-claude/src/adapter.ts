import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, AgentAvailability, StartSessionOptions } from "@away/adapter-core";
import type { AgentCapabilities } from "@away/protocol";
import { ClaudeSession, type QueryFunction } from "./session.ts";

const execFileAsync = promisify(execFile);

export interface ClaudeAdapterOptions {
  /** Claude Code executable. Defaults to `claude` on PATH: the user's own install, config, and login. */
  command?: string;
  /** Replaces the SDK's `query` in tests. */
  query?: QueryFunction;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude";
  readonly displayName = "Claude Code";
  readonly capabilities: AgentCapabilities = {
    resume: true,
    interrupt: true,
    // Claude Code asks through canUseTool when the user's permission mode and rules require it.
    toolApprovals: true,
    // AskUserQuestion.
    userInput: true,
  };

  #command: string;
  #query: QueryFunction;
  #startupTimeoutMs: number;
  #closeTimeoutMs: number;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.#command = options.command ?? "claude";
    this.#query = options.query ?? (query as QueryFunction);
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 60_000;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  }

  async detect(): Promise<AgentAvailability> {
    const executable = resolveExecutable(this.#command);
    if (!executable) return { installed: false, supported: false, reason: `${this.#command} was not found on PATH` };
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(executable, ["--version"], { timeout: 10_000 }));
    } catch (error) {
      return { installed: false, supported: false, reason: (error as Error).message };
    }
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(stdout.trim());
    const version = match?.[0] ?? stdout.trim();
    // Built against Agent SDK 0.3.296 (which bundles Claude Code 2.1.296). Not yet verified live.
    const supported = match !== null && Number(match[1]) === 2 && Number(match[2]) >= 1;
    return { installed: true, supported, version, ...(!supported && { reason: "Away targets Claude Code 2.1+" }) };
  }

  startSession(options: StartSessionOptions): Promise<ClaudeSession> {
    const executable = resolveExecutable(this.#command);
    if (!executable) return Promise.reject(new Error(`${this.#command} was not found on PATH`));
    return ClaudeSession.start({
      query: this.#query,
      executable,
      cwd: options.cwd,
      startupTimeoutMs: this.#startupTimeoutMs,
      closeTimeoutMs: this.#closeTimeoutMs,
      ...(options.resumeSessionId !== undefined && { resumeSessionId: options.resumeSessionId }),
    });
  }
}

/** Finds an executable on PATH. The SDK needs a path, not a bare command name. */
function resolveExecutable(command: string): string | undefined {
  const candidates = isAbsolute(command) ? [command] : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}
