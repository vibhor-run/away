import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { JsonlSplitter } from "./jsonl.ts";

const STDERR_TAIL_LINES = 50;

export interface JsonlChildProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Called for every stdout record that parses as JSON. Other lines are ignored. */
  onRecord(record: unknown): void;
  onExit(code: number | null, signal: string | null): void;
  closeTimeoutMs: number;
}

/**
 * A child process that speaks JSONL on stdin/stdout, as Pi's RPC mode and Codex's app-server do.
 * Stderr is kept as a short in-memory tail for local diagnostics and never forwarded to clients.
 */
export class JsonlChildProcess {
  #child: ChildProcessWithoutNullStreams;
  #closeTimeoutMs: number;
  #stderrTail: string[] = [];
  #exited: Promise<void>;

  private constructor(child: ChildProcessWithoutNullStreams, options: JsonlChildProcessOptions) {
    this.#child = child;
    this.#closeTimeoutMs = options.closeTimeoutMs;
    // Exit handling covers failures; these only stop EPIPE and kill errors from crashing the host.
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    const splitter = new JsonlSplitter();
    const handle = (line: string) => {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      options.onRecord(record);
    };
    child.stdout.on("data", (chunk: Buffer) => splitter.push(chunk).forEach(handle));
    child.stdout.on("end", () => splitter.end().forEach(handle));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      this.#stderrTail.push(...text.split("\n").filter(Boolean));
      this.#stderrTail.splice(0, Math.max(0, this.#stderrTail.length - STDERR_TAIL_LINES));
    });
    this.#exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        options.onExit(code, signal);
        resolve();
      });
    });
  }

  /** Starts the process. Rejects with the spawn error, for example ENOENT when not installed. */
  static async spawn(options: JsonlChildProcessOptions): Promise<JsonlChildProcess> {
    const child = spawn(options.command, options.args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    await once(child, "spawn");
    return new JsonlChildProcess(child, options);
  }

  get running(): boolean {
    return this.#child.exitCode === null && this.#child.signalCode === null;
  }

  stderrTail(): string {
    return this.#stderrTail.join("\n");
  }

  async write(record: unknown): Promise<void> {
    if (!this.#child.stdin.writable) throw new Error("The agent process is not accepting input");
    if (!this.#child.stdin.write(`${JSON.stringify(record)}\n`)) await once(this.#child.stdin, "drain");
  }

  /** Closes stdin (an orderly shutdown for JSONL agents), then escalates to SIGTERM and SIGKILL. */
  async close(): Promise<void> {
    if (!this.running) return this.#exited;
    this.#child.stdin.end();
    if (await this.#waitForExit()) return;
    this.#child.kill("SIGTERM");
    if (await this.#waitForExit()) return;
    this.#child.kill("SIGKILL");
    await this.#exited;
  }

  async #waitForExit(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), this.#closeTimeoutMs)));
    const result = await Promise.race([this.#exited.then(() => true), timeout]);
    clearTimeout(timer);
    return result;
  }
}
