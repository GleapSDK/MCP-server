import { z } from "zod";

const localizedStringField = z
  .record(z.string(), z.unknown())
  .describe(
    'Localized text: keys = locale codes (e.g. en, de), values = strings. Example: { "en": "What\'s New" }.',
  );

const localizedTiptapContentField = z
  .record(z.string(), z.unknown())
  .describe(
    "Localized TipTap document per locale. Each value = TipTap doc with type 'doc' and 'content' array. See https://tiptap.dev/docs/guides/output-json-html",
  );

const NewsConfigArgs = z.object({
  inapptarget: z
    .string()
    .optional()
    .describe('In-app target audience, e.g. "users"'),
  push: z.boolean().optional().describe("Whether to send a push notification"),
  sendEmailToSubscribers: z
    .boolean()
    .optional()
    .describe("Whether to send an email to subscribers"),
});

const NewsTriggerArgs = z.object({
  event: z
    .string()
    .optional()
    .describe(
      "Event that fires the trigger. Common values: 'sessionStarted', 'pageView', 'customEvent'.",
    ),
  type: z
    .string()
    .optional()
    .describe(
      "When the trigger should match relative to the event. Common values: 'firstoccured', 'everytime'.",
    ),
  dateOperator: z
    .string()
    .optional()
    .describe(
      "How 'data' should be interpreted. Common values: 'relative' (days/hours offset), 'absolute' (exact date).",
    ),
  matchOperator: z
    .string()
    .optional()
    .describe(
      "Comparison for the 'data' value. Common values: 'greaterthan', 'lessthan', 'equals'.",
    ),
  data: z
    .number()
    .optional()
    .describe(
      "Numeric value compared against using matchOperator (e.g. number of days for a relative date trigger).",
    ),
});

const coverImageUrlField = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Cover image: a fileUrl from upload_image / create_image_upload_link, or any public http(s) image URL (copied onto Gleap's CDN first).",
  );

export const GetNewsArgs = z.object({
  withoutChangelogs: z
    .boolean()
    .optional()
    .describe(
      "When true, excludes changelog entries and returns only news items",
    ),
  skip: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of items to skip for pagination"),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Maximum number of items to return"),
});

export const GetNewsItemArgs = z.object({
  newsId: z.string().describe("The ID of the news/changelog item to retrieve"),
});

export const CreateNewsArgs = z.object({
  name: z
    .string()
    .describe(
      "REQUIRED. Internal name/label for this entry. Plain string (not localized).",
    ),
  subject: localizedStringField.describe(
    'REQUIRED. Localized title shown to users. Example: { "en": "What\'s New" }. Do not omit.',
  ),
  message: localizedTiptapContentField.describe(
    "REQUIRED. Localized TipTap body content per locale. Do not omit.",
  ),
  type: z
    .enum(["NEWS"])
    .optional()
    .default("NEWS")
    .describe('Item type. Defaults to "NEWS".'),
  subType: z
    .enum(["CHANGELOG", "NEWS"])
    .optional()
    .default("CHANGELOG")
    .describe('Item sub-type: "CHANGELOG" (default) or "NEWS".'),
  sender: z
    .string()
    .optional()
    .describe("User ID of the sender displayed on the item"),
  actionType: z
    .string()
    .optional()
    .describe(
      "How the item is delivered. Common values: 'notification' (in-app bell), 'modal', 'banner'.",
    ),
  format: z
    .string()
    .optional()
    .describe(
      "Visual style. Common values: 'personal' (sender avatar + message), 'announcement' (marketing-style banner).",
    ),
  config: NewsConfigArgs.optional().describe(
    "Delivery configuration (in-app target, push, email)",
  ),
  sound: z
    .boolean()
    .optional()
    .describe("Whether to play a sound when the item is shown"),
  trigger: NewsTriggerArgs.optional().describe(
    "Trigger configuration controlling when the item is shown",
  ),
  pageFilterDelay: z
    .number()
    .optional()
    .describe("Delay in milliseconds before showing the item on page"),
  coverImageUrl: coverImageUrlField.optional(),
});

export const UpdateNewsArgs = z.object({
  newsId: z.string().describe("The ID of the news/changelog item to update"),
  name: z.string().optional().describe("Internal name/label for this entry"),
  subject: localizedStringField
    .optional()
    .describe("Localized title shown to users"),
  message: localizedTiptapContentField
    .optional()
    .describe("Localized TipTap body content per locale"),
  type: z.enum(["NEWS"]).optional(),
  subType: z.enum(["CHANGELOG", "NEWS"]).optional(),
  sender: z.string().optional().describe("User ID of the sender"),
  actionType: z.string().optional().describe("Action type"),
  format: z.string().optional().describe("Display format"),
  config: NewsConfigArgs.optional().describe("Delivery configuration"),
  sound: z.boolean().optional().describe("Whether to play a sound"),
  trigger: NewsTriggerArgs.optional().describe("Trigger configuration"),
  pageFilterDelay: z
    .number()
    .optional()
    .describe("Delay in milliseconds before showing the item"),
  coverImageUrl: coverImageUrlField
    .nullable()
    .optional()
    .describe(`${coverImageUrlField.description} null removes the cover.`),
});

export const DeleteNewsArgs = z.object({
  newsId: z.string().describe("The ID of the news/changelog item to delete"),
});
