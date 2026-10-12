import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAdapter } from "@away/adapter-codex";
import { PiAdapter } from "@away/adapter-pi";
import { AwayClient, pairWithLaptop, type PairedLaptop, type SessionEventMessage, type TrackedStatus } from "@away/client";
import type { AgentInfo, Project, SessionSummary } from "@away/protocol";
import { buildRelay } from "@away/relay";
import { generateStaticKeyPair, type StaticKeyPair } from "@away/secure-channel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPairingOffer, startCompanion, type Companion } from "../src/index.ts";

const fakePi = fileURLToPath(new URL("../../adapter-pi/test/fixtures/fake-pi.mjs", import.meta.url));
const fakeCodex = fileURLToPath(new URL("../../adapter-codex/test/fixtures/fake-codex.mjs", import.meta.url));

let relay: Awaited<ReturnType<typeof buildRelay>>;
let relayUrl: string;
let dataDir: string;
let companion: Companion;
let project: Project;
const clients: AwayClient[] = [];

async function until<T>(check: () => T | undefined | false, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function launchCompanion(): Promise<Companion> {
  return new Promise((resolve) => {
    const started: Companion = startCompanion({
      dataDir,
      relayUrl,
      adapters: [
        new PiAdapter({ command: fakePi, closeTimeoutMs: 1000 }),
        new CodexAdapter({ command: fakeCodex, closeTimeoutMs: 1000 }),
      ],
      onRelayState: (state) => state === "online" && resolve(started),
    });
  });
}

async function pairedClient(): Promise<{ client: AwayClient; laptop: PairedLaptop; keys: StaticKeyPair }> {
  const keys = generateStaticKeyPair();
  const laptop = await pairWithLaptop(createPairingOffer(dataDir, relayUrl), "Test phone", keys);
  const client = new AwayClient(laptop, keys, { heartbeatMs: 1000 });
  clients.push(client);
  client.start();
  await until(() => client.state === "connected");
  return { client, laptop, keys };
}

function record(client: AwayClient) {
  const events: SessionEventMessage[] = [];
  const statuses = new Map<string, TrackedStatus[]>();
  client.listeners.sessionEvent.add((message) => events.push(message));
  client.listeners.command.add((command) => {
    const list = statuses.get(command.commandId) ?? [];
    if (list.at(-1) !== command.status) list.push(command.status);
    statuses.set(command.commandId, list);
  });
  return { events, statuses };
}

async function startSession(client: AwayClient): Promise<SessionSummary> {
  const session = await client.request<SessionSummary>({ kind: "start_session", agent: "pi", projectId: project.id });
  client.subscribe(session.id);
  return session;
}

beforeEach(async () => {
  relay = await buildRelay();
  await relay.listen({ host: "127.0.0.1", port: 0 });
  relayUrl = `ws://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
  dataDir = mkdtempSync(join(tmpdir(), "away-e2e-"));
  companion = await launchCompanion();
  project = companion.store.addProject(mkdtempSync(join(tmpdir(), "away-project-")), "demo");
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  await companion.stop();
  await relay.close();
});

describe("pairing", () => {
  it("pairs once per offer and refuses unknown devices", async () => {
    const offer = createPairingOffer(dataDir, relayUrl);
    const laptop = await pairWithLaptop(offer, "Phone", generateStaticKeyPair());
    expect(laptop.deviceId).toBe(companion.store.listDevices()[0]!.id);
    await expect(pairWithLaptop(offer, "Thief", generateStaticKeyPair())).rejects.toThrow(/already used/);

    const stranger = new AwayClient(laptop, generateStaticKeyPair());
    clients.push(stranger);
    stranger.start();
    await until(() => stranger.state === "rejected");
    expect(companion.store.listDevices()).toHaveLength(1);
  });

  it("refuses a laptop key that does not match the offer", async () => {
    const offer = createPairingOffer(dataDir, relayUrl);
    const forged = offer.replace(/key=[^&]+/, `key=${Buffer.from(generateStaticKeyPair().publicKey).toString("base64url")}`);
    await expect(pairWithLaptop(forged, "Phone", generateStaticKeyPair())).rejects.toThrow();
    expect(companion.store.listDevices()).toHaveLength(0);
  });
});

describe("remote sessions", () => {
  it("lists agents and runs a prompt through every status", async () => {
    const { client } = await pairedClient();
    const { events, statuses } = record(client);
    const agents = await client.request<AgentInfo[]>({ kind: "list_agents" });
    expect(agents).toMatchObject([
      { id: "pi", installed: true, supported: true, capabilities: { toolApprovals: false } },
      { id: "codex", installed: true, supported: true, capabilities: { toolApprovals: true } },
    ]);
    expect(await client.request<Project[]>({ kind: "list_projects" })).toEqual([project]);

    const session = await startSession(client);
    const prompt = client.send({ kind: "send_prompt", sessionId: session.id, text: "hello" });
    expect((await client.waitForFinal(prompt.commandId)).status).toBe("completed");
    expect(statuses.get(prompt.commandId)).toEqual(["submitted", "received", "accepted", "completed"]);

    await until(() => events.some((message) => message.event.type === "run_settled"));
    const reply = events.find((message) => message.event.type === "message_completed" && message.event.role === "assistant");
    expect(reply?.event).toMatchObject({ text: "Hi  there" });
  });

  it("keeps the agent running across a dropped connection and resumes without gaps or duplicates", async () => {
    const { client } = await pairedClient();
    const { events, statuses } = record(client);
    const session = await startSession(client);
    const prompt = client.send({ kind: "send_prompt", sessionId: session.id, text: "slow" });
    await until(() => events.filter((message) => message.event.type === "text_delta").length >= 3);

    client.dropConnection();
    await until(() => client.state === "disconnected");
    await until(() => client.state === "connected");
    const deltasBefore = events.filter((message) => message.event.type === "text_delta").length;
    await until(() => events.filter((message) => message.event.type === "text_delta").length > deltasBefore + 3);

    await client.request({ kind: "interrupt", sessionId: session.id });
    expect((await client.waitForFinal(prompt.commandId)).status).toBe("interrupted");
    expect(statuses.get(prompt.commandId)).toEqual(["submitted", "received", "accepted", "interrupted"]);

    await until(() => events.some((message) => message.event.type === "run_settled"));
    const seqs = events.map((message) => message.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
    const stored = companion.store.eventsAfter(session.id, 0);
    expect(stored.filter((entry) => entry.event.type === "prompt_sent")).toHaveLength(1);
  });

  it("never runs a command id twice", async () => {
    const keys = generateStaticKeyPair();
    const laptop = await pairWithLaptop(createPairingOffer(dataDir, relayUrl), "Phone", keys);
    const fixedId = crypto.randomUUID();
    let useFixed = false;
    const client = new AwayClient(laptop, keys, { newId: () => (useFixed ? fixedId : crypto.randomUUID()) });
    clients.push(client);
    client.start();
    await until(() => client.state === "connected");
    const session = await startSession(client);

    useFixed = true;
    const first = client.send({ kind: "send_prompt", sessionId: session.id, text: "hello" });
    await client.waitForFinal(first.commandId);
    const again = client.send({ kind: "send_prompt", sessionId: session.id, text: "hello" });
    expect((await client.waitForFinal(again.commandId)).status).toBe("completed");

    const prompts = companion.store.eventsAfter(session.id, 0).filter((entry) => entry.event.type === "prompt_sent");
    expect(prompts).toHaveLength(1);
  });

  it("refuses a second prompt while the agent is busy", async () => {
    const { client } = await pairedClient();
    const session = await startSession(client);
    client.send({ kind: "send_prompt", sessionId: session.id, text: "slow" });
    const second = client.send({ kind: "send_prompt", sessionId: session.id, text: "hello" });
    const final = await client.waitForFinal(second.commandId);
    expect(final).toMatchObject({ status: "failed", error: expect.stringMatching(/busy/) });
    await client.request({ kind: "interrupt", sessionId: session.id });
  });

  it("forwards agent questions and answers", async () => {
    const { client } = await pairedClient();
    const { events } = record(client);
    const session = await startSession(client);
    client.send({ kind: "send_prompt", sessionId: session.id, text: "ask" });
    const question = await until(() => events.find((message) => message.event.type === "input_requested"));
    if (question.event.type !== "input_requested") throw new Error("unreachable");
    await client.request({
      kind: "respond_input",
      sessionId: session.id,
      requestId: question.event.requestId,
      response: { kind: "confirm", confirmed: true },
    });
    await until(() =>
      events.some((message) => message.event.type === "message_completed" && message.event.text === "confirmed:true"),
    );
    await expect(
      client.request({
        kind: "respond_input",
        sessionId: session.id,
        requestId: question.event.requestId,
        response: { kind: "confirm", confirmed: false },
      }),
    ).rejects.toThrow(/already answered/);
  });

  it("routes a tool approval from the agent to the device and back", async () => {
    const { client } = await pairedClient();
    const { events, statuses } = record(client);
    const session = await client.request<SessionSummary>({ kind: "start_session", agent: "codex", projectId: project.id });
    client.subscribe(session.id);
    const prompt = client.send({ kind: "send_prompt", sessionId: session.id, text: "run" });

    const request = await until(() => events.find((message) => message.event.type === "input_requested"));
    if (request.event.type !== "input_requested") throw new Error("unreachable");
    expect(request.event).toMatchObject({ kind: "approval", tool: { name: "command", input: { command: "echo hi" } } });
    const respond = (decision: "allow" | "deny") =>
      client.request({ kind: "respond_input", sessionId: session.id, requestId: (request.event as { requestId: string }).requestId, response: { kind: "approval", decision } });
    await respond("allow");

    expect((await client.waitForFinal(prompt.commandId)).status).toBe("completed");
    expect(statuses.get(prompt.commandId)).toEqual(["submitted", "received", "accepted", "completed"]);
    await until(() => events.some((message) => message.event.type === "tool_finished"));
    expect(events.find((message) => message.event.type === "tool_finished")?.event).toMatchObject({ output: "hi\n", isError: false });
    expect(events.some((message) => message.event.type === "input_resolved")).toBe(true);
    await expect(respond("deny")).rejects.toThrow(/already answered/);
  });

  it("cuts off a revoked device", async () => {
    const { client, laptop } = await pairedClient();
    companion.store.revokeDevice(laptop.deviceId);
    client.send({ kind: "list_projects" });
    await until(() => client.state === "rejected");
  });

  it("reports work stopped by a companion restart and can resume the session", async () => {
    const { client } = await pairedClient();
    const session = await startSession(client);
    const prompt = client.send({ kind: "send_prompt", sessionId: session.id, text: "slow" });
    await until(() => client.pendingCommands().some((command) => command.status === "accepted"));

    await companion.stop();
    companion = await launchCompanion();
    await until(() => client.state === "connected", 8000);

    const final = await client.waitForFinal(prompt.commandId);
    expect(final).toMatchObject({ status: "failed", error: expect.stringMatching(/Away was stopped/) });
    expect(companion.store.getSession(session.id)?.status).toBe("ended");

    const resumed = await client.request<SessionSummary>({ kind: "resume_session", sessionId: session.id });
    expect(resumed).toMatchObject({ id: session.id, status: "idle", nativeSessionId: "fake-session" });
  });
});
