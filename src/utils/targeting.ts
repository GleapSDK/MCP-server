/**
 * Targeting vocabulary for outbound messages (surveys, emails, banners, chat
 * messages, checklists, tours, tooltips, info cards, push, news, WhatsApp).
 * Pure: no I/O, so the discovery projection and the tracking guide are
 * unit-testable.
 *
 * What the Server evaluates (outboundactions conditionChecked /
 * userPropertyEvent):
 *  - a streamed event name addresses session.eventData.<hash> = {count,
 *    first, last, data}. Only `data.page` is stored per event, so a
 *    latestdata rule on a custom event's own data never matches; attributes
 *    belong on the contact (identify / customData);
 *  - `gleap-up-<path>` addresses a contact field (`gleap-up-plan`,
 *    `gleap-up-customData.role`); the bare `tags` addresses the contact's tags;
 *  - `project.possibleTriggers` (the event list) stops growing at ~300 names,
 *    so events past that are tracked but not listed.
 */

type Doc = Record<string, any>;

export const BUILT_IN_EVENTS: Record<string, string> = {
  sessionStarted: "Session started: fires when a contact opens your app or site. Use as the trigger to target by audience rules only.",
  pageView: "Page view: fires on every page/screen view; pair with pageRules to target URLs.",
};

/** Contact fields every project has, usable as `gleap-up-<field>` without being listed. */
export const STANDARD_CONTACT_FIELDS: { field: string; label: string; kind: "value" | "date" | "tags" }[] = [
  { field: "gleap-up-email", label: "Email", kind: "value" },
  { field: "gleap-up-name", label: "Name", kind: "value" },
  { field: "gleap-up-userId", label: "User ID", kind: "value" },
  { field: "gleap-up-plan", label: "Plan", kind: "value" },
  { field: "gleap-up-value", label: "Customer value (MRR)", kind: "value" },
  { field: "gleap-up-companyId", label: "Company ID", kind: "value" },
  { field: "gleap-up-companyName", label: "Company name", kind: "value" },
  { field: "gleap-up-lang", label: "Language", kind: "value" },
  { field: "gleap-up-phone", label: "Phone", kind: "value" },
  { field: "tags", label: "Contact tags (use in / notin)", kind: "tags" },
];

/** At this many custom events the project's event list stops growing. */
export const EVENT_LIST_CAP = 300;

export const CONDITION_GUIDE = {
  combine: "audience.conditions are combined with audience.logicalOperator (AND by default). A condition may itself be a group {logicalOperator, conditions:[...]} (one-off sends and audience previews only apply top-level rules).",
  eventCount: "Has (not) done an event: {event, type:'count', matchOperator:'is'|'isnot'|'greaterthan'|'lessthan', data:<count>}. Never did it: matchOperator 'is', data 0.",
  eventDate: "When an event happened: {event, type:'firstoccured'|'lastoccured', dateOperator:'relative', matchOperator:'greaterthan'|'lessthan'|'exactly', data:<seconds ago>} or dateOperator:'absolute' with on/before/after and an ISO date.",
  contactAttribute: "Contact attribute: {event:'gleap-up-<field>', type:'latestdata', matchOperator:'is'|'isnot'|'contains'|'notcontains'|'startswith'|'endswith'|'greaterthan'|'lessthan'|'empty'|'notempty', data}. No dataKey. Date attributes (e.g. gleap-up-createdAt) use the event-date form.",
  tags: "Contact tags: {event:'tags', type:'latestdata', matchOperator:'in'|'notin', data:'<tag>'}.",
  page: "Current page: {event:'pageView', type:'latestdata', dataKey:'page', matchOperator:'contains', data:'/pricing'}. For in-app messages prefer trigger pageView + pageRules.",
  eventData: "Custom event properties are not stored for targeting (only the page is). To target on a value (plan, role, cart size), store it on the contact with identify/customData and use a contact-attribute rule.",
};

const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");

const eventSource = (value: string): string => {
  if (value in BUILT_IN_EVENTS) return "built_in";
  if (value.startsWith("tour-")) return "product_tour";
  if (value.startsWith("outbound-")) return "survey";
  if (value.startsWith("checklist-")) return "checklist";
  return "custom";
};

