/**
 * Compact view of the Surveys 2.0 analytics payload
 * (`GET /engagement/surveys/:id/analytics`, analytics-contract §3) for agents.
 * Pure. Rates become percentages (1 decimal), times become seconds, every list
 * is capped and the per-cell heatmap is reduced to its busiest slots, so the
 * result stays small for any survey.
 */
import { clip } from "./surveyResults.js";

type Doc = Record<string, any>;

export const FUNNEL_MAX_STEPS = 30;
const BREAKDOWN_ROWS = 5;
const SOURCE_ROWS = 3;
const VERSION_ROWS = 10;
const HEATMAP_SLOTS = 3;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const round1 = (value: number) => Math.round(value * 10) / 10;
/** 0..1 → percent with one decimal. */
const pct = (value: unknown): number | null => {
  const n = num(value);
  return n === null ? null : round1(n * 100);
};
/** Milliseconds → seconds with one decimal. */
const sec = (value: unknown): number | null => {
  const n = num(value);
  return n === null ? null : round1(n / 1000);
};
const changePct = (value: number | null, previous: number | null): number | null =>
  value === null || previous === null || previous === 0 ? null : round1(((value - previous) / previous) * 100);
const arr = (value: unknown): Doc[] => (Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : []);
const title = (value: unknown) => clip(typeof value === "string" ? value : null, 120) ?? null;

type MetricKind = "count" | "rate" | "ms";

/** Header metric with its previous-period comparison. */
const metric = (raw: Doc | undefined, kind: MetricKind): Doc => {
  const convert = kind === "rate" ? pct : kind === "ms" ? sec : num;
  const value = convert(raw?.value);
  const previous = convert(raw?.previous);
  if (kind === "rate") {
    return { value, previous, deltaPts: value === null || previous === null ? null : round1(value - previous) };
  }
  return { value, previous, changePct: changePct(value, previous) };
};

/** One funnel row: what an agent needs to spot where people leave. */
const funnelRow = (step: Doc): Doc => ({
  key: step.key ?? null,
  title: title(step.title),
  type: step.type ?? null,
  viewed: num(step.viewed) ?? 0,
  answered: num(step.answered) ?? 0,
  ...(num(step.skipped) ? { skipped: step.skipped } : {}),
  dropOffPct: pct(step.dropOff),
  closedHere: num(step.closedHere) ?? 0,
  medianSec: sec(step.medianMs),
  ...(num(step.backFrom) ? { backFrom: step.backFrom } : {}),
});

/** The funnel in definition order, capped at FUNNEL_MAX_STEPS. */
export const funnelView = (analytics: Doc): Doc => {
  const steps = arr(analytics.funnel);
  return {
    funnel: steps.slice(0, FUNNEL_MAX_STEPS).map(funnelRow),
    ...(steps.length > FUNNEL_MAX_STEPS ? { funnelTruncated: steps.length } : {}),
  };
};

const breakdownRows = (rows: unknown) => arr(rows)
  .sort((a, b) => (num(b.views) ?? 0) - (num(a.views) ?? 0))
  .slice(0, BREAKDOWN_ROWS)
  .map((row) => ({
    value: clip(row.value ?? null, 80),
    views: num(row.views) ?? 0,
    starts: num(row.starts) ?? 0,
    submissions: num(row.submissions) ?? 0,
    completionRatePct: pct(row.completionRate),
    score: num(row.score),
  }));

const sourceRows = (rows: unknown, keys: string[]) => arr(rows)
  .sort((a, b) => (num(b.views) ?? 0) - (num(a.views) ?? 0))
  .slice(0, SOURCE_ROWS)
  .map((row) => ({
    ...Object.fromEntries(keys.map((key) => [key, clip(row[key] ?? null, 120)])),
    views: num(row.views) ?? 0,
    submissions: num(row.submissions) ?? 0,
  }));

/** Busiest day/hour slots of the submissions heatmap (cells are dropped). */
const heatmapView = (heatmap: Doc | undefined): Doc | null => {
  const cells = arr(heatmap?.cells).filter((cell) => (num(cell.count) ?? 0) > 0);
  if (cells.length === 0) return null;
  return {
    tz: heatmap?.tz ?? "UTC",
    topSlots: [...cells]
      .sort((a, b) => b.count - a.count)
      .slice(0, HEATMAP_SLOTS)
      .map((cell) => ({ day: DAYS[cell.dow] ?? String(cell.dow), hour: cell.hour, submissions: cell.count })),
  };
};

