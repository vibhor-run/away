import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeKey, encodeKey } from "../src/keys.ts";

describe("key encoding", () => {
  it("matches Node's base64url and round-trips", () => {
    for (let index = 0; index < 50; index++) {
      const key = new Uint8Array(randomBytes(32));
      expect(encodeKey(key)).toBe(Buffer.from(key).toString("base64url"));
      expect(decodeKey(encodeKey(key))).toEqual(key);
    }
  });

  it("rejects malformed keys", () => {
    expect(() => decodeKey("abc+/")).toThrow(/base64url/);
    expect(() => decodeKey("AAAA")).toThrow(/32 bytes/);
  });
});
