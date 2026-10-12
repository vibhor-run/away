import { StringDecoder } from "node:string_decoder";

/**
 * Splits a byte stream into JSONL records on LF only.
 *
 * Node's `readline` also splits on U+2028/U+2029, which are legal inside JSON strings,
 * so it must not be used for agent protocols. LF is a single ASCII byte and can never
 * appear inside a multi-byte UTF-8 sequence, so decoding before splitting is safe.
 */
export class JsonlSplitter {
  #decoder = new StringDecoder("utf8");
  #buffer = "";

  push(chunk: Buffer | string): string[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines.map(stripCr).filter((line) => line.length > 0);
  }

  /** Returns any final record that was not terminated by LF. */
  end(): string[] {
    const rest = stripCr(this.#buffer + this.#decoder.end());
    this.#buffer = "";
    return rest.length > 0 ? [rest] : [];
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
