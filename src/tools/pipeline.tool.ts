import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AddPipelineEntryArgs,
  GetPipelineArgs,
  GetPipelineEntriesArgs,
  GetPipelineEntryArgs,
  GetPipelinesArgs,
  GetPipelineStatsArgs,
  GetRecordPipelinesArgs,
  MovePipelineEntryArgs,
  RemovePipelineEntryArgs,
  UpdatePipelineEntryValuesArgs,
} from "../schemas/pipeline.schema.js";
import { GleapApiResponse } from "../types/index.js";
import {
  buildParams,
  gleapDelete,
  gleapGet,
  gleapPost,
  gleapPut,
  isNonEmptyObject,
  validationErrorResponse,
  wrapResponse,
} from "../utils/api.js";
import {
  projectList,
  slimPipeline,
  slimPipelineEntry,
  slimPipelineField,
  toIdString,
} from "../utils/projections.js";

const PIPELINE_LIST_TYPE = "pipeline_list";
const ENTRY_LIST_TYPE = "pipeline_entry_list";
const RECORD_PIPELINE_LIST_TYPE = "record_pipeline_list";

/** True when a wrapped Gleap response carries an error envelope. */
const isErrorResponse = (response: GleapApiResponse): boolean => {
  const sc = response.structuredContent as any;
  return !!(sc && typeof sc === "object" && sc.error);
};

const dataOf = (response: GleapApiResponse): any => response.structuredContent;

/** The list inside a wrapped response — arrays are re-shaped to `{ results }`. */
const resultsOf = (response: GleapApiResponse): any[] => {
  const sc = response.structuredContent as any;
  return Array.isArray(sc?.results) ? sc.results : [];
};

// ── Stage helpers ──────────────────────────────────────────────────────────
// The backend calls stages "lanes". Two write-path behaviors make upfront
// validation load-bearing rather than cosmetic: an unknown laneId on add PARKS
// THE ENTRY OUTSIDE EVERY BOARD COLUMN (invisible on the board), and an unknown
// laneId on move is silently dropped (the tool would report success while
// nothing moved). The Admin API validates server-side for the same reason; the
// v3 dashboard routes don't, because the dashboard always sends valid ids.

const stagesOf = (pipeline: any): any[] =>
  Array.isArray(pipeline?.lanes) ? pipeline.lanes : [];

const activeStagesOf = (pipeline: any): any[] =>
  stagesOf(pipeline).filter((lane) => !lane?.archived);

const findStage = (pipeline: any, stageId: string): any =>
  stagesOf(pipeline).find((lane) => lane?.id === stageId);

const stageTitlesOf = (pipeline: any): Map<string, string> =>
  new Map(
    stagesOf(pipeline).map((lane) => [
      String(lane?.id),
      String(lane?.title ?? ""),
    ]),
  );

const describeStages = (stages: any[]): string =>
  stages.map((lane) => `'${lane?.title}' (id: ${lane?.id})`).join(", ");

const invalidStageResponse = (
  pipeline: any,
  stageId: string,
  intent: string,
): GleapApiResponse => {
  const stage = findStage(pipeline, stageId);
  const problem = stage
    ? `Stage '${stage.title}' (${stageId}) is archived`
    : `Unknown stageId '${stageId}'`;
  return validationErrorResponse(
    `${problem} — ${intent} requires an active stage of pipeline '${
      pipeline?.name ?? toIdString(pipeline)
    }'. Active stages: ${describeStages(activeStagesOf(pipeline)) || "none"}.`,
  );
};

// ── Field helpers ──────────────────────────────────────────────────────────
// These three constants MIRROR the server's own guards. Columns and property
// fieldIds are writable without normalisation, so a pipeline can legitimately
// hold a column the server will refuse to aggregate or a fieldId it will refuse
// to write a value under. Re-applying the same rules here is what keeps the
// tools from advertising a calculation that silently never runs.

/** Mirrors CALCULATIONS in Server/src/services/pipelines/laneAggregation.ts. */
const CALCULATIONS = new Set([
  "sum",
  "count",
  "average",
  "min",
  "max",
  "filled",
  "empty",
]);

