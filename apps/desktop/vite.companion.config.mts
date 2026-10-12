import { defineConfig } from "vite";

// The companion runs in a utilityProcess as an ES module. Our workspace packages are bundled in;
// packages with native code or their own bundled binaries are loaded from node_modules at runtime.
export default defineConfig({
  build: {
    lib: {
      entry: "src/companion/worker.ts",
      formats: ["es"],
      fileName: () => "companion.mjs",
    },
    rollupOptions: {
      external: [/^node:/, "noise-handshake", /^noise-handshake\//, /^sodium-/, /^@anthropic-ai\//, /^@modelcontextprotocol\//],
    },
  },
  resolve: { conditions: ["node"] },
});
