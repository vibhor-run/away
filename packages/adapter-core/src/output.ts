/** Tool output sent to clients is capped; the full output stays in the agent's own history. */
export const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;

/** Keeps the end of long output, which usually holds the result or the error. */
export function capOutput(output: string, limit = MAX_TOOL_OUTPUT_CHARS): { output: string; truncated: boolean } {
  if (output.length <= limit) return { output, truncated: false };
  return { output: output.slice(-limit), truncated: true };
}
