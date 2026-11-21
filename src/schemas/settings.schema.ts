import { z } from "zod";

export const ListSettingPagesArgs = z.object({});

export const GetSettingsArgs = z.object({
  page: z
    .string()
    .max(60)
    .optional()
    .describe(
      'A settings page key from list_setting_pages, e.g. "general", "operating-hours", "widget-look", "widget-content", "widget-conversations", "email-forwarding", "email-conversations", "sla", "tags", "project-teams", "macros", "attributes", "helpcenter-sites", "webhooks".',
    ),
  keys: z
    .array(z.string().max(120))
    .max(50)
    .optional()
    .describe('Setting keys instead of a page, e.g. ["flowConfig.color", "flowConfig.timezone"].'),
});

export const SettingChange = z.object({
  key: z
    .string()
    .max(120)
    .optional()
    .describe('A field: its key from get_settings, e.g. "flowConfig.color", "flowConfig.openingTimes", "slaOptions.defaultSla", "emailConversation.receivedConfirmation".'),
  value: z.any().optional().describe("The field's new value in the type get_settings lists (null clears it). Lists and objects go whole: read, change, send back."),
  page: z.string().max(60).optional().describe('For an item of a page of items: the page key ("project-teams", "macros", "attributes", "helpcenter-sites", "webhooks").'),
  op: z.enum(["create", "update", "delete"]).optional().describe("What to do with the item."),
  id: z.string().max(40).optional().describe("The item id (update, delete), from get_settings."),
  values: z.record(z.string(), z.any()).optional().describe('The item fields to set, e.g. { "name": "Support EU", "members": ["anna@acme.com"] }.'),
});

export const UpdateSettingsArgs = z.object({
  changes: z.array(SettingChange).min(1).max(25).describe("Up to 25 changes, applied together."),
  confirmed: z
    .boolean()
    .optional()
    .describe(
      "True only after the person explicitly said yes to the risky changes a previous call listed in needsConfirmation: the customer-identity settings (secureSessionIdentify, acceptLegacyUserHash, customerIdentity, protectedContactFields, protectedCompanyFields, customerAuth), inbound email off, deleting a team …. Never set it on your own.",
    ),
});