/** The project's events as returned by GET /projects/streamed-event-keys, deduplicated. */
export const projectEvents = (raw: unknown) => {
  const seen = new Set<string>();
  const events: { name: string; label: string; source: string }[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const name = typeof entry === "string" ? entry : (entry as Doc)?.value;
    if (typeof name !== "string" || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    const label = typeof entry === "object" && typeof (entry as Doc).label === "string" ? (entry as Doc).label : name;
    events.push({ name, label, source: eventSource(name) });
  }
  for (const name of Object.keys(BUILT_IN_EVENTS)) {
    if (!seen.has(name)) events.unshift({ name, label: name, source: "built_in" });
  }
  return events;
};

/** The project's contact attributes as returned by GET /projects/user-property-filters, plus the standard fields. */
export const contactAttributes = (raw: unknown) => {
  const attributes = new Map<string, { field: string; label: string; kind: string }>();
  for (const standard of STANDARD_CONTACT_FIELDS) attributes.set(standard.field, standard);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [field, meta] of Object.entries(raw as Doc)) {
      if (!field.startsWith("gleap-up-")) continue;
      const kind = meta?.type === "calendar" || meta?.eventType === "firstoccured" || meta?.eventType === "lastoccured" ? "date" : "value";
      attributes.set(field, { field, label: typeof meta?.label === "string" ? meta.label : field.slice("gleap-up-".length), kind });
    }
  }
  return [...attributes.values()];
};

/** Case-insensitive match of every search word against name + label. */
export const matchesSearch = (search: string | undefined, ...texts: unknown[]): boolean => {
  if (!search) return true;
  const haystack = texts.map(lower).join(" ").replace(/[-_.]/g, " ");
  return search.toLowerCase().replace(/[-_.]/g, " ").split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
};

const quote = (value: string) => JSON.stringify(value);

