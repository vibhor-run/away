// Manual check against the real Claude Code install:
//   pnpm --filter @away/adapter-claude smoke --cwd <project> --prompt "text" [--allow] [--interrupt-after-ms 2000]
// Approval requests are printed and denied unless --allow is passed.
import { parseArgs } from "node:util";
import { ClaudeAdapter } from "../src/index.ts";

const { values } = parseArgs({
  options: {
    cwd: { type: "string", default: process.cwd() },
    prompt: { type: "string" },
    allow: { type: "boolean", default: false },
    "interrupt-after-ms": { type: "string" },
  },
});

const adapter = new ClaudeAdapter();
console.log("detect:", await adapter.detect());
const session = await adapter.startSession({ cwd: values.cwd });
console.log("started, session id:", session.nativeSessionId);

const settled = new Promise<void>((resolve) => {
  session.onEvent((event) => {
    if (event.type === "text_delta") return void process.stdout.write(event.delta);
    console.log("\nevent:", JSON.stringify(event).slice(0, 400));
    if (event.type === "input_requested") {
      const decision = values.allow ? "allow" : "deny";
      void session.respondToInput(event.requestId, event.kind === "approval" ? { kind: "approval", decision } : { kind: "cancel" });
    }
    if (event.type === "run_settled" || event.type === "process_exited") resolve();
  });
});

if (values.prompt !== undefined) {
  console.log("prompt disposition:", await session.sendPrompt(values.prompt));
  const interruptAfter = values["interrupt-after-ms"];
  if (interruptAfter !== undefined) setTimeout(() => void session.interrupt(), Number(interruptAfter));
  await settled;
}
await session.close();
console.log("closed");
