#!/usr/bin/env node
// Scripted stand-in for `codex app-server`, following codex-cli 0.162.1 generated bindings.
// The turn text selects a scenario: hello, run, ask, fail, slow, unknown.
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.162.1");
  process.exit(0);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params: { threadId: "thread-1", ...params }, emittedAtMs: Date.now() });
let initialized = false;
let threadId;
let turn;
let serverRequestId = 0;
const waiting = new Map();
let slowTimer;

function startTurn(id, text) {
  turn = { id: `turn-${Date.now()}`, text };
  if (text === "early") {
    // Completion is written before the turn/start response.
    const turnId = turn.id;
    complete("completed");
    return send({ id, result: { turn: { id: turnId, items: [], status: "completed", error: null } } });
  }
  send({ id, result: { turn: { id: turn.id, items: [], status: "inProgress", error: null } } });
  notify("turn/started", { turn: { id: turn.id, status: "inProgress" } });
  notify("item/completed", { turnId: turn.id, item: { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text, text_elements: [] }] } });
  if (text === "hello") {
    notify("item/started", { turnId: turn.id, item: { type: "agentMessage", id: "msg-1", text: "", phase: null } });
    notify("item/agentMessage/delta", { turnId: turn.id, itemId: "msg-1", delta: "Hello " });
    notify("item/agentMessage/delta", { turnId: turn.id, itemId: "msg-1", delta: "there" });
    notify("item/completed", { turnId: turn.id, item: { type: "agentMessage", id: "msg-1", text: "Hello there", phase: "final_answer" } });
    complete("completed");
  } else if (text === "run") {
    const requestId = serverRequestId++;
    waiting.set(requestId, (result) => {
      notify("serverRequest/resolved", { requestId });
      const accepted = result.decision === "accept" || result.decision === "acceptForSession";
      notify("item/started", { turnId: turn.id, item: command("inProgress") });
      if (accepted) {
        notify("item/commandExecution/outputDelta", { turnId: turn.id, itemId: "exec-1", delta: "hi\n" });
        notify("item/completed", { turnId: turn.id, item: { ...command("completed"), aggregatedOutput: "hi\n", exitCode: 0 } });
      } else {
        notify("item/completed", { turnId: turn.id, item: command("declined") });
      }
      complete("completed", { decision: result.decision });
    });
    send({ method: "item/commandExecution/requestApproval", id: requestId, params: { kind: "command", threadId, turnId: turn.id, itemId: "exec-1", startedAtMs: Date.now(), environmentId: "local", command: "echo hi", cwd: "/work" } });
  } else if (text === "ask") {
    const requestId = serverRequestId++;
    waiting.set(requestId, (result) => {
      notify("serverRequest/resolved", { requestId });
      notify("item/completed", { turnId: turn.id, item: { type: "agentMessage", id: "msg-2", text: `answer:${result.answers.color.answers.join(",")}`, phase: null } });
      complete("completed");
    });
    send({ method: "item/tool/requestUserInput", id: requestId, params: { threadId, turnId: turn.id, itemId: "q1", isBlocking: true, autoResolutionMs: null, questions: [{ id: "color", header: "Color", question: "Pick a color", isOther: false, isSecret: false, options: [{ label: "red", description: "warm" }, { label: "blue", description: "cool" }] }] } });
  } else if (text === "fail") {
    notify("error", { turnId: turn.id, error: { message: "usage limit", codexErrorInfo: "usageLimitExceeded" }, willRetry: false });
    complete("failed", null, { message: "usage limit", codexErrorInfo: "usageLimitExceeded" });
  } else if (text === "slow") {
    notify("item/started", { turnId: turn.id, item: { type: "agentMessage", id: "msg-3", text: "", phase: null } });
    slowTimer = setInterval(() => notify("item/agentMessage/delta", { turnId: turn.id, itemId: "msg-3", delta: "." }), 20);
  } else if (text === "unknown") {
    send({ method: "item/tool/call", id: serverRequestId++, params: { threadId } });
  }
}

function command(status) {
  return { type: "commandExecution", id: "exec-1", command: "echo hi", cwd: "/work", processId: null, source: "agent", status, commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
}

function complete(status, _extra, error = null) {
  clearInterval(slowTimer);
  notify("turn/completed", { turn: { id: turn.id, items: [], status, error } });
  turn = undefined;
}

function handle(message) {
  if (message.method === undefined) {
    // A response to one of our server requests.
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) {
      process.stderr.write(`client error for ${message.id}: ${message.error.message}\n`);
      complete("completed");
    } else resolve?.(message.result);
    return;
  }
  if (message.method === "initialize") {
    if (initialized) return send({ id: message.id, error: { code: -32600, message: "Already initialized" } });
    initialized = true;
    return send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } });
  }
  if (message.method === "initialized") return;
  if (!initialized) return send({ id: message.id, error: { code: -32600, message: "Not initialized" } });
  switch (message.method) {
    case "account/read":
      return send({ id: message.id, result: process.env.FAKE_CODEX_LOGGED_OUT ? { account: null, requiresOpenaiAuth: true } : { account: { type: "chatgpt", email: "x", planType: "plus" }, requiresOpenaiAuth: true } });
    case "thread/start":
      threadId = "thread-1";
      return send({ id: message.id, result: { thread: { id: threadId, cwd: message.params.cwd, ephemeral: Boolean(message.params.ephemeral) } } });
    case "thread/resume":
      threadId = message.params.threadId;
      return send({ id: message.id, result: { thread: { id: threadId } } });
    case "turn/start":
      if (turn) return send({ id: message.id, error: { code: -32600, message: "turn already active" } });
      return startTurn(message.id, message.params.input[0].text);
    case "turn/interrupt":
      send({ id: message.id, result: {} });
      if (turn) complete("interrupted");
      return;
    default:
      return send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) if (line.trim()) handle(JSON.parse(line));
});
process.stdin.on("end", () => process.exit(0));
