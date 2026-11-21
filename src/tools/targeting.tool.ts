import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GLEAP_API_BASE } from "../config/index.js";
import { gleapGetData, validationErrorResponse, wrapResponse } from "../utils/api.js";
import {
  CONDITION_GUIDE, EVENT_LIST_CAP, MISSING_TARGET_HELP, STANDARD_CONTACT_FIELDS, contactAttributes, matchesSearch, projectEvents, suggestKey, trackingGuide,
} from "../utils/targeting.js";

const GetTargetingOptionsArgs = z.object({
  search: z.string().trim().min(1).max(100).optional().describe(
    'Words to look for in event and attribute names, e.g. "trial", "checkout", "plan". Omit to list everything.',
  ),
}).strict();

const GetTrackingGuideArgs = z.object({
  kind: z.enum(["event", "contact_attribute"]).describe(
    "event = something people do (trial started, report exported). contact_attribute = something people are or have (plan, role, seats).",
  ),
  name: z.string().trim().min(1).max(70).describe('The event or attribute, e.g. "trial_started" or "role". Free text is turned into a snake_case key.'),
  exampleValue: z.union([z.string(), z.number(), z.boolean()]).optional().describe("Example value for an attribute, used in the snippets."),
}).strict();

const apiOrigin = () => {
  try {
    return new URL(GLEAP_API_BASE as string).origin;
  } catch {
    return "https://api.gleap.io";
  }
};

export const registerTargetingTools = (server: McpServer) => {
  server.registerTool("get_targeting_options", {
    title: "Get Targeting Options",
    description:
      "What outbound messages (surveys, emails, banners, chat messages, checklists, tours, tooltips, info cards, push, news) can target in this project: the events contacts have sent (usable as triggers and event rules) and the contact attributes (usable as audience rules), with the condition syntax. " +
      "Call it before configure_outbound_targeting or configure_email_automation. When nothing fits the audience you need, it says so; then use get_event_tracking_guide.",
    inputSchema: GetTargetingOptionsArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = GetTargetingOptionsArgs.safeParse(input);
    if (!parsed.success) return validationErrorResponse(parsed.error.message);
    const { search } = parsed.data;
    const [eventsRaw, attributesRaw] = await Promise.all([
      gleapGetData("/projects/streamed-event-keys"),
      gleapGetData("/projects/user-property-filters"),
    ]);
    if ("error" in eventsRaw) return eventsRaw.error;
    if ("error" in attributesRaw) return attributesRaw.error;

    const allEvents = projectEvents(eventsRaw.data);
    const customCount = allEvents.filter((event) => event.source === "custom").length;
    const events = allEvents.filter((event) => matchesSearch(search, event.name, event.label));
    const attributes = contactAttributes(attributesRaw.data).filter((attribute) => matchesSearch(search, attribute.field, attribute.label));
    const nothingFound = search !== undefined && events.length === 0 && attributes.length === 0;

    return wrapResponse({
      ...(search ? { search } : {}),
      events,
      contactAttributes: attributes,
      ...(customCount >= EVENT_LIST_CAP
        ? { eventListNote: `The project has ${EVENT_LIST_CAP}+ custom events; newer event names are tracked but not listed here.` }
        : {}),
      conditionSyntax: CONDITION_GUIDE,
      ...(nothingFound
        ? {
            noMatch: true,
            nextStep: MISSING_TARGET_HELP,
            suggestedEventName: suggestKey(search!),
          }
        : {}),
    });
  });

  server.registerTool("get_event_tracking_guide", {
    title: "Get Event Tracking Guide",
    description:
      "How to start tracking an event or contact attribute that targeting needs but the project does not have yet: the call for each SDK (JavaScript, iOS, Android, Flutter, React Native) and from a backend, where to place it, and how to verify it arrived. " +
      "Use it when get_targeting_options finds no fitting event/attribute; hand the snippet to the developer or a coding agent. Reports whether the name is already tracked.",
    inputSchema: GetTrackingGuideArgs.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input: unknown) => {
    const parsed = GetTrackingGuideArgs.safeParse(input);
    if (!parsed.success) return validationErrorResponse(parsed.error.message);
    const { kind, exampleValue } = parsed.data;
    const raw = parsed.data.name.replace(/^gleap-up-(customData\.)?/, "");
    const name = /^[A-Za-z0-9_.-]+$/.test(raw) ? raw : suggestKey(raw);

    // Already there? Then targeting works today and no code change is needed.
    const lookup = kind === "event"
      ? await gleapGetData("/projects/streamed-event-keys")
      : await gleapGetData("/projects/user-property-filters");
    const existing = "error" in lookup ? undefined : kind === "event"
      ? projectEvents(lookup.data).find((event) => event.name === name)
      : contactAttributes(lookup.data).find((attribute) =>
        attribute.field === `gleap-up-customData.${name}` || attribute.field === `gleap-up-${name}`);

    return wrapResponse({
      alreadyTracked: existing ? true : "error" in lookup ? "unknown" : false,
      ...(existing ? {
        existing,
        note: "field" in existing && STANDARD_CONTACT_FIELDS.some((field) => field.field === existing.field)
          ? "A standard contact field: targetable as soon as your identify call sets it."
          : "Already available for targeting; no code change needed.",
      } : {}),
      ...trackingGuide({ kind, name, exampleValue, apiOrigin: apiOrigin() }),
      findThePlace: "If the project has a connected repository, ask_code can explain where in the product this moment happens.",
    });
  });
};
