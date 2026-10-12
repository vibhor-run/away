import { describe, expect, it } from "vitest";
import { JsonlSplitter } from "../src/jsonl.ts";

describe("JsonlSplitter", () => {
  it("keeps U+2028 and U+2029 inside a record", () => {
    const splitter = new JsonlSplitter();
    const record = JSON.stringify({ delta: "a b c" });
    expect(splitter.push(`${record}\n`)).toEqual([record]);
  });

  it("reassembles a multi-byte character split across chunks", () => {
    const splitter = new JsonlSplitter();
    const bytes = Buffer.from('{"t":"é✓"}\n', "utf8");
    const first = splitter.push(bytes.subarray(0, 7));
    const second = splitter.push(bytes.subarray(7));
    expect(first).toEqual([]);
    expect(second).toEqual(['{"t":"é✓"}']);
  });

  it("accepts CRLF and holds partial records until terminated", () => {
    const splitter = new JsonlSplitter();
    expect(splitter.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(":2}")).toEqual([]);
    expect(splitter.end()).toEqual(['{"b":2}']);
  });
});
