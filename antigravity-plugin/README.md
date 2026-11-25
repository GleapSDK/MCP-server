# Gleap for Antigravity

Connects Antigravity to your [Gleap](https://www.gleap.ai) workspace through Gleap's official remote MCP server. The agent can search and read tickets, answer customers, look up contacts and companies, edit help center articles and read support statistics, with your role in the project you choose.

## Install

```bash
agy plugin install https://github.com/GleapSDK/MCP-server/tree/main/antigravity-plugin
```

The first time the Gleap server connects, Antigravity opens Gleap in your browser. Sign in, pick the project and approve the access. No API key is needed.

## Region

The plugin ships one server per Gleap region. Only the EU server is on after the install.

| Server | URL | After install |
|--------|-----|---------------|
| `gleap_eu` | `https://mcp.gleap.ai/mcp` | on |
| `gleap_us` | `https://mcp.us.gleap.ai/mcp` | off |

If your workspace is hosted in the US, open the installed MCP servers in Antigravity's settings, turn `gleap_us` on and `gleap_eu` off.

## What you can ask

- "Show the open Gleap tickets with the highest priority and summarize each in one line."
- "Read the console logs and network requests of this Gleap bug report and find the cause in the code."
- "Draft a help center article in Gleap from what we just changed."

The tools are listed in the [server's README](https://github.com/GleapSDK/MCP-server#available-tools).

## Support

- Docs: https://www.gleap.ai/mcp
- Issues: https://github.com/GleapSDK/MCP-server/issues
- Security: see [SECURITY.md](../SECURITY.md)
