import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GleapApiResponse } from "../types/index.js";
import { gleapGetData, gleapPost, validationErrorResponse } from "../utils/api.js";

const AnswerTicketCardArgs = z.object({
  ticketId: z.string().describe("The ticket whose open Kai card to read or answer"),
  answer: z
    .string()
    .max(4000)
    .optional()
    .describe("A question card: your answer, in the words your operator approved. Leave out to only read the card."),
  send: z
    .boolean()
    .optional()
    .describe("A proposed-reply card: true sends the reply to the customer as you (only after your operator approved it)."),
  text: z
    .string()
    .max(8000)
    .optional()
    .describe("With send: the reply as edited by your operator, instead of the proposed text."),
});

const textResponse = (text: string): GleapApiResponse => ({ content: [{ type: "text", text }], structuredContent: { message: text } });

interface CardView {
  id: string;
  type: string;
  question: string;
  lines: string[];
  proposal: string | null;
}

const cardViewOf = (card: any): CardView | null => {
  const body = card?.metadata?.card ?? card?.card ?? null;
  const id = String(card?.id ?? card?._id ?? "");
  if (!body?.type || !id) return null;
  return {
    id,
    type: String(body.type),
    question: String(body.question ?? ""),
    lines: Array.isArray(body.lines) ? body.lines.map(String) : [],
    proposal: typeof body.proposal?.text === "string" ? body.proposal.text : null,
  };
};

const describeCard = (card: CardView): string =>
  [
    `Open card (${card.type}): ${card.question}`,
    ...card.lines.map((line) => `- ${line}`),
    ...(card.proposal ? [`Proposed reply:\n${card.proposal}`] : []),
  ].join("\n");

/**
 * Kai's open card on a ticket, for a person's own AI client: read it, answer a question card, or send a
 * proposed reply. Money, deletes, merges and releases stay a person's click in Gleap.
 */
export const registerTicketCardTools = (server: McpServer) => {
  server.registerTool(
    "answer_ticket_card",
    {
      title: "Answer Ticket Card",
      description:
        "Read or answer the card Kai Support left on a ticket for a person. Without answer/send it returns the card. A question card takes `answer`; a proposed-reply card takes `send: true` (and optional edited `text`) and sends the reply to the customer as your operator. Ask your operator first and use their words. Approvals (money, deletes), Merge and release checks are decided by a person in Gleap: this tool says so and changes nothing.",
      inputSchema: AnswerTicketCardArgs.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ ticketId, answer, send, text }): Promise<GleapApiResponse> => {
      const state = await gleapGetData(`/hard-tickets/tickets/${encodeURIComponent(ticketId)}`);
      if ("error" in state) return state.error;
      const card = cardViewOf((state.data as any)?.card);
      if (!card) return textResponse("No card waits on this ticket.");
      const wantsAction = (typeof answer === "string" && answer.trim().length > 0) || send === true;
      if (!wantsAction) return textResponse(describeCard(card));
      if (card.type === "question") {
        if (!answer?.trim()) return validationErrorResponse("This is a question card: pass `answer`.");
        return gleapPost(`/hard-tickets/cards/${card.id}/answer`, { answer: answer.trim() });
      }
      if (card.type === "proposed_reply") {
        if (send !== true) return validationErrorResponse("This is a proposed-reply card: pass `send: true` (and `text` to send an edited reply).");
        return gleapPost(`/hard-tickets/cards/${card.id}/send`, text?.trim() ? { text: text.trim() } : {});
      }
      return textResponse(`${describeCard(card)}\n\nThis card is decided by a person in Gleap (open the ticket there). Nothing was changed.`);
    },
  );
};
