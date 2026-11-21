import { z } from "zod";

export const GetCompaniesArgs = z.object({
  search: z
    .string()
    .optional()
    .describe("Case-insensitive substring match on the company name."),
  skip: z
    .number()
    .min(0)
    .optional()
    .describe("Pagination offset; number of companies to skip (default 0)."),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum companies to return (default 50, maximum 200)."),
});

export const GetCompanyArgs = z.object({
  companyId: z
    .string()
    .describe(
      "The external companyId your app sends to Gleap via the SDK (also returned as `companyId` by get_companies) — NOT the Gleap `id`.",
    ),
});

export const UpdateCompanyArgs = z.object({
  companyId: z
    .string()
    .describe(
      "The external companyId identifying the company to create or update — NOT the Gleap `id`.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Company display name. A name set here becomes authoritative — names sent by the SDK will no longer overwrite it.",
    ),
  plan: z.string().optional().describe("Subscription plan name."),
  domain: z.string().optional().describe("Company website domain."),
  value: z.number().optional().describe("Company value/revenue."),
  address: z
    .object({
      line1: z.string().optional().describe("Street and number."),
      line2: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional().describe("ZIP / postal code, as a string."),
      country: z.string().optional(),
    })
    .optional()
    .describe(
      "Address, merged into the existing address rather than replaced. Only these keys are stored and only as strings — any other key (e.g. 'street', 'zip') or a numeric postalCode is silently discarded by the server.",
    ),
  customData: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      "Arbitrary key/value pairs stored on the company (up to 100 primitive values). Merged into the existing custom data rather than replaced.",
    ),
});
