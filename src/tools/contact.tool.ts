import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateContactArgs,
  GetContactArgs,
  GetContactsArgs,
  GetContactTicketsArgs,
  SearchContactsArgs,
  UpdateContactArgs,
} from "../schemas/contact.schema.js";
import { GleapApiResponse } from "../types/index.js";
import { buildParams, gleapGet, gleapPost, gleapPut } from "../utils/api.js";
import { projectList, slimContact, slimTicket } from "../utils/projections.js";

export const registerContactTools = (server: McpServer) => {
  server.registerTool(
    "search_contacts",
    {
      title: "Search Contacts",
      description:
        "Free-text KEYWORD search for contacts (name, email, etc.). Use when you have a search term. To filter contacts by specific fields (userId, companyId, companyName, email), use get_contacts instead — don't call both for the same intent. Returns lightweight summaries (identity fields, company, plan, value, timestamps); call `get_contact` for the full contact including custom data.",
      inputSchema: SearchContactsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ searchTerm }): Promise<GleapApiResponse> => {
      const response = await gleapGet("/sessions/search", {
        params: { searchTerm },
        listType: "contact_list",
      });
      return projectList(response, slimContact);
    },
  );

  server.registerTool(
    "get_contacts",
    {
      title: "Get Contacts",
      description:
        "FILTER contacts by structured fields (userId, name, companyId, companyName, email) with pagination — NOT free-text. For keyword search use search_contacts instead; don't call both for the same intent. Returns lightweight summaries (identity fields, company, plan, value, timestamps); call `get_contact` for the full contact including custom data.",
      inputSchema: GetContactsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      userId,
      name,
      companyId,
      companyName,
      email,
      skip,
      limit,
    }): Promise<GleapApiResponse> => {
      const params = buildParams({
        userId,
        name,
        companyId,
        companyName,
        email,
        skip,
        limit,
      });
      const response = await gleapGet("/sessions", {
        params,
        listType: "contact_list",
      });
      return projectList(response, slimContact);
    },
  );

  server.registerTool(
    "get_contact",
    {
      title: "Get Contact",
      description: "Retrieve a specific contact by ID from Gleap.",
      inputSchema: GetContactArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ contactId }): Promise<GleapApiResponse> => {
      return gleapGet(`/sessions/${contactId}`);
    },
  );

  server.registerTool(
    "create_contact",
    {
      title: "Create Contact",
      description: "Create a new contact in Gleap.",
      inputSchema: CreateContactArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({
      email,
      name,
      phone,
      company,
      userId,
      customData,
    }): Promise<GleapApiResponse> => {
      const body = buildParams({
        email,
        name,
        phone,
        company,
        userId,
        customData,
      });
      return gleapPost("/sessions", body);
    },
  );

  server.registerTool(
    "update_contact",
    {
      title: "Update Contact",
      description:
        "Update a contact's properties such as name, email, phone, company, tags, custom data, plan, or value.",
      inputSchema: UpdateContactArgs.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({
      contactId,
      name,
      email,
      phone,
      companyId,
      companyName,
      tags,
      customData,
      plan,
      value,
    }): Promise<GleapApiResponse> => {
      const body = buildParams({
        name,
        email,
        phone,
        companyId,
        companyName,
        tags,
        customData,
        plan,
        value,
      });
      return gleapPut(`/sessions/${contactId}`, body);
    },
  );

  server.registerTool(
    "get_contact_tickets",
    {
      title: "Get Contact Tickets",
      description:
        "Get all tickets associated with a specific contact. Useful for reviewing a customer's support history. Returns lightweight ticket summaries; call `get_ticket` for the full ticket and conversation.",
      inputSchema: GetContactTicketsArgs.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ contactId, status, limit, skip }): Promise<GleapApiResponse> => {
      const params = buildParams({
        session: contactId,
        limit: limit ?? 10,
        skip: skip ?? 0,
        status,
      });
      const response = await gleapGet("/tickets", {
        params,
        listType: "ticket_list",
      });
      return projectList(response, slimTicket);
    },
  );
};
