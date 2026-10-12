#!/usr/bin/env node
// Scripted stand-in for `pi --mode rpc`, emitting records shaped like Pi 1.1.0 docs/json.md.
// The prompt text selects a scenario: hello, tool, slow, ask, crash.

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("1.1.0");
  process.exit(0);
}

const sessionIndex = argv.indexOf("--session");
const sessionId = sessionIndex >= 0 ? argv[sessionIndex + 1] : "fake-session";
let streaming = false;
let slowTimer;

const send = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (id, command, data) => send({ id, type: "response", command, success: true, data });
const assistant = (text, stopReason = "stop") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason,
  timestamp: Date.now(),
});

function runText(text) {
  send({ type: "agent_start" });
  send({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  send({ type: "message_end", message: assistant(text) });
  send({ type: "agent_end", messages: [], willRetry: false });
  send({ type: "agent_settled", aborted: false });
  streaming = false;
}

function handle(command) {
  switch (command.type) {
    case "get_state":
      return respond(command.id, "get_state", { sessionId, isStreaming: streaming, messageCount: 0 });
    case "prompt": {
      if (streaming) {
        return send({ id: command.id, type: "response", command: "prompt", success: false, error: "Agent is already streaming" });
      }
      const message = command.message;
      if (message === "crash") process.exit(3);
      streaming = true;
      respond(command.id, "prompt", { disposition: "started" });
      send({ type: "message_start", message: { role: "user", content: message } });
      send({ type: "message_end", message: { role: "user", content: message } });
      if (message === "hello") {
        send({ type: "agent_start" });
        send({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi " } });
        send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " there" } });
        send({ type: "message_end", message: assistant("Hi  there") });
        send({ type: "agent_end", messages: [], willRetry: false });
        send({ type: "agent_settled", aborted: false });
        streaming = false;
      } else if (message === "tool") {
        send({ type: "agent_start" });
        send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } });
        send({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "a" }] } });
        send({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "a\nb" }] }, isError: false });
        runText("done");
      } else if (message === "slow") {
        send({ type: "agent_start" });
        send({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
        slowTimer = setInterval(() => {
          send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "." } });
        }, 20);
      } else if (message === "ask") {
        send({ type: "agent_start" });
        send({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?", message: "Run rm?", timeout: 60000 });
      } else {
        runText(`echo:${message}`);
      }
      return;
    }
    case "abort":
      if (!slowTimer) return respond(command.id, "abort");
      clearInterval(slowTimer);
      slowTimer = undefined;
      send({ type: "message_end", message: assistant("...", "aborted") });
      send({ type: "agent_end", messages: [], willRetry: false });
      send({ type: "agent_settled", aborted: true });
      streaming = false;
      return respond(command.id, "abort");
    case "extension_ui_response":
      if (command.id === "ui-1") runText(`confirmed:${command.confirmed === true}`);
      return;
    default:
      return send({ id: command.id, type: "response", command: command.type, success: false, error: "unsupported in fake" });
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
process.stdin.on("end", () => {
  clearInterval(slowTimer);
  process.exit(0);
});
