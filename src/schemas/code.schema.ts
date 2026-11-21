import { z } from "zod";

export const AskCodeArgs = z.object({
  question: z
    .string()
    .min(1)
    .describe(
      "A natural-language question about how the project's product works. Examples: 'How does ticket assignment work?', 'What happens when a user enables WhatsApp?'. The answer explains user-facing behavior and click paths only — never code, file paths, identifiers, or secrets.",
    ),
});
