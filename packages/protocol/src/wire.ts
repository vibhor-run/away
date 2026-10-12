import { z } from "zod";
import { AgentCapabilitiesSchema, AgentEventSchema, InputResponseSchema } from "./agent.ts";

// Messages exchanged inside the end-to-end encrypted channel between a paired device and the
// laptop companion. The relay never sees these.

// ---- Handshake payloads ----

export const ClientHelloSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pair"), token: z.string(), deviceName: z.string().min(1).max(100) }),
  z.object({ type: z.literal("connect") }),
]);
export type ClientHello = z.infer<typeof ClientHelloSchema>;

export const ServerHelloSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("accepted"), deviceId: z.string(), laptopName: z.string() }),
  z.object({ type: z.literal("rejected"), reason: z.string() }),
]);
export type ServerHello = z.infer<typeof ServerHelloSchema>;

// ---- Shared values ----

export const SessionStatusSchema = z.enum(["starting", "idle", "running", "ended"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSummarySchema = z.object({
  id: z.string(),
  agent: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  status: SessionStatusSchema,
  nativeSessionId: z.string().optional(),
  /** The prompt command the agent is currently working on, if any. */
  activeCommandId: z.string().optional(),
  lastSeq: z.number().int(),
  createdAt: z.string(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const ProjectSchema = z.object({ id: z.string(), name: z.string(), path: z.string() });
export type Project = z.infer<typeof ProjectSchema>;

export const AgentInfoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  capabilities: AgentCapabilitiesSchema,
  installed: z.boolean(),
  supported: z.boolean(),
  version: z.string().optional(),
  reason: z.string().optional(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

/** Events in a session's log: agent events plus a few recorded by Away itself. */
export const SessionEventSchema = z.union([
  AgentEventSchema,
  z.object({ type: z.literal("prompt_sent"), commandId: z.string(), text: z.string() }),
  z.object({ type: z.literal("session_status"), status: SessionStatusSchema }),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

// ---- Client → laptop ----

export const CommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list_agents") }),
  z.object({ kind: z.literal("list_projects") }),
  z.object({ kind: z.literal("list_sessions") }),
  z.object({ kind: z.literal("start_session"), agent: z.string(), projectId: z.string() }),
  z.object({ kind: z.literal("resume_session"), sessionId: z.string() }),
  z.object({ kind: z.literal("send_prompt"), sessionId: z.string(), text: z.string().min(1).max(100_000) }),
  z.object({ kind: z.literal("interrupt"), sessionId: z.string() }),
  z.object({
    kind: z.literal("respond_input"),
    sessionId: z.string(),
    requestId: z.string(),
    response: InputResponseSchema,
  }),
  z.object({ kind: z.literal("close_session"), sessionId: z.string() }),
]);
export type Command = z.infer<typeof CommandSchema>;

export const ClientMessageSchema = z.discriminatedUnion("type", [
  /**
   * A command with a client-generated id. Sending the same id again never re-runs the command;
   * the laptop answers with its current status instead.
   */
  z.object({ type: z.literal("command"), commandId: z.uuid(), command: CommandSchema }),
  /** Replays events after `afterSeq`, then streams new ones. */
  z.object({ type: z.literal("subscribe"), sessionId: z.string(), afterSeq: z.number().int().min(0) }),
  z.object({ type: z.literal("unsubscribe"), sessionId: z.string() }),
  z.object({ type: z.literal("ping"), nonce: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---- Laptop → client ----

/**
 * Command lifecycle as seen by the laptop. `submitted` exists only on the client, before any
 * acknowledgment arrives.
 * - received: stored by the laptop, not yet acted on
 * - accepted: the agent accepted the prompt and is working on it (prompts only)
 * - completed / failed / interrupted: final
 */
export const CommandStatusSchema = z.enum(["received", "accepted", "completed", "failed", "interrupted"]);
export type CommandStatus = z.infer<typeof CommandStatusSchema>;

export const FINAL_COMMAND_STATUSES: ReadonlySet<CommandStatus> = new Set(["completed", "failed", "interrupted"]);

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("command_status"),
    commandId: z.string(),
    status: CommandStatusSchema,
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("session_event"),
    sessionId: z.string(),
    seq: z.number().int(),
    at: z.string(),
    event: SessionEventSchema,
  }),
  /** Sent after a subscribe's replay finishes; later events are live. */
  z.object({ type: z.literal("subscribed"), sessionId: z.string(), lastSeq: z.number().int() }),
  z.object({ type: z.literal("session_updated"), session: SessionSummarySchema }),
  z.object({ type: z.literal("pong"), nonce: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
