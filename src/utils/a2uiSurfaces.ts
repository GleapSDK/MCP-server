/**
 * The A2UI 1.0 surfaces the Kai session tools return in `structuredContent.a2ui`
 * (plan, wrap-up, shared screenshot, published page). Cards are written as a
 * small tree and flattened into the id-linked component list A2UI wants, like
 * the Gleap Server's own builder. Links are plain https or left out.
 */
import type { A2uiComponent, A2uiSurface } from "../a2ui/generated/a2uiSurface.generated.js";
import { GLEAP_CATALOG_ID } from "../a2ui/generated/gleapCatalogTypes.generated.js";

interface A2uiNode {
  component: string;
  props?: Record<string, unknown>;
  children?: Array<A2uiNode | null>;
  child?: A2uiNode;
}

export const httpsUrlOrNull = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    // Not a URL at all: no link.
    return null;
  }
};

const text = (value: string, variant?: "caption"): A2uiNode => ({ component: "Text", props: variant ? { text: value, variant } : { text: value } });
const column = (children: Array<A2uiNode | null>): A2uiNode => ({ component: "Column", children });
const row = (children: Array<A2uiNode | null>): A2uiNode => ({ component: "Row", children });

/** "Open in Gleap" with the client-run openUrl function; nothing when the link is not https. */
const openInGleap = (url: string | undefined): A2uiNode | null => {
  const safe = httpsUrlOrNull(url);
  if (!safe) return null;
  const action = { functionCall: { "@call": "openUrl", args: { url: safe } } };
  return { component: "Button", props: { variant: "default", action }, child: text("Open in Gleap") };
};

const toSurface = (surfaceId: string, root: A2uiNode): A2uiSurface => {
  const components: A2uiComponent[] = [];
  let counter = 0;
  const nextId = (): string => `c${++counter}`;
  const flatten = (node: A2uiNode, id: string): void => {
    const component: A2uiComponent = { id, component: node.component, ...node.props };
    components.push(component);
    if (node.child) {
      const childId = nextId();
      component.child = childId;
      flatten(node.child, childId);
    }
    if (node.children) {
      const kept = node.children.filter((child): child is A2uiNode => child !== null);
      const ids = kept.map(() => nextId());
      component.children = ids;
      kept.forEach((child, index) => flatten(child, ids[index]));
    }
  };
  flatten(root, "root");
  return { v: "1.0", surfaceId, catalogId: GLEAP_CATALOG_ID, components, dataModel: {} };
};

const idPart = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return cleaned.replace(/-/g, "") ? cleaned : null;
};

/**
 * `kaicode:<sessionId>:<card>-<ref>`: the session from the arguments or the
 * result (`ticket-<id>` when Gleap named none), the card kind, and the turn,
 * share or artifact id when Gleap returned one (`latest` otherwise).
 */
export const kaiCodeSurfaceId = ({ sessionId, ticketId, card, ref }: { sessionId?: unknown; ticketId?: unknown; card: string; ref?: unknown }): string => {
  const session = idPart(sessionId) ?? (idPart(ticketId) ? `ticket-${idPart(ticketId)}` : "unknown");
  return `kaicode:${session}:${card}-${idPart(ref) ?? "latest"}`;
};

/** Timeline steps for plan statuses. GleapTimeline has no cancelled state: a cancelled step is upcoming with the detail "Cancelled". */
const TIMELINE_STEP: Record<string, { state: "done" | "current" | "upcoming"; detail?: string }> = {
  pending: { state: "upcoming" },
  in_progress: { state: "current" },
  completed: { state: "done" },
  cancelled: { state: "upcoming", detail: "Cancelled" },
};

interface PlanSurfaceInput {
  surfaceId: string;
  items: Array<{ content: string; status: string }>;
  explanation?: string;
}

export const planSurface = ({ surfaceId, items, explanation }: PlanSurfaceInput): A2uiSurface => {
  const steps = items.map((i) => ({ label: i.content, ...(TIMELINE_STEP[i.status] ?? TIMELINE_STEP.pending) }));
  const done = steps.filter((step) => step.state === TIMELINE_STEP.completed.state).length;
  return toSurface(
    surfaceId,
    column([
      row([text("**Plan**"), text(`${done} of ${items.length} done`, "caption")]),
      explanation?.trim() ? text(explanation.trim(), "caption") : null,
      { component: "GleapTimeline", props: { steps } },
    ]),
  );
};

export const wrapUpSurface = ({ surfaceId, recap, ask, url }: { surfaceId: string; recap: string; ask?: string; url?: string }): A2uiSurface =>
  toSurface(
    surfaceId,
    column([
      text("**Wrap-up**"),
      text(recap.trim()),
      ask?.trim() ? text(`**${ask.trim()}**`) : null,
      text("Also shown as the next step on the Gleap session.", "caption"),
      openInGleap(url),
    ]),
  );

export const shareSurface = ({ surfaceId, caption, label, shared }: { surfaceId: string; caption: string; label?: string; shared: boolean }): A2uiSurface =>
  toSurface(
    surfaceId,
    column([
      row([text("**Screenshot**"), label ? text(label, "caption") : null]),
      text(caption),
      {
        component: "GleapStatusPill",
        props: shared ? { label: "Shared with your operator in Gleap", tone: "success" } : { label: "Shared once the upload command ran", tone: "warning" },
      },
    ]),
  );

interface ArtifactSurfaceInput {
  surfaceId: string;
  title: string;
  description?: string;
  url?: string;
}

export const artifactSurface = ({ surfaceId, title, description, url }: ArtifactSurfaceInput): A2uiSurface =>
  toSurface(surfaceId, column([text(`**${title.trim()}**`), description?.trim() ? text(description.trim(), "caption") : null, openInGleap(url)]));
