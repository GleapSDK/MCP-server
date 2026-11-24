# Security policy

This repository is the source of Gleap's hosted MCP server (`https://mcp.gleap.ai/mcp` and `https://mcp.us.gleap.ai/mcp`). The `main` branch is what runs in production, so only `main` receives security fixes.

## Reporting a vulnerability

Please report security issues privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for a security problem.

Include what you found, the steps or request that show it, and what an attacker could gain. We confirm receipt, keep you updated while we fix it, and credit you in the advisory if you wish.

## Scope

In scope: this server's code and its hosted endpoints — authentication and token handling, the customer-session scope, redaction of share tokens and credentials in tool results, and requests the server makes on a caller's behalf.

Out of scope: denial of service by volume, social engineering, and issues in the Gleap dashboard or REST API that do not involve this server (report those to Gleap through https://www.gleap.ai).

Please test only against your own Gleap workspace, never against other customers' data.
