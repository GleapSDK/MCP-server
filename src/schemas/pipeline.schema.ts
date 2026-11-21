import { z } from "zod";

/**
 * Entry field values, keyed by the pipeline's field `fieldId`s. The server only
 * stores primitives (anything else is dropped), so the schema enforces that
 * upfront; `null` clears a field.
 */
const EntryValues = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .describe(
    "Field values keyed by the pipeline's field fieldIds — call get_pipeline to see them. Primitive values only (string, number, boolean); null clears a field. Example: { deal_value: 5000 }.",
  );

export const GetPipelinesArgs = z.object({});

export const GetPipelineArgs = z.object({
  pipelineId: z
    .string()
    .describe("The pipeline ID (24-char ObjectId), e.g. from get_pipelines."),
});

export const GetPipelineStatsArgs = z.object({
  pipelineId: z
    .string()
    .describe("The pipeline ID (24-char ObjectId), e.g. from get_pipelines."),
});

export const GetPipelineEntriesArgs = z.object({
  pipelineId: z
    .string()
    .describe("The pipeline ID (24-char ObjectId), e.g. from get_pipelines."),
  stageId: z
    .string()
    .optional()
    .describe(
      "Filter to one stage — a stage `id` from the pipeline's stages. Omit to list entries across all stages.",
    ),
  skip: z
    .number()
    .min(0)
    .optional()
    .describe("Pagination offset; number of entries to skip (default 0)."),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum entries to return (default 50, maximum 200)."),
});

export const GetPipelineEntryArgs = z.object({
  entryId: z
    .string()
    .describe("The pipeline entry ID (24-char ObjectId), e.g. from get_pipeline_entries."),
});

export const AddPipelineEntryArgs = z.object({
  pipelineId: z
    .string()
    .describe("The pipeline to add the record to (24-char ObjectId)."),
  recordId: z
    .string()
    .describe(
      "Gleap id of the record to add, matching the pipeline's recordType: a company's `id` from get_companies/get_company for COMPANY pipelines, or a contact's `id` from get_contacts/search_contacts for CONTACT pipelines. NOT your own external companyId or userId.",
    ),
  stageId: z
    .string()
    .optional()
    .describe(
      "Stage to add the entry to — a stage `id` from the pipeline's stages. Defaults to the pipeline's first active stage.",
    ),
  values: EntryValues.optional(),
});

export const MovePipelineEntryArgs = z.object({
  entryId: z
    .string()
    .describe("The pipeline entry ID to move, e.g. from get_pipeline_entries."),
  stageId: z
    .string()
    .describe(
      "Target stage — a stage `id` from the entry's pipeline (call get_pipeline or get_pipeline_entry to see them).",
    ),
});

export const UpdatePipelineEntryValuesArgs = z.object({
  entryId: z
    .string()
    .describe("The pipeline entry ID to update, e.g. from get_pipeline_entries."),
  values: EntryValues,
});

export const RemovePipelineEntryArgs = z.object({
  entryId: z
    .string()
    .describe("The pipeline entry ID to remove, e.g. from get_pipeline_entries."),
});

export const GetRecordPipelinesArgs = z.object({
  recordType: z
    .enum(["COMPANY", "CONTACT"])
    .describe("Whether the record is a company or a contact."),
  recordId: z
    .string()
    .describe(
      "Gleap id of the record: a company's `id` from get_companies/get_company, or a contact's `id` from get_contacts/search_contacts. NOT your own external companyId or userId.",
    ),
});