/** get_survey_analytics: header with deltas, funnel, drop-off, timing, score, versions, breakdowns, channels. */
export const analyticsView = (analytics: Doc): Doc => {
  const range = analytics.range ?? null;
  if (analytics.available !== true) {
    return {
      available: false,
      range,
      note: "No analytics events for this survey and range (events are recorded from Surveys 2.0 on and kept 13 months). Use get_survey_results for the stored counters.",
    };
  }
  const header: Doc = analytics.header ?? {};
  const { funnel, funnelTruncated } = funnelView(analytics);
  const steps = arr(analytics.funnel);
  const worst = steps.find((step) => step.blockId === analytics.worstStepBlockId);
  const dismissed: Doc = analytics.dismissed ?? {};
  const timing: Doc = analytics.timing ?? {};
  const score: Doc | null = analytics.score ?? null;
  const breakdowns: Doc = analytics.breakdowns ?? {};
  const sources: Doc = analytics.sources ?? {};
  const email: Doc = analytics.email ?? {};
  const quality: Doc = analytics.quality ?? {};
  const versions = arr(analytics.versions)
    .sort((a, b) => (num(b.version) ?? 0) - (num(a.version) ?? 0));
  return {
    available: true,
    range,
    header: {
      views: metric(header.views, "count"),
      uniqueViews: metric(header.uniqueViews, "count"),
      starts: metric(header.starts, "count"),
      submissions: metric(header.submissions, "count"),
      startRatePct: metric(header.startRate, "rate"),
      completionRatePct: metric(header.completionRate, "rate"),
      avgTimeToCompleteSec: metric(header.avgTimeToCompleteMs, "ms"),
      // Only when the survey has a welcome screen: the share of its viewers that pressed Start.
      ...(num(header.welcomeViews?.value) ? { welcomeStartRatePct: metric(header.welcomeStartRate, "rate") } : {}),
    },
    funnel,
    ...(funnelTruncated ? { funnelTruncated } : {}),
    worstStep: worst
      ? { key: worst.key ?? null, title: title(worst.title), viewed: num(worst.viewed) ?? 0, dropOffPct: pct(worst.dropOff), closedHere: num(worst.closedHere) ?? 0 }
      : null,
    dismissed: {
      count: num(dismissed.count) ?? 0,
      ratePct: pct(dismissed.rate),
      medianSecToDismiss: sec(dismissed.medianMsToDismiss),
    },
    timing: {
      firstAnswerMedianSec: sec(timing.firstAnswerMedianMs),
      firstAnswerP75Sec: sec(timing.firstAnswerP75Ms),
      completeMedianSec: sec(timing.completeMedianMs),
      completeP75Sec: sec(timing.completeP75Ms),
    },
    backNavigation: num(analytics.backNavigation) ?? 0,
    topClosePoints: arr(analytics.closePoints).slice(0, 5)
      .map((point) => ({ key: point.key ?? null, title: title(point.title), count: num(point.count) ?? 0 })),
    score: score
      ? {
        kind: score.kind ?? null,
        key: score.key ?? null,
        current: num(score.current),
        previous: num(score.previous),
        change: num(score.current) !== null && num(score.previous) !== null ? round1(score.current - score.previous) : null,
        n: num(score.n) ?? 0,
      }
      : null,
    versions: versions.slice(0, VERSION_ROWS).map((row) => ({
      version: row.version,
      views: num(row.views) ?? 0,
      starts: num(row.starts) ?? 0,
      submissions: num(row.submissions) ?? 0,
      completionRatePct: pct(row.completionRate),
      score: num(row.score),
      n: num(row.n) ?? 0,
    })),
    ...(versions.length > VERSION_ROWS ? { versionsTruncated: versions.length } : {}),
    breakdowns: Object.fromEntries(["channel", "device", "os", "language"]
      .map((dimension) => [dimension, breakdownRows(breakdowns[dimension])])),
    sources: {
      pagePaths: sourceRows(sources.pagePaths, ["value"]),
      referrers: sourceRows(sources.referrers, ["value"]),
      utm: sourceRows(sources.utm, ["source", "medium", "campaign"]),
    },
    busiestTimes: heatmapView(analytics.heatmap),
    reminders: {
      sent: num(analytics.reminders?.sent) ?? 0,
      resumed: num(analytics.reminders?.resumed) ?? 0,
      completed: num(analytics.reminders?.completed) ?? 0,
    },
    email: {
      sent: num(email.totals?.sent) ?? 0,
      opened: num(email.totals?.opened) ?? 0,
      answered: num(email.totals?.answered) ?? 0,
      completed: num(email.totals?.completed) ?? 0,
      campaigns: arr(email.campaigns).length,
    },
    quality: {
      speeders: num(quality.speeders) ?? 0,
      speederThresholdSec: sec(quality.speederThresholdMs),
      straightLiners: num(quality.straightLiners) ?? 0,
    },
  };
};
