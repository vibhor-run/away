// Manual check against the real Pi install:
//   pnpm --filter @away/adapter-pi smoke --cwd <project> [--prompt "text"] [--interrupt-after-ms 2000]
// Uses --no-session so nothing is added to Pi's session history.
import { parseArgs } from "node:util";
import { PiAdapter } from "../src/index.ts";

const { values } = parseArgs({
  options: {
    cwd: { type: "string", default: process.cwd() },
    prompt: { type: "string" },
    "interrupt-after-ms": { type: "string" },
  },
});

const adapter = new PiAdapter({ ephemeral: true });
console.log("detect:", await adapter.detect());

const session = await adapter.startSession({ cwd: values.cwd });
console.log("started, native session id:", session.nativeSessionId);

const settled = new Promise<void>((resolve) => {
  session.onEvent((event) => {
    if (event.type === "text_delta") process.stdout.write(event.delta);
    else console.log("\nevent:", JSON.stringify(event));
    if (event.type === "run_settled" || event.type === "process_exited") resolve();
  });
});

if (values.prompt !== undefined) {
  try {
    console.log("prompt disposition:", await session.sendPrompt(values.prompt));
    const interruptAfter = values["interrupt-after-ms"];
    if (interruptAfter !== undefined) {
      setTimeout(() => {
        console.log("\n-> interrupting");
        void session.interrupt();
      }, Number(interruptAfter));
    }
    await settled;
  } catch (error) {
    console.log("prompt rejected:", (error as Error).message);
  }
}

await session.close();
console.log("closed");