const SNAKE = /[^a-z0-9]+/g;
/** A suggested event / attribute key from a free-text description ("Trial started" → trial_started). */
export const suggestKey = (text: string): string =>
  text.trim().toLowerCase().replace(SNAKE, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "my_event";

const DOCS = "https://docs.gleap.io/documentation";
const IDENTITY_DOCS = "https://docs.gleap.ai/documentation/guides/customer-identity";

export interface TrackingGuideInput {
  kind: "event" | "contact_attribute";
  name: string;
  exampleValue?: string | number | boolean;
  apiOrigin: string;
}

/**
 * Everything an agent needs to make a missing event or contact attribute
 * targetable: the call per platform, the server-side route, and how to verify.
 */
export const trackingGuide = ({ kind, name, exampleValue, apiOrigin }: TrackingGuideInput) => {
  const n = quote(name);
  if (kind === "event") {
    return {
      kind,
      name,
      why: `Targeting rules and triggers only match events Gleap has received. Track ${n} at the moment it happens; it becomes available for targeting with the first event.`,
      snippets: {
        javascript: `Gleap.trackEvent(${n});`,
        ios: `Gleap.trackEvent(${n})`,
        android: `Gleap.getInstance().trackEvent(${n});`,
        flutter: `Gleap.trackEvent(name: ${n});`,
        reactNative: `Gleap.trackEvent(${n});`,
        server: {
          description: "From your backend (webhooks, billing, jobs). Uses an API key from Settings → Developer → API keys, never the Project ID; the userId must match the one you identify contacts with.",
          nodejs: `GleapAdmin.trackEvent(userId, ${n});`,
          http: `POST ${apiOrigin}/admin/track\nApi-Token: <API key>\nContent-Type: application/json\n\n{"events":[{"userId":"<userId>","name":${n},"date":"<ISO date>"}]}`,
        },
      },
      notes: [
        "Track it where the moment completes (after the API call succeeds, not on button click).",
        "The contact must be identified (Gleap.identify / GleapAdmin.identify) for the event to land on the right person.",
        "Event properties are not targetable; put values you want to target on the contact (contact_attribute).",
        "Use one stable snake_case name per moment; renamed events start from zero.",
      ],
      docs: `${DOCS}/javascript/track-events`,
      verify: `After the change ships and the moment happens once, get_targeting_options with search ${n} lists the event. Rules on it before then match nobody.`,
    };
  }

  const key = name.replace(/^gleap-up-(customData\.)?/, "");
  const sample = exampleValue === undefined ? '"<value>"' : JSON.stringify(exampleValue);
  return {
    kind,
    name: key,
    field: `gleap-up-customData.${key}`,
    why: `Audience rules read contact attributes. Store ${quote(key)} on the contact; rules then use event "gleap-up-customData.${key}".`,
    snippets: {
      signed: {
        description:
          "Attributes that gate data, billing or anything sensitive (plan, stripeCustomerId, company, …) go into the identity token: the backend signs an HS256 JWT with one of the project's identity keys (Settings › Security › Identity keys; kid header, secret in an env var, never client-side), every extra claim lands on the contact as a signed attribute, and the app hands the token to the SDK. Nothing else is passed from the client.",
        claims: `{ "userId": "<userId>", ${quote(key)}: ${sample}, "exp": <unix seconds, at most one hour ahead> }`,
        javascript: `Gleap.setUserJwt(token);`,
        ios: `Gleap.setUserJwt(token)`,
        android: `Gleap.getInstance().setUserJwt(token);`,
        flutter: `Gleap.setUserJwt(token: token);`,
        reactNative: `Gleap.setUserJwt(token);`,
      },
      unsigned: {
        description:
          "Harmless data only (preferences, UI state, usage counters). Anyone can call this from the browser or app, so it never carries plan, billing, company or provider ids. Fields the project marks \"Only signed updates\" (Settings › Inbox & tickets › Data attributes, Contact tab) ignore these writes.",
        javascript: `Gleap.identify(userId, { customData: { ${quote(key)}: ${sample} } });\n// or later, for the identified contact:\nGleap.updateContact({ customData: { ${quote(key)}: ${sample} } });`,
        ios: `let props = GleapUserProperty()\nprops.customData = [${quote(key)}: ${sample}]\nGleap.identifyContact(userId, andData: props)`,
        android: `GleapSessionProperties props = new GleapSessionProperties();\nJSONObject custom = new JSONObject();\ncustom.put(${quote(key)}, ${sample});\nprops.setCustomData(custom);\nGleap.getInstance().identifyContact(userId, props);`,
        flutter: `Gleap.identify(userId: userId, userProperties: GleapUserProperty(customData: <String, dynamic>{${quote(key)}: ${sample}}));`,
        reactNative: `Gleap.identify(userId, { customData: { ${quote(key)}: ${sample} } });`,
      },
      server: {
        description: "From your backend, with an API key (Settings → Developer → API keys): always writes, protected fields included. Unknown top-level keys are stored as custom data.",
        nodejs: `GleapAdmin.identify(userId, { customData: { ${quote(key)}: ${sample} } });`,
        http: `POST ${apiOrigin}/admin/identify\nApi-Token: <API key>\nContent-Type: application/json\n\n{"userId":"<userId>",${quote(key)}:${sample}}`,
      },
    },
    notes: [
      "Signed first: if the attribute decides what a customer may see or do (plan, billing, company, a provider's customer id), it belongs in the identity token's claims or in a server-side write, never in an unsigned identify or updateContact from the client.",
      "Projects that mark the field \"Only signed updates\" keep the stored value when a browser or app writes it unsigned; the write is accepted and the field is left unchanged, silently.",
      "Matching is exact and case-sensitive on the key; keep one spelling. An identify call carries at most 35 custom data keys.",
      "Standard fields (email, name, plan, value, companyName, lang, phone) go on the identify call directly, not in customData.",
    ],
    docs: IDENTITY_DOCS,
    verify: `Once a contact carries it, get_targeting_options with search ${quote(key)} lists gleap-up-customData.${key}.`,
  };
};

export const MISSING_TARGET_HELP =
  "Nothing in this project matches. Gleap can only target what it has received: call get_event_tracking_guide (kind 'event' for something users do, 'contact_attribute' for something users are or have) to get the tracking code, ask the developer (or a coding agent; ask_code finds where the moment happens in a connected repo) to add it, then target it once the first data arrives. Meanwhile, consider an existing event or attribute that approximates the audience.";