/** Mirrors FIELD_ID_PATTERN in the same file — one identifier segment. */
const FIELD_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Mirrors isAllowedKey in Server/src/services/pipelines/pipelineEntryData.ts. */
const isWritableFieldId = (fieldId: unknown): fieldId is string =>
  typeof fieldId === "string" &&
  fieldId.length > 0 &&
  !fieldId.startsWith("$") &&
  !fieldId.includes(".") &&
  !["__proto__", "constructor", "prototype"].includes(fieldId);

/**
 * calculation per fieldId, joined from `pipeline.columns` (which store
 * propertyId + calculation) over the pipeline's properties (which carry the
 * fieldId that entry values and stats keys use).
 *
 * Only pairs the SERVER will actually aggregate are returned: it skips any
 * column whose calculation or fieldId fails the guards above, emitting no
 * `calc_<fieldId>` key at all. Reporting such a column would surface a
 * permanent `value: null` that reads as "no data" rather than "never computed".
 */
const fieldCalculations = (
  pipeline: any,
  fields: any[],
): Map<string, string> => {
  const fieldIdByPropertyId = new Map(
    fields.map((field) => [toIdString(field) ?? "", field?.fieldId]),
  );
  const calculations = new Map<string, string>();
  const columns = Array.isArray(pipeline?.columns) ? pipeline.columns : [];
  for (const column of columns) {
    const fieldId = fieldIdByPropertyId.get(String(column?.propertyId));
    const calculation = column?.calculation;
    if (typeof fieldId !== "string" || !FIELD_ID_PATTERN.test(fieldId)) continue;
    if (typeof calculation !== "string" || !CALCULATIONS.has(calculation))
      continue;
    calculations.set(fieldId, calculation);
  }
  return calculations;
};

/**
 * Value keys this pipeline will not actually store. Two ways to fail: the key
 * matches no field (the server stores unknown keys as-is, so they would pollute
 * the entry while showing up in no column or calculation), or it matches a
 * field whose fieldId the server's own normaliser refuses to write under — in
 * which case `updateEntryValues` short-circuits on an empty set and returns the
 * entry UNCHANGED, which would otherwise be reported as a successful write.
 */
const unwritableValueKeys = (
  values: Record<string, unknown>,
  fields: any[],
): string[] => {
  const writable = new Set(
    fields.map((field) => field?.fieldId).filter(isWritableFieldId),
  );
  return Object.keys(values).filter((key) => !writable.has(key));
};

const invalidValueKeysResponse = (
  pipeline: any,
  badKeys: string[],
  fields: any[],
): GleapApiResponse => {
  const valid = fields
    .filter((field) => isWritableFieldId(field?.fieldId))
    .map((field) => `'${field?.fieldId}' (${field?.label})`)
    .join(", ");
  return validationErrorResponse(
    `Unknown field key(s) ${badKeys.map((k) => `'${k}'`).join(", ")} for pipeline '${
      pipeline?.name ?? toIdString(pipeline)
    }'. ${
      valid
        ? `Valid value keys (fieldIds): ${valid}.`
        : "This pipeline has no fields yet — create fields in the dashboard first, or omit values."
    }`,
  );
};

