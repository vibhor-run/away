import { z } from "zod";

/**
 * What an adapter can actually do. Clients hide controls for capabilities that are false
 * rather than assuming every agent behaves alike.
 */
export const AgentCapabilitiesSchema = z.object({
  /** Reopen an existing native agent session by its id. */
  resume: z.boolean(),
  /** Stop the current turn while keeping the agent process and session alive. */
  interrupt: z.boolean(),
  /** The agent itself asks for approval before running tools. */
  toolApprovals: z.boolean(),
  /** The agent (or its extensions) can ask the user questions mid-run. */
  userInput: z.boolean(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/**
 * - select / confirm / input / editor: simple dialogs (for example from Pi extensions)
 * - approval: the agent wants to use a tool and needs permission
 * - questions: one or more structured questions with suggested options
 */
export const InputRequestKindSchema = z.enum(["select", "confirm", "input", "editor", "approval", "questions"]);
export type InputRequestKind = z.infer<typeof InputRequestKindSchema>;

export const QuestionSchema = z.object({
  id: z.string(),
  header: z.string().optional(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean(),
  /** A free-text answer is accepted in addition to the options. */
  allowOther: z.boolean(),
});
export type Question = z.infer<typeof QuestionSchema>;

/**
 * Agent-neutral events emitted by an adapter session. Adapters translate their agent's
 * structured output into these; they never forward raw terminal text.
 */
export const AgentEventSchema = z.discriminatedUnion("type", [
  /** The agent began working on accepted input. */
  z.object({ type: z.literal("run_started") }),
  /** The agent will not continue on its own until it receives new input. */
  z.object({
    type: z.literal("run_settled"),
    aborted: z.boolean(),
    /** Set when the run ended because of an error. */
    error: z.string().optional(),
  }),
  z.object({ type: z.literal("assistant_message_started"), messageId: z.string() }),
  z.object({
    type: z.literal("text_delta"),
    messageId: z.string(),
    blockIndex: z.number().int(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("thinking_delta"),
    messageId: z.string(),
    blockIndex: z.number().int(),
    delta: z.string(),
  }),
  /** Authoritative final content of a message; replaces any text assembled from deltas. */
  z.object({
    type: z.literal("message_completed"),
    messageId: z.string(),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool_started"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_updated"),
    toolCallId: z.string(),
    output: z.string(),
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal("tool_finished"),
    toolCallId: z.string(),
    output: z.string(),
    truncated: z.boolean(),
    isError: z.boolean(),
  }),
  /** The agent is blocked waiting for the user. Answer with an InputResponse. */
  z.object({
    type: z.literal("input_requested"),
    requestId: z.string(),
    kind: InputRequestKindSchema,
    title: z.string(),
    message: z.string().optional(),
    options: z.array(z.string()).optional(),
    placeholder: z.string().optional(),
    prefill: z.string().optional(),
    /** The agent resolves the request with a default on its own after this many ms. */
    timeoutMs: z.number().optional(),
    /** For `approval`: the tool the agent wants to use and its input. */
    tool: z.object({ name: z.string(), input: z.unknown() }).optional(),
    /** For `approval`: whether "allow for this session" is offered. */
    allowAlways: z.boolean().optional(),
    /** For `questions`. */
    questions: z.array(QuestionSchema).optional(),
  }),
  /** The agent no longer waits for this request (answered elsewhere, timed out, or interrupted). */
  z.object({ type: z.literal("input_resolved"), requestId: z.string() }),
  z.object({
    type: z.literal("notice"),
    level: z.enum(["info", "warning", "error"]),
    message: z.string(),
  }),
  /** The agent process ended. `expected` is true when Away asked it to close. */
  z.object({
    type: z.literal("process_exited"),
    code: z.number().nullable(),
    signal: z.string().nullable(),
    expected: z.boolean(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const InputResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), value: z.string() }),
  z.object({ kind: z.literal("confirm"), confirmed: z.boolean() }),
  z.object({ kind: z.literal("cancel") }),
  z.object({
    kind: z.literal("approval"),
    decision: z.enum(["allow", "allow_always", "deny"]),
    message: z.string().max(2000).optional(),
  }),
  /** Answers keyed by question id. */
  z.object({ kind: z.literal("answers"), answers: z.record(z.string(), z.array(z.string())) }),
]);
export type InputResponse = z.infer<typeof InputResponseSchema>;
