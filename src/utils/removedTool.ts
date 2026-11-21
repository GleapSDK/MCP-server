import { GleapApiResponse } from "../types/index.js";

/**
 * Tools the Hard tickets program removed (SPEC §8): they keep their name and
 * input schema for one release, so agents and workflows that still call them
 * get a clear answer instead of "unknown tool", and they do nothing. Delete
 * them (and this helper) in the release after.
 */

/** Annotations of a removed tool: it changes nothing, so no client asks before calling it. */
export const REMOVED_TOOL_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** The answer of a removed tool: nothing happened, and what to use instead. */
export const removedToolResponse = (tool: string, instead: string): GleapApiResponse => {
  const message = `${tool} was removed and did nothing. ${instead}`;
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: true, removed: true, tool, message },
  };
};