export const registerPipelineTools = (server: McpServer) => {
  server.registerTool(
    "get_pipelines",
    {
      title: "Get Pipelines",
      description:
        "List the CRM pipelines visible to this connection. Each pipeline holds records of exactly one type (recordType COMPANY or CONTACT) and carries its stages in order — pass a stage `id` as stageId when adding or moving entries. Call get_pipeline for a pipeline's fields (needed for entry values). Only pipelines that are public or explicitly shared with this connection's user are listed, so a pipeline the user expects may be missing because it is private — in Gleap, open the pipeline's settings and make it public or share it.",
      inputSchema: GetPipelinesArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (): Promise<GleapApiResponse> => {
      const response = await gleapGet("/pipelines", {
        listType: PIPELINE_LIST_TYPE,
      });
      return projectList(response, slimPipeline);
    },
  );

  server.registerTool(
    "get_pipeline",
    {
      title: "Get Pipeline",
      description:
        "Get one pipeline including its stages (in board order) and its fields. Entry `values` are keyed by each field's `fieldId`; a field's `calculation` (sum/count/average/min/max/filled/empty) is what get_pipeline_stats aggregates for it — fields without one are not aggregated.",
      inputSchema: GetPipelineArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ pipelineId }): Promise<GleapApiResponse> => {
      const [pipelineResponse, fieldsResponse] = await Promise.all([
        gleapGet(`/pipelines/${pipelineId}`),
        gleapGet(`/pipelines/${pipelineId}/properties`),
      ]);
      if (isErrorResponse(pipelineResponse)) return pipelineResponse;
      if (isErrorResponse(fieldsResponse)) return fieldsResponse;

      const pipeline = dataOf(pipelineResponse);
      const fields = resultsOf(fieldsResponse);
      const calculations = fieldCalculations(pipeline, fields);
      return wrapResponse({
        ...slimPipeline(pipeline),
        fields: fields.map((field) =>
          slimPipelineField(field, calculations.get(field?.fieldId) ?? null),
        ),
      });
    },
  );

  server.registerTool(
    "get_pipeline_stats",
    {
      title: "Get Pipeline Stats",
      description:
        "Per-stage entry counts and field aggregations for a pipeline, plus whole-pipeline totals — e.g. the sum of deal values in each stage. Aggregations cover the fields with a `calculation` configured (see get_pipeline); to aggregate a field without one, list the entries with get_pipeline_entries and compute from their values. Averages in `totals` are true pipeline-wide averages, not an average of the stage averages.",
      inputSchema: GetPipelineStatsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ pipelineId }): Promise<GleapApiResponse> => {
      const [pipelineResponse, fieldsResponse, laneStatsResponse, totalsResponse] =
        await Promise.all([
          gleapGet(`/pipelines/${pipelineId}`),
          gleapGet(`/pipelines/${pipelineId}/properties`),
          gleapGet(`/pipelines/${pipelineId}/lane-stats`),
          gleapGet(`/pipelines/${pipelineId}/table-stats`),
        ]);
      for (const response of [
        pipelineResponse,
        fieldsResponse,
        laneStatsResponse,
        totalsResponse,
      ]) {
        if (isErrorResponse(response)) return response;
      }

      const pipeline = dataOf(pipelineResponse);
      const fields = resultsOf(fieldsResponse);
      const calculations = fieldCalculations(pipeline, fields);
      const fieldByFieldId = new Map(
        fields.map((field) => [field?.fieldId, field]),
      );
      const calcColumns = [...calculations.entries()].map(
        ([fieldId, calculation]) => {
          const field = fieldByFieldId.get(fieldId);
          return {
            fieldId,
            label: field?.label ?? fieldId,
            calculation,
            // Present for CURRENCY fields — an aggregate of money is
            // meaningless to report without it.
            ...(field?.currency ? { currency: field.currency } : {}),
          };
        },
      );
      // Stats rows key aggregations as `calc_<fieldId>`; re-shape them into
      // self-describing entries so no caller has to know that convention.
      const readCalculations = (row: any) =>
        calcColumns.map((column) => ({
          ...column,
          value: row?.[`calc_${column.fieldId}`] ?? null,
        }));

      const rowByStage = new Map<string, any>(
        resultsOf(laneStatsResponse).map((row) => [String(row?.laneId), row]),
      );
      const stages: any[] = stagesOf(pipeline).map((lane) => {
        const row = rowByStage.get(String(lane?.id));
        rowByStage.delete(String(lane?.id));
        return {
          stageId: lane?.id ?? null,
          stage: lane?.title ?? null,
          ...(lane?.archived ? { archived: true } : {}),
          count: row?.count ?? 0,
          calculations: readCalculations(row),
        };
      });
      // Entries can sit in a stage that no longer exists on the pipeline, or in
      // none at all (`laneId` unset) — keep their bucket visible instead of
      // dropping it, but never hand back the string "null" as if it were a
      // usable stage id.
      for (const [stageId, row] of rowByStage) {
        const isRealId = stageId !== "null" && stageId !== "undefined";
        stages.push({
          stageId: isRealId ? stageId : null,
          stage: null,
          unassigned: !isRealId,
          count: row?.count ?? 0,
          calculations: readCalculations(row),
        });
      }

      const totalsRow = dataOf(totalsResponse);
      return wrapResponse({
        pipelineId: toIdString(pipeline),
        name: pipeline?.name ?? null,
        recordType: pipeline?.recordType ?? null,
        stages,
        totals: {
          count: totalsRow?.count ?? 0,
          calculations: readCalculations(totalsRow),
        },
      });
    },
  );

  server.registerTool(
    "get_pipeline_entries",
    {
      title: "Get Pipeline Entries",
      description:
        "List a pipeline's entries — every record on the pipeline with its stage and field values. Pass stageId to list one stage (board order); omit it to list across all stages with a `total` for pagination. Each entry carries a `record` snapshot (name, plan, value) of its company/contact.",
      inputSchema: GetPipelineEntriesArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ pipelineId, stageId, skip, limit }): Promise<GleapApiResponse> => {
      const pipelineResponse = await gleapGet(`/pipelines/${pipelineId}`);
      if (isErrorResponse(pipelineResponse)) return pipelineResponse;
      const pipeline = dataOf(pipelineResponse);
      const stageTitles = stageTitlesOf(pipeline);

      if (stageId != null) {
        const stage = findStage(pipeline, stageId);
        if (!stage) {
          return validationErrorResponse(
            `Unknown stageId '${stageId}' for pipeline '${pipeline?.name}'. Stages: ${
              describeStages(stagesOf(pipeline)) || "none"
            }.`,
          );
        }
        const response = await gleapGet(`/pipelines/${pipelineId}/entries`, {
          params: buildParams({ laneId: stageId, skip, limit }),
          listType: ENTRY_LIST_TYPE,
        });
        if (isErrorResponse(response)) return response;
        const entries = resultsOf(response).map((entry) =>
          slimPipelineEntry(entry, stageTitles),
        );
        return wrapResponse({
          results: entries,
          count: entries.length,
          type: ENTRY_LIST_TYPE,
          stage: { id: stage.id, title: stage.title ?? null },
        });
      }

      const response = await gleapGet(`/pipelines/${pipelineId}/table`, {
        params: buildParams({ skip, limit }),
      });
      if (isErrorResponse(response)) return response;
      const data = dataOf(response);
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      const entries = rows.map((entry: any) =>
        slimPipelineEntry(entry, stageTitles),
      );
      return wrapResponse({
        results: entries,
        count: entries.length,
        total: data?.total ?? entries.length,
        type: ENTRY_LIST_TYPE,
      });
    },
  );

  server.registerTool(
    "get_pipeline_entry",
    {
      title: "Get Pipeline Entry",
      description:
        "Get one pipeline entry together with its pipeline (stages and record type) — the full context needed to move it or update its values.",
      inputSchema: GetPipelineEntryArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ entryId }): Promise<GleapApiResponse> => {
      const response = await gleapGet(`/pipeline-entries/${entryId}`);
      if (isErrorResponse(response)) return response;
      const { entry, pipeline } = dataOf(response) ?? {};
      return wrapResponse({
        entry: slimPipelineEntry(entry, stageTitlesOf(pipeline)),
        pipeline: pipeline ? slimPipeline(pipeline) : null,
      });
    },
  );

  server.registerTool(
    "add_pipeline_entry",
    {
      title: "Add Pipeline Entry",
      description:
        "Add a company or contact to a pipeline, optionally into a specific stage and with initial field values. A record sits on a pipeline at most once — adding one that is already present returns the existing entry unchanged (check its createdAt). Pipeline automations configured for 'record added' run on a genuine add.",
      inputSchema: AddPipelineEntryArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({
      pipelineId,
      recordId,
      stageId,
      values,
    }): Promise<GleapApiResponse> => {
      const hasValues = isNonEmptyObject(values);
      const [pipelineResponse, fieldsResponse] = await Promise.all([
        gleapGet(`/pipelines/${pipelineId}`),
        hasValues
          ? gleapGet(`/pipelines/${pipelineId}/properties`)
          : Promise.resolve(null),
      ]);
      if (isErrorResponse(pipelineResponse)) return pipelineResponse;
      if (fieldsResponse && isErrorResponse(fieldsResponse))
        return fieldsResponse;
      const pipeline = dataOf(pipelineResponse);

      if (stageId != null) {
        const stage = findStage(pipeline, stageId);
        if (!stage || stage.archived) {
          return invalidStageResponse(pipeline, stageId, "adding an entry");
        }
      }
      if (fieldsResponse && hasValues) {
        const fields = resultsOf(fieldsResponse);
        const badKeys = unwritableValueKeys(values!, fields);
        if (badKeys.length > 0) {
          return invalidValueKeysResponse(pipeline, badKeys, fields);
        }
      }

      // The server does NOT check that recordId resolves: it snapshots whatever
      // it finds and creates the entry regardless, so a wrong-type or foreign
      // id yields a permanent nameless card that nothing later repairs. The
      // dashboard never hits this (it picks ids from a list) but an agent can.
      // Contacts are checkable outright; companies have no by-id route, so they
      // are caught after the fact via the snapshot (see below).
      if (pipeline?.recordType === "CONTACT") {
        const contactResponse = await gleapGet(`/sessions/${recordId}`);
        if (isErrorResponse(contactResponse)) {
          return validationErrorResponse(
            `recordId '${recordId}' is not a contact in this project. Pipeline '${pipeline?.name}' holds CONTACT records — pass a contact's \`id\` from get_contacts or search_contacts, not a company id or an external userId.`,
          );
        }
      }

      const response = await gleapPost(
        `/pipelines/${pipelineId}/entries`,
        buildParams({ recordId, laneId: stageId, values }),
      );
      if (isErrorResponse(response)) return response;
      const entry = dataOf(response);

      // A resolved company always snapshots `externalId` (it mirrors the
      // required, unique `companyId`), so its absence means the id matched no
      // company. Reported rather than auto-removed: the entry exists and its
      // "record added" automations have already fired, and deleting another
      // party's row is not this tool's call to make.
      if (
        pipeline?.recordType === "COMPANY" &&
        !entry?.recordSnapshot?.externalId
      ) {
        return validationErrorResponse(
          `recordId '${recordId}' matched no company in this project, so entry ${
            entry?.id ?? entry?._id
          } was created with no record behind it and will show as an empty card. Remove it with remove_pipeline_entry, then retry with a company's \`id\` from get_companies (not the external companyId, and not a contact id).`,
        );
      }

      return wrapResponse({
        success: true,
        entry: slimPipelineEntry(entry, stageTitlesOf(pipeline)),
      });
    },
  );

  server.registerTool(
    "move_pipeline_entry",
    {
      title: "Move Pipeline Entry",
      description:
        "Move a pipeline entry to another stage of its pipeline — e.g. advance a deal from 'Negotiation' to 'Won'. Moving to a new stage runs the pipeline automations configured for that stage.",
      inputSchema: MovePipelineEntryArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ entryId, stageId }): Promise<GleapApiResponse> => {
      const entryResponse = await gleapGet(`/pipeline-entries/${entryId}`);
      if (isErrorResponse(entryResponse)) return entryResponse;
      const { entry, pipeline } = dataOf(entryResponse) ?? {};

      const stage = findStage(pipeline, stageId);
      if (!stage || stage.archived) {
        return invalidStageResponse(pipeline, stageId, "moving an entry");
      }
      const stageTitles = stageTitlesOf(pipeline);
      if (entry?.laneId === stageId) {
        return wrapResponse({
          success: true,
          unchanged: true,
          message: `Entry is already in stage '${stage.title}'.`,
          entry: slimPipelineEntry(entry, stageTitles),
        });
      }

      const fromStage = stageTitles.get(String(entry?.laneId)) ?? entry?.laneId;
      const response = await gleapPut(`/pipeline-entries/${entryId}/move`, {
        laneId: stageId,
      });
      if (isErrorResponse(response)) return response;
      const moved = dataOf(response);
      return wrapResponse({
        success: true,
        message: `Moved '${
          moved?.recordSnapshot?.name ?? "entry"
        }' from '${fromStage}' to '${stage.title}'.`,
        entry: slimPipelineEntry(moved, stageTitles),
      });
    },
  );

  server.registerTool(
    "update_pipeline_entry_values",
    {
      title: "Update Pipeline Entry Values",
      description:
        "Update a pipeline entry's field values (e.g. set a deal value). Sent keys are merged into the existing values — fields you do not send are left untouched — and sending null clears a field. Keys must be the pipeline's field fieldIds (see get_pipeline).",
      inputSchema: UpdatePipelineEntryValuesArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ entryId, values }): Promise<GleapApiResponse> => {
      if (!isNonEmptyObject(values)) {
        return validationErrorResponse(
          "values must contain at least one field key. Call get_pipeline to see the pipeline's fieldIds.",
        );
      }
      const entryResponse = await gleapGet(`/pipeline-entries/${entryId}`);
      if (isErrorResponse(entryResponse)) return entryResponse;
      const { pipeline } = dataOf(entryResponse) ?? {};
      // Deleting a pipeline cascades to its entries, so a resolved entry
      // normally has one — only a concurrent delete lands here.
      if (!pipeline) {
        return validationErrorResponse(
          `Entry ${entryId} has no pipeline — it may have just been deleted.`,
        );
      }

      const fieldsResponse = await gleapGet(
        `/pipelines/${toIdString(pipeline)}/properties`,
      );
      if (isErrorResponse(fieldsResponse)) return fieldsResponse;
      const fields = resultsOf(fieldsResponse);
      const badKeys = unwritableValueKeys(values, fields);
      if (badKeys.length > 0) {
        return invalidValueKeysResponse(pipeline, badKeys, fields);
      }

      const response = await gleapPut(`/pipeline-entries/${entryId}/values`, {
        values,
      });
      if (isErrorResponse(response)) return response;
      return wrapResponse({
        success: true,
        entry: slimPipelineEntry(dataOf(response), stageTitlesOf(pipeline)),
      });
    },
  );

  server.registerTool(
    "remove_pipeline_entry",
    {
      title: "Remove Pipeline Entry",
      description:
        "Remove an entry from its pipeline. Only the pipeline membership is deleted — the underlying company or contact is untouched.",
      inputSchema: RemovePipelineEntryArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ entryId }): Promise<GleapApiResponse> => {
      // Resolve first: the delete route returns success even for an id that
      // does not exist, and the response alone can't name what was removed.
      const entryResponse = await gleapGet(`/pipeline-entries/${entryId}`);
      if (isErrorResponse(entryResponse)) return entryResponse;
      const { entry, pipeline } = dataOf(entryResponse) ?? {};

      const response = await gleapDelete(`/pipeline-entries/${entryId}`);
      if (isErrorResponse(response)) return response;
      return wrapResponse({
        success: true,
        message: `Removed '${
          entry?.recordSnapshot?.name ?? entryId
        }' from pipeline '${pipeline?.name ?? toIdString(entry?.pipeline)}'. The underlying ${
          pipeline?.recordType === "CONTACT" ? "contact" : "company"
        } record was not deleted.`,
      });
    },
  );

  server.registerTool(
    "get_record_pipelines",
    {
      title: "Get Record Pipelines",
      description:
        "Which pipelines a company or contact is on, with its entry (stage and values) in each — e.g. to check whether a company is already in the sales pipeline before adding it.",
      inputSchema: GetRecordPipelinesArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ recordType, recordId }): Promise<GleapApiResponse> => {
      const response = await gleapGet("/pipeline-entries/for-record", {
        params: { recordType, recordId },
        listType: RECORD_PIPELINE_LIST_TYPE,
      });
      if (isErrorResponse(response)) return response;

      const results = resultsOf(response).map((row) => {
        const pipeline = row?.pipeline;
        return {
          pipeline: pipeline
            ? {
                id: toIdString(pipeline),
                name: pipeline.name ?? null,
                recordType: pipeline.recordType ?? null,
              }
            : null,
          entry: slimPipelineEntry(row?.entry, stageTitlesOf(pipeline)),
        };
      });
      return wrapResponse({
        results,
        count: results.length,
        type: RECORD_PIPELINE_LIST_TYPE,
      });
    },
  );
};
