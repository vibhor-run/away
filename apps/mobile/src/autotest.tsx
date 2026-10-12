// Development only: EXPO_PUBLIC_AWAY_AUTOTEST_OFFER=<pairing link> makes the app pair, run a Pi
// prompt and a Codex approval through the real screens, and log the result to the Metro terminal.
import type { SessionEventMessage } from "@away/client";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { useAway } from "./away";

const OFFER = __DEV__ ? process.env.EXPO_PUBLIC_AWAY_AUTOTEST_OFFER : undefined;
const log = (message: string) => console.log(`[away-autotest] ${message}`);

export function Autotest() {
  const { device, client, connection, projects, pair } = useAway();
  const started = useRef(false);
  const paired = useRef(false);

  useEffect(() => {
    if (!OFFER || !device || device.laptop || paired.current) return;
    paired.current = true;
    pair(OFFER).then(
      () => log("paired"),
      (error: Error) => log(`FAIL pairing: ${error.message}`),
    );
  }, [device]);

  useEffect(() => {
    if (!OFFER || !client || connection.state !== "connected" || projects.length === 0 || started.current) return;
    started.current = true;
    void run().then(
      () => log("PASS"),
      (error: Error) => log(`FAIL: ${error.message}`),
    );

    async function run() {
      const project = projects[0]!;
      for (const [agent, text] of [["pi", "hello"], ["codex", "run"]] as const) {
        const session = await client!.request<{ id: string }>({ kind: "start_session", agent, projectId: project.id });
        router.push({ pathname: "/session/[id]", params: { id: session.id } });
        await wait(1500);
        const approvals = (message: SessionEventMessage) => {
          if (message.sessionId !== session.id || message.event.type !== "input_requested") return;
          log(`approval requested: ${message.event.title}`);
          const requestId = message.event.requestId;
          // Leave the approval sheet visible for a moment so it can be captured.
          void wait(4000).then(() => client!.request({ kind: "respond_input", sessionId: session.id, requestId, response: { kind: "approval", decision: "allow" } }));
        };
        client!.listeners.sessionEvent.add(approvals);
        const prompt = client!.send({ kind: "send_prompt", sessionId: session.id, text });
        const final = await client!.waitForFinal(prompt.commandId);
        client!.listeners.sessionEvent.delete(approvals);
        log(`${agent}: ${final.status}`);
        if (final.status !== "completed") throw new Error(`${agent} prompt ${final.status}`);
        await wait(agent === "pi" ? 1500 : 4000);
        router.back();
      }
    }
  }, [client, connection.state, projects]);

  return null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
