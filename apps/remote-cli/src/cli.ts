#!/usr/bin/env node
// A minimal terminal stand-in for the phone app, used to exercise the full remote path.
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { AwayClient, pairWithLaptop, type SessionEventMessage, type TrackedCommand } from "@away/client";
import type { AgentInfo, InputResponse, Project, Question, SessionSummary } from "@away/protocol";
import { loadState, saveState } from "./state.ts";

const HELP = `Commands (anything not starting with / is sent as a prompt to the open session):
  /agents                 List agents on the laptop
  /projects               List projects the laptop allows
  /sessions               List sessions
  /start <project#> [agent]   Start a session (default agent: pi) and open it
  /open <session#>        Open a session and replay its events
  /resume <session#>      Restart an ended session's agent with its native session id
  /stop                   Interrupt the current turn (the agent keeps running)
  /allow | /always | /deny [reason]   Answer a tool approval (/always = allow for this session)
  /answer <reply>         Answer a question: option numbers or text; separate several
                          questions with ";" and multiple choices with ","; "cancel" dismisses
  /close                  End the open session's agent process
  /pending                Show commands not yet finished
  /drop                   Simulate a network drop (reconnects automatically)
  /quit                   Exit this client (sessions keep running on the laptop)`;

const STATUS_TEXT: Record<TrackedCommand["status"], string> = {
  submitted: "· submitted on this device",
  received: "✓ received by laptop",
  accepted: "▶ accepted by agent",
  completed: "✔ completed",
  failed: "✖ failed",
  interrupted: "■ interrupted",
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const state = loadState();

  if (command === "pair") {
    const offer = rest[0];
    if (!offer) throw new Error('Usage: away-remote pair "<offer from away pair>"');
    const laptop = await pairWithLaptop(offer, `away-remote on ${hostname()}`, state.keys);
    saveState({ ...state, laptop });
    console.log(`Paired with "${laptop.laptopName}". Run away-remote to connect.`);
    return;
  }
  if (command) return console.log('Usage: away-remote pair "<offer>" | away-remote');
  if (!state.laptop) throw new Error('Not paired. On the laptop run "away pair", then: away-remote pair "<offer>"');

  const client = new AwayClient(state.laptop, state.keys);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let projects: Project[] = [];
  let sessions: SessionSummary[] = [];
  let openSession: string | undefined;
  let pendingQuestion: { requestId: string; kind: string; questions?: Question[]; allowAlways?: boolean } | undefined;
  let streaming = false;

  const print = (line: string) => {
    if (streaming) process.stdout.write("\n");
    streaming = false;
    process.stdout.write(`\r\x1b[K${line}\n`);
    rl.prompt(true);
  };

  client.listeners.state.add((connection, detail) => print(`[${connection}${detail ? `: ${detail}` : ""}]`));
  client.listeners.command.add((tracked) => {
    if (tracked.command.kind !== "send_prompt") {
      if (tracked.status === "failed") print(`✖ ${tracked.command.kind}: ${tracked.error}`);
      return;
    }
    print(`  ${STATUS_TEXT[tracked.status]}${tracked.error ? `: ${tracked.error}` : ""}`);
  });
  client.listeners.sessionEvent.add((message) => {
    if (message.sessionId === openSession) render(message);
  });

  function render({ event }: SessionEventMessage) {
    switch (event.type) {
      case "prompt_sent":
        return print(`you> ${event.text}`);
      case "text_delta":
        streaming = true;
        return void process.stdout.write(event.delta);
      case "message_completed":
        if (event.role === "assistant" && event.errorMessage) print(`agent error: ${event.errorMessage}`);
        else if (streaming) print("");
        return;
      case "tool_started":
        return print(`⚙ ${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`);
      case "tool_finished": {
        const lines = event.output.split("\n");
        const shown = lines.slice(0, 8).map((line) => `  │ ${line}`).join("\n");
        return print(`${event.isError ? "  ✖ tool error" : "  ✓ tool done"}\n${shown}${lines.length > 8 ? `\n  │ … ${lines.length - 8} more lines` : ""}`);
      }
      case "input_requested": {
        pendingQuestion = {
          requestId: event.requestId,
          kind: event.kind,
          ...(event.questions !== undefined && { questions: event.questions }),
          ...(event.allowAlways !== undefined && { allowAlways: event.allowAlways }),
        };
        if (event.kind === "approval") {
          const input = JSON.stringify(event.tool?.input ?? {}).slice(0, 300);
          return print(
            `? ${event.title}${event.message ? ` — ${event.message}` : ""}\n  ${event.tool?.name ?? "tool"} ${input}\n  /allow${event.allowAlways ? ", /always" : ""} or /deny [reason]`,
          );
        }
        if (event.kind === "questions") {
          const lines = (event.questions ?? []).map((question, index) => {
            const options = question.options.map((option, number) => `     ${number + 1}) ${option.label}${option.description ? ` — ${option.description}` : ""}`);
            return [`  Q${index + 1}. ${question.question}${question.multiSelect ? " (choose any)" : ""}`, ...options].join("\n");
          });
          return print(`? ${event.title}\n${lines.join("\n")}\n  /answer <choice>${(event.questions ?? []).length > 1 ? "; <choice>…" : ""}`);
        }
        return print(
          `? ${event.title}${event.message ? ` — ${event.message}` : ""}${event.options ? ` [${event.options.join(" / ")}]` : ""}  (use /answer)`,
        );
      }
      case "input_resolved":
        if (pendingQuestion?.requestId === event.requestId) {
          pendingQuestion = undefined;
          print("  (request resolved)");
        }
        return;
      case "notice":
        return print(`[${event.level}] ${event.message}`);
      case "session_status":
        return print(`[session ${event.status}]`);
      case "process_exited":
        return print(`[agent process exited${event.expected ? "" : ` unexpectedly, code ${event.code}`}]`);
      default:
        return;
    }
  }

  const pickSession = (ref: string | undefined) => sessions[Number(ref) - 1]?.id ?? ref;

  async function handle(line: string) {
    const [name, ...args] = line.trim().split(/\s+/);
    const text = line.trim().slice((name ?? "").length).trim();
    switch (name) {
      case "/help":
        return print(HELP);
      case "/agents": {
        const agents = await client.request<AgentInfo[]>({ kind: "list_agents" });
        return print(
          agents
            .map((agent) => `${agent.id}  ${agent.displayName}  ${agent.installed ? (agent.version ?? "") : "not installed"}${agent.supported ? "" : `  (${agent.reason})`}`)
            .join("\n"),
        );
      }
      case "/projects":
        projects = await client.request<Project[]>({ kind: "list_projects" });
        return print(projects.map((project, index) => `${index + 1}. ${project.name}  ${project.path}`).join("\n") || "No projects. On the laptop run: away projects add <path>");
      case "/sessions":
        sessions = await client.request<SessionSummary[]>({ kind: "list_sessions" });
        return print(
          sessions.map((session, index) => `${index + 1}. ${session.agent} in ${session.projectName}  ${session.status}  ${session.id}`).join("\n") || "No sessions",
        );
      case "/start": {
        if (projects.length === 0) projects = await client.request<Project[]>({ kind: "list_projects" });
        const project = projects[Number(args[0]) - 1];
        if (!project) return print("Usage: /start <project#> [agent]  (see /projects)");
        const session = await client.request<SessionSummary>({ kind: "start_session", agent: args[1] ?? "pi", projectId: project.id });
        return open(session.id);
      }
      case "/open": {
        const id = pickSession(args[0]);
        return id ? open(id) : print("Usage: /open <session#>  (see /sessions)");
      }
      case "/resume": {
        const id = pickSession(args[0]);
        if (!id) return print("Usage: /resume <session#>");
        await client.request({ kind: "resume_session", sessionId: id });
        return open(id);
      }
      case "/stop":
        if (!openSession) return print("No open session");
        return void (await client.request({ kind: "interrupt", sessionId: openSession }));
      case "/allow":
      case "/always":
      case "/deny": {
        if (!openSession || pendingQuestion?.kind !== "approval") return print("No pending approval");
        const decision = name === "/allow" ? "allow" : name === "/always" ? "allow_always" : "deny";
        if (decision === "allow_always" && !pendingQuestion.allowAlways) return print("This request cannot be allowed for the whole session");
        return respond({ kind: "approval", decision, ...(decision === "deny" && text ? { message: text } : {}) });
      }
      case "/answer": {
        if (!openSession || !pendingQuestion) return print("No pending question");
        if (text === "cancel") return respond({ kind: "cancel" });
        if (pendingQuestion.kind === "questions") return respond(parseAnswers(pendingQuestion.questions ?? [], text));
        if (pendingQuestion.kind === "confirm") return respond({ kind: "confirm", confirmed: /^y(es)?$/i.test(text) });
        if (pendingQuestion.kind === "approval") return print("Use /allow, /always or /deny");
        return respond({ kind: "value", value: text });
      }
      case "/close":
        if (!openSession) return print("No open session");
        return void (await client.request({ kind: "close_session", sessionId: openSession }));
      case "/pending":
        return print(client.pendingCommands().map((tracked) => `${tracked.commandId}  ${tracked.command.kind}  ${tracked.status}`).join("\n") || "Nothing pending");
      case "/drop":
        return client.dropConnection();
      case "/quit":
        client.stop();
        rl.close();
        return process.exit(0);
      default:
        if (name?.startsWith("/")) return print(`Unknown command ${name}. Try /help`);
        if (!openSession) return print("Open a session first (/start or /open)");
        client.send({ kind: "send_prompt", sessionId: openSession, text: line.trim() });
    }
  }

  async function respond(response: InputResponse) {
    if (!openSession || !pendingQuestion) return;
    const { requestId } = pendingQuestion;
    pendingQuestion = undefined;
    await client.request({ kind: "respond_input", sessionId: openSession, requestId, response });
  }

  function open(sessionId: string) {
    if (openSession) client.unsubscribe(openSession);
    openSession = sessionId;
    pendingQuestion = undefined;
    print(`Opened session ${sessionId}`);
    client.subscribe(sessionId, 0);
  }

  print(`Away remote for "${state.laptop.laptopName}". Type /help.`);
  client.start();
  rl.setPrompt("> ");
  rl.prompt();
  for await (const line of rl) {
    // Not awaited: commands issued while offline wait for reconnect without blocking input.
    if (line.trim()) void handle(line).catch((error: unknown) => print(`✖ ${(error as Error).message}`));
    rl.prompt();
  }
}

/** "2; blue, 1" → answers by question id. Numbers pick options; anything else is free text. */
function parseAnswers(questions: Question[], text: string): InputResponse {
  const parts = text.split(";").map((part) => part.trim());
  const answers: Record<string, string[]> = {};
  questions.forEach((question, index) => {
    const choices = (parts[index] ?? "").split(question.multiSelect ? "," : /$^/).map((choice) => choice.trim()).filter(Boolean);
    answers[question.id] = choices.map((choice) => question.options[Number(choice) - 1]?.label ?? choice);
  });
  return { kind: "answers", answers };
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
