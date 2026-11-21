import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GetCompaniesArgs,
  GetCompanyArgs,
  UpdateCompanyArgs,
} from "../schemas/company.schema.js";
import { GleapApiResponse } from "../types/index.js";
import {
  buildParams,
  gleapGet,
  gleapPut,
  validationErrorResponse,
} from "../utils/api.js";
import {
  projectList,
  projectSingle,
  slimCompany,
} from "../utils/projections.js";

const COMPANY_LIST_TYPE = "company_list";

// External companyIds are customer-chosen and can contain '/', '#' or '?'
// (domains are a common choice) — always encode them into the path.
const companyPath = (companyId: string): string =>
  `/companies/${encodeURIComponent(companyId)}`;

export const registerCompanyTools = (server: McpServer) => {
  server.registerTool(
    "get_companies",
    {
      title: "Get Companies",
      description:
        "List the project's companies (organisations), most recently seen first, optionally filtered by a name search. Each row carries two identifiers: `id` (the Gleap id — what pipeline tools take as recordId) and `companyId` (the external id your app sends via the SDK — what get_company/update_company take). Returns summaries; call get_company for the full record including custom data.",
      inputSchema: GetCompaniesArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ search, skip, limit }): Promise<GleapApiResponse> => {
      const response = await gleapGet("/companies", {
        params: buildParams({ search, skip, limit }),
        listType: COMPANY_LIST_TYPE,
      });
      return projectList(response, slimCompany);
    },
  );

  server.registerTool(
    "get_company",
    {
      title: "Get Company",
      description:
        "Get one company by its external companyId (the identifier your app sends via the SDK — not the Gleap `id`), including address and custom data. To find contacts belonging to it, use get_contacts with the same companyId.",
      inputSchema: GetCompanyArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ companyId }): Promise<GleapApiResponse> => {
      const response = await gleapGet(companyPath(companyId));
      // Companies have no `id` virtual (unlike contacts/pipelines) — the raw
      // payload carries `_id` only. Surface `id` too, so the one identifier the
      // pipeline tools need as `recordId` is present under the name every other
      // tool here uses for it.
      return projectSingle(response, (company) => ({
        id: company._id ?? null,
        ...company,
      }));
    },
  );

  server.registerTool(
    "update_company",
    {
      title: "Update Company",
      description:
        "Create or update a company by its external companyId (upsert). Only name, plan, domain, value, address and customData are accepted; address and customData are merged into the existing values rather than replaced. Setting a non-empty name marks it authoritative, so names sent by the SDK will no longer overwrite it.",
      inputSchema: UpdateCompanyArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({
      companyId,
      name,
      plan,
      domain,
      value,
      address,
      customData,
    }): Promise<GleapApiResponse> => {
      const body = buildParams({
        name,
        plan,
        domain,
        value,
        address,
        customData,
      });
      // This route is an UPSERT: an empty body still creates a nameless company
      // and rewrites `lastSeenAt`, which reorders the (last-seen-sorted) company
      // list and destroys the "a contact of this company was active" meaning of
      // that field. An attribute-less call is never what the caller wanted.
      if (Object.keys(body).length === 0) {
        return validationErrorResponse(
          `Nothing to update: pass at least one of name, plan, domain, value, address or customData. To read a company without changing it, use get_company.`,
        );
      }
      return gleapPut(companyPath(companyId), body);
    },
  );
};
