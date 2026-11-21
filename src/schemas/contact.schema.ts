import { z } from "zod";

export const SearchContactsArgs = z.object({
  searchTerm: z
    .string()
    .describe(
      "Free-text search across contact name, email, and external user ID. Use when you have a name/email keyword; for structured filters (company, exact userId) use get_contacts.",
    ),
});

export const GetContactArgs = z.object({
  contactId: z
    .string()
    .describe("The Gleap contact ID (24-char ObjectId) to retrieve."),
});

export const GetContactsArgs = z.object({
  userId: z
    .string()
    .optional()
    .describe(
      "Filter by the external user ID assigned by the customer's own system (passed to Gleap's SDK as 'userId'). Not a Gleap-internal ID.",
    ),
  name: z
    .string()
    .optional()
    .describe("Filter by the contact's display name (substring match)."),
  companyId: z
    .string()
    .optional()
    .describe("Filter to contacts belonging to this company ID."),
  companyName: z
    .string()
    .optional()
    .describe(
      "Filter to contacts whose company name matches this value (substring match).",
    ),
  email: z
    .string()
    .optional()
    .describe("Filter by email address (substring match)."),
  skip: z
    .number()
    .optional()
    .describe("Pagination offset; number of contacts to skip."),
  limit: z.number().optional().describe("Maximum contacts to return."),
});

export const CreateContactArgs = z.object({
  email: z
    .string()
    .describe(
      "Email address. Serves as the primary identifier when userId is not set — creating a second contact with the same email will usually upsert the existing record.",
    ),
  name: z.string().optional().describe("Full display name of the contact."),
  phone: z.string().optional().describe("Phone number in any readable format."),
  company: z
    .string()
    .optional()
    .describe("Company name to associate the contact with."),
  userId: z
    .string()
    .optional()
    .describe(
      "External user ID from the customer's own system. If provided, used as the stable identifier (takes precedence over email for deduplication).",
    ),
  customData: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      "Arbitrary key/value pairs stored on the contact for segmentation and personalization. Example: { plan: 'pro', signupSource: 'landing' }.",
    ),
});

export const UpdateContactArgs = z.object({
  contactId: z.string().describe("The ID of the contact to update"),
  name: z.string().optional().describe("Contact name"),
  email: z.string().optional().describe("Contact email address"),
  phone: z.string().optional().describe("Contact phone number"),
  companyId: z.string().optional().describe("Company ID to associate with"),
  companyName: z.string().optional().describe("Company name"),
  tags: z.array(z.string()).optional().describe("Tags to set on the contact"),
  customData: z.record(z.string(), z.any()).optional().describe("Custom data fields"),
  plan: z.string().optional().describe("Subscription plan name"),
  value: z.number().optional().describe("Customer value/revenue"),
});

export const GetContactTicketsArgs = z.object({
  contactId: z.string().describe("The contact ID to get tickets for"),
  status: z
    .string()
    .optional()
    .describe("Filter by ticket status (e.g., 'OPEN', 'DONE')"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum tickets to return (default: 10)"),
  skip: z
    .number()
    .min(0)
    .optional()
    .describe("Number of tickets to skip for pagination (default: 0)"),
});
