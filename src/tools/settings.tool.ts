import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GetSettingsArgs, ListSettingPagesArgs, UpdateSettingsArgs } from "../schemas/settings.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { gleapGet, gleapPut, validationErrorResponse } from "../utils/api.js";

/**
 * The project's settings as one registry (GET/PUT /settings): every page of the dashboard's Settings,
 * its fields and who may change them. The connection acts with the person's role, exactly as the
 * dashboard: pages they cannot see are refused, every change saves through the dashboard's own save
 * (validation, plan gates and side effects included). Secrets (API keys, tokens, signing secrets) are
 * never returned. Risky changes run only with `confirmed: true` after the person said yes.
 */

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

/** The pages and their main keys, for the descriptions (the API's list is the full truth). */
const PAGES_HELP =
  "Pages (key: main fields): " +
  "general (name, picture, moveToOpenOnReply, autoAssignTicketToRecentCommenter, reactionsEnabled, threadsEnabled, customArchiveDate …); " +
  "operating-hours (flowConfig.showOnlineStatus, alwaysOnline, timezone, openingTimes [{day: All days|Weekdays|Weekends|Monday…, openingTime 'HH:MM', closingTime}], replyTime, holidays); " +
  "sla (slaOptions.enabled, defaultSla in seconds, ticketTypes, restUrl); languages (localizations); static-translations (flowConfig.staticTranslations); " +
  "user-identity (secureSessionIdentify, acceptLegacyUserHash, customerIdentity, protectedContactFields, protectedCompanyFields, customerAuth, authenticatedConversationFiles …); allowed-domains (allowedWidgetDomains); " +
  "widget-install (flowConfig.trackWidgetInteractions); widget-look (flowConfig.color, darkColor, backgroundColor, colorScheme, headerColor, bgType, feedbackButtonPosition, buttonColor, hideBranding, borderRadius, customCSS …); " +
  "widget-content (flowConfig.welcomeText, hideNews, hideKnowledgeBase, startPage, homeWidgets …); widget-conversations (flowConfig.ticketHeaderMode, sendOnEnter, disableAttachments …); aichatbar (aiBar.*); " +
  "email-brand (emailBrand); email-signature (emailSignature); email-conversations (emailConversation.look, fromPattern, quoteHistoryMode, receivedConfirmation …); " +
  "email-forwarding (inboundEmailsDisabled, defaultInboundLanguage, extractForwardedEmailSender, linkContactsToCompaniesByDomain); email-spam (spamFilter, whitelistedEmails, blacklistedEmails, flowConfig.aiSpamDetection …); " +
  "email-settings (disableEmailFallback, flowConfig.ccAllRecipients, relayParticipantReplies, botReplyScope, emailFloodProtection); " +
  "tags (feedbackTags, contactTags, contentTags); tasks (defaultTeamId, dueMs, escalation, safetyNet); ai-assist (autoTags, generateAiTitle, contactMemory.enabled, contentSuggestions.mode …); " +
  "portal-general, portal-security, portal-seo (flowConfig.* of the feedback portal); developer (flowConfig.enableNetworkLogs, enableWebReplays, capture …). " +
  "Pages of items (op create|update|delete): project-teams (name, members as ids or emails, assignmentMethod …), macros (title, text, isPublic …), attributes (label, type, fieldId, targetSource …), helpcenter-sites (name, aiUse, access, config; the default site's id is 'default'), webhooks (name, url, enabled, events, headers, filters). " +
  "Not changed here: SSO, the sending domain, channels, apps, API keys, push credentials, users and invites.";

/** Customer-identity settings every change of which needs the person's explicit yes (one line each, for the descriptions). */
const RISKY_SETTINGS_HELP =
  "Customer identity (page user-identity): " +
  "secureSessionIdentify (Enforce identity verification: an identify without a valid signature is refused, so every unsigned login breaks); " +
  "acceptLegacyUserHash (off = the HMAC user hash no longer counts as a signature; only identity-token logins stay signed); " +
  "customerIdentity (the mode switch { mode: classic|signed, sessionMaxAgeDays }: signed, only requests carrying the grant of a signed identify count as signed, so apps that do not send a signed identity lose their verified status); " +
  "protectedContactFields (contact fields only signed tokens, the REST API, the dashboard and workflows may change; browser and app writes to them are ignored); " +
  "protectedCompanyFields (the same for company fields); " +
  "customerAuth (per channel, what proves a customer before Kai shows their data; rule values: jwt | jwt_or_code | email_code | fallback). " +
  "Identity keys are not changeable through settings (write-guarded): the person manages them in Settings › Security.";

export const registerSettingsTools = (server: McpServer) => {
  server.registerTool(
    "list_setting_pages",
    {
      title: "List Setting Pages",
      description:
        "The project's settings pages the connected person may see, each with its fields: key, type, allowed values, a description, and which changes need their explicit yes (needsConfirmation). Pages they may see but not change say whyNot; pages hidden from them are listed under notForYou. Call it first when you do not know a key. " +
        PAGES_HELP,
      inputSchema: ListSettingPagesArgs.shape,
      annotations: READ,
    },
    async (): Promise<GleapApiResponse> => gleapGet("/settings/pages"),
  );

  server.registerTool(
    "get_settings",
    {
      title: "Get Settings",
      description:
        "Current values of a settings page (`page`) or of named setting keys (`keys`). Pages of items (teams, macros, help center sites, webhooks) list their items with ids. Secrets show only whether they are set ({ set: true }). Read a value before you change it, so lists and objects go back whole with only the change made.",
      inputSchema: GetSettingsArgs.shape,
      annotations: READ,
    },
    async (args): Promise<GleapApiResponse> => {
      if (!args.page && !args.keys?.length) return validationErrorResponse("Give a page or keys (list_setting_pages names them).");
      return gleapGet("/settings", {
        params: {
          ...(args.page ? { page: args.page } : {}),
          ...(args.keys?.length ? { keys: args.keys.join(",") } : {}),
        },
      });
    },
  );

  server.registerTool(
    "update_settings",
    {
      title: "Update Settings",
      description:
        "Change project settings with the connected person's rights, through the dashboard's own saves. A field change is { key, value }; an item change is { page, op: create|update|delete, id, values }. Returns what changed (before → after) and what was refused and why. Risky changes do not run without `confirmed: true`: the first call lists them in needsConfirmation and changes nothing; ask the person, and only after their explicit yes call again with confirmed: true. Risky: " + RISKY_SETTINGS_HELP + " Also inbound email off, SSO, deleting a team, macro, site or webhook. Examples: {key:'flowConfig.color', value:'#2142E7'}; {key:'flowConfig.openingTimes', value:[{day:'Weekdays', openingTime:'09:00', closingTime:'17:00'}]}; {page:'project-teams', op:'create', values:{name:'Billing', members:['anna@acme.com']}}.",
      inputSchema: UpdateSettingsArgs.shape,
      annotations: WRITE,
    },
    async (args): Promise<GleapApiResponse> =>
      gleapPut("/settings", { changes: args.changes, ...(args.confirmed === true ? { confirmed: true } : {}) }),
  );
};
