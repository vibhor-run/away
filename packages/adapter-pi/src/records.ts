import { z } from "zod";

// Schemas for the Pi RPC stdout records Away consumes, as documented in Pi 1.1.0
// docs/rpc.md, docs/rpc-commands.md, docs/json.md and docs/rpc-extension-ui.md.
// Objects are loose so fields added by newer Pi versions do not break parsing.

const MessageSchema = z.looseObject({
  role: z.string(),
  content: z.unknown(),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type PiMessage = z.infer<typeof MessageSchema>;

const ToolResultSchema = z.looseObject({ content: z.unknown() });

export const PiRecordSchemas = {
  response: z.looseObject({
    type: z.literal("response"),
    id: z.string().optional(),
    command: z.string(),
    success: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
  }),
  extension_ui_request: z.looseObject({
    type: z.literal("extension_ui_request"),
    id: z.string(),
    method: z.string(),
    title: z.string().optional(),
    message: z.string().optional(),
    options: z.array(z.string()).optional(),
    placeholder: z.string().optional(),
    prefill: z.string().optional(),
    timeout: z.number().optional(),
    notifyType: z.enum(["info", "warning", "error"]).optional(),
  }),
  agent_start: z.looseObject({ type: z.literal("agent_start") }),
  agent_settled: z.looseObject({ type: z.literal("agent_settled"), aborted: z.boolean() }),
  message_start: z.looseObject({ type: z.literal("message_start"), message: MessageSchema }),
  message_end: z.looseObject({ type: z.literal("message_end"), message: MessageSchema }),
  message_update: z.looseObject({
    type: z.literal("message_update"),
    assistantMessageEvent: z.looseObject({
      type: z.string(),
      contentIndex: z.number().int().optional(),
      delta: z.string().optional(),
    }),
  }),
  tool_execution_start: z.looseObject({
    type: z.literal("tool_execution_start"),
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.unknown(),
  }),
  tool_execution_update: z.looseObject({
    type: z.literal("tool_execution_update"),
    toolCallId: z.string(),
    partialResult: ToolResultSchema.optional(),
  }),
  tool_execution_end: z.looseObject({
    type: z.literal("tool_execution_end"),
    toolCallId: z.string(),
    result: ToolResultSchema.optional(),
    isError: z.boolean(),
  }),
  auto_retry_start: z.looseObject({
    type: z.literal("auto_retry_start"),
    attempt: z.number(),
    maxAttempts: z.number(),
    errorMessage: z.string().optional(),
  }),
  auto_retry_end: z.looseObject({
    type: z.literal("auto_retry_end"),
    success: z.boolean(),
    finalError: z.string().optional(),
  }),
  compaction_start: z.looseObject({ type: z.literal("compaction_start"), reason: z.string() }),
  compaction_end: z.looseObject({
    type: z.literal("compaction_end"),
    aborted: z.boolean(),
    errorMessage: z.string().optional(),
  }),
  extension_error: z.looseObject({
    type: z.literal("extension_error"),
    extensionPath: z.string().optional(),
    error: z.string(),
  }),
} as const;

export type PiRecordType = keyof typeof PiRecordSchemas;
export type PiRecord<T extends PiRecordType> = z.infer<(typeof PiRecordSchemas)[T]>;

export const PiStateSchema = z.looseObject({
  sessionId: z.string().optional(),
  sessionFile: z.string().optional(),
  isStreaming: z.boolean(),
});

/** Joins the text blocks of a message or tool result. Non-text blocks become placeholders. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      if (typeof block !== "object" || block === null) return "";
      const { type, text } = block as { type?: unknown; text?: unknown };
      if (type === "text" && typeof text === "string") return text;
      if (type === "image") return "[image]";
      return "";
    })
    .join("");
}
