// Manual check against the real Codex install:
//   pnpm --filter @away/adapter-codex smoke --cwd <project> [--prompt "text"] [--interrupt-after-ms 2000]
// Uses an ephemeral thread so nothing is added to ~/.codex/sessions. Approvals are printed and declined.
import { parseArgs } from "node:util";
import { CodexAdapter } from "../src/index.ts";

const { values } = parseArgs({
  options: {
    cwd: { type: "string", default: process.cwd() },
    prompt: { type: "string" },
    "interrupt-after-ms": { type: "string" },
  },
});

const adapter = new CodexAdapter({ ephemeral: true });
console.log("detect:", await adapter.detect());
const session = await adapter.startSession({ cwd: values.cwd });
console.log("started, thread id:", session.nativeSessionId);

const settled = new Promise<void>((resolve) => {
  session.onEvent((event) => {
    if (event.type === "text_delta") process.stdout.write(event.delta);
    else console.log("\nevent:", JSON.stringify(event).slice(0, 400));
    if (event.type === "input_requested") void session.respondToInput(event.requestId, { kind: "approval", decision: "deny" });
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
