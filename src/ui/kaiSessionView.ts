import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { A2UI_RENDERER_JS } from "./a2uiRenderer.js";

/**
 * MCP Apps view for the Kai Code session tools (update_plan, wrap_up,
 * share_screenshot, publish_artifact). Hosts that support MCP Apps
 * (SEP-1865, modelcontextprotocol/ext-apps) render this page inline under the
 * tool call with the result's `structuredContent.a2ui` (an A2UI 1.0 surface,
 * drawn by the generic renderer in `a2uiRenderer.ts`); every other client
 * reads the text content, which always carries the full result.
 *
 * Registered by hand (the ext-apps server helpers need MCP SDK 2.x + zod 4;
 * this server runs SDK 1.17 + zod 3): one `ui://` resource with mimeType
 * `text/html;profile=mcp-app`, and `_meta.ui.resourceUri` on the linked tools.
 *
 * The page is self-contained: no external loads (scripts, fonts, images), so
 * the host's default CSP (`connect-src 'none'`) is enough.
 */

export const KAI_SESSION_UI_URI = "ui://gleap/kai-session";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export const KAI_SESSION_UI_TOOLS = new Set(["update_plan", "wrap_up", "share_screenshot", "publish_artifact"]);

const VIEW_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gleap session</title>
<style>
:root{color-scheme:light dark;--bg:var(--color-background-primary,#fff);--fg:var(--color-text-primary,#18181b);--muted:var(--color-text-secondary,#71717a);--line:var(--color-border-primary,#e4e4e7);--accent:#485bff;--on-accent:#fff;--ok:#16a34a;--warn:#d97706;--danger:#dc2626;--radius:var(--border-radius-md,10px);font-family:var(--font-sans,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:var(--color-background-primary,#18181b);--fg:var(--color-text-primary,#f4f4f5);--muted:var(--color-text-secondary,#a1a1aa);--line:var(--color-border-primary,#3f3f46);--accent:#8b98ff;--on-accent:#0b0b12}}
:root[data-theme=dark]{--bg:var(--color-background-primary,#18181b);--fg:var(--color-text-primary,#f4f4f5);--muted:var(--color-text-secondary,#a1a1aa);--line:var(--color-border-primary,#3f3f46);--accent:#8b98ff;--on-accent:#0b0b12}
html,body{margin:0;background:transparent;color:var(--fg);font-size:14px;line-height:1.45}
.card{border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;background:var(--bg)}
.col{display:flex;flex-direction:column;gap:6px}.row{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.a2card{border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px}.divider{border-top:1px solid var(--line);margin:4px 0}
.muted{color:var(--muted)}.caption{font-size:13px}.sub{display:block;font-size:12px}.img{max-width:100%;border-radius:6px}
ul{list-style:none;margin:0;padding:0}li{display:flex;gap:8px;padding:3px 0;align-items:flex-start}
.dot{flex:none;width:14px;height:14px;margin-top:3px;border-radius:50%;border:1.5px solid var(--muted);box-sizing:border-box}
.current .dot{border-color:var(--accent);border-width:4px}.done .dot{background:var(--ok);border-color:var(--ok)}.failed .dot{border-color:var(--danger)}
.done>span,.upcoming .sub{color:var(--muted)}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.pill.success{color:var(--ok);border-color:var(--ok)}.pill.info,.pill.pending{color:var(--accent);border-color:var(--accent)}.pill.warning{color:var(--warn);border-color:var(--warn)}.pill.danger{color:var(--danger);border-color:var(--danger)}
.struck{text-decoration:line-through;opacity:.7}.kv-row{display:flex;gap:8px}.kv-row>span:first-child{min-width:90px}
.bar{height:6px;border-radius:3px;background:var(--line);margin-top:4px}.fill{height:6px;border-radius:3px;background:var(--accent)}
.code pre{margin:0;padding:8px;border:1px solid var(--line);border-radius:6px;overflow:auto;font-size:12px}
.btn{align-self:flex-start;font:inherit;font-size:13px;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}.btn.borderless{border-color:transparent;color:var(--accent);padding:4px 0}.btn:disabled{opacity:.5;cursor:default}
a{color:var(--accent);cursor:pointer;text-decoration:none}
</style></head><body><div id="root" class="card"><span class="muted">Waiting for Gleap…</span></div>
<script>
(function(){
var root=document.getElementById('root'),nextId=1,pending={},args=null;
${A2UI_RENDERER_JS}
function post(m){window.parent.postMessage(m,'*')}
function request(method,params){var id=nextId++;post({jsonrpc:'2.0',id:id,method:method,params:params});return new Promise(function(r){pending[id]=r})}
function notify(method,params){post({jsonrpc:'2.0',method:method,params:params||{}})}
function applyContext(ctx){if(!ctx)return;if(ctx.theme)document.documentElement.setAttribute('data-theme',ctx.theme);
var v=ctx.styles&&ctx.styles.variables;if(v)for(var k in v){if(/^--[\\w-]+$/.test(k)&&typeof v[k]==='string')document.documentElement.style.setProperty(k,v[k])}}
function openLink(url){var u=safeUrl(url);if(u)request('ui/open-link',{url:u})}
function show(surface){if(!renderSurface(surface,root,openLink)){var m=document.createElement('span');m.className='muted';m.textContent='Done.';root.appendChild(m)}}
window.addEventListener('message',function(e){var m=e.data;if(!m||m.jsonrpc!=='2.0')return;
if(m.id!=null&&pending[m.id]&&!m.method){pending[m.id](m);delete pending[m.id];return}
if(m.method==='ui/notifications/tool-input'){args=m.params&&m.params.arguments;if(args&&Array.isArray(args.items))show(planSurface(args.items,args.explanation))}
else if(m.method==='ui/notifications/tool-result'){var r=m.params||{};if(r.isError){root.textContent='';var f=document.createElement('span');f.className='muted';f.textContent=(r.content&&r.content[0]&&r.content[0].text)||'Failed.';root.appendChild(f)}else show(r.structuredContent&&r.structuredContent.a2ui)}
else if(m.method==='ui/notifications/host-context-changed'){applyContext(m.params)}
else if(m.method==='ui/resource-teardown'&&m.id!=null){post({jsonrpc:'2.0',id:m.id,result:{}})}});
if(window.ResizeObserver)new ResizeObserver(function(){var r=root.getBoundingClientRect();notify('ui/notifications/size-changed',{width:Math.ceil(r.width),height:Math.ceil(r.height)})}).observe(root);
request('ui/initialize',{protocolVersion:'2026-01-26',appCapabilities:{availableDisplayModes:['inline']},clientInfo:{name:'gleap-kai-session',version:'1.0.0'},appInfo:{name:'gleap-kai-session',version:'1.0.0'}})
.then(function(res){applyContext(res&&res.result&&res.result.hostContext);notify('ui/notifications/initialized',{})});
})();
</script></body></html>`;

export const kaiSessionViewHtml = (): string => VIEW_HTML;

/** Register the `ui://gleap/kai-session` resource. */
export const registerKaiSessionView = (server: McpServer): void => {
  server.registerResource(
    "kai-session",
    KAI_SESSION_UI_URI,
    {
      title: "Gleap coding session",
      description: "Inline view for the Gleap session tools: plan, wrap-up, shared screenshots and published pages.",
      mimeType: MCP_APP_MIME_TYPE,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MCP_APP_MIME_TYPE,
          text: VIEW_HTML,
          _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
        },
      ],
    }),
  );
};

/**
 * Add `_meta.ui.resourceUri` to the linked tools in `tools/list`. MCP SDK 1.17
 * has no `_meta` on registerTool, so the list handler is wrapped. Call AFTER
 * every tool is registered (the SDK installs the handler on the first
 * registerTool). Existing `_meta` (if a later SDK emits one) is kept.
 */
export const linkToolsToKaiSessionView = (server: McpServer, names: Set<string> = KAI_SESSION_UI_TOOLS): void => {
  const handlers = (server.server as any)?._requestHandlers as Map<string, (req: any, extra: any) => Promise<any>> | undefined;
  const inner = handlers?.get("tools/list");
  if (!handlers || !inner) return;
  handlers.set("tools/list", async (req, extra) => {
    const res = await inner(req, extra);
    for (const tool of res?.tools ?? []) {
      if (!names.has(tool.name)) continue;
      tool._meta = { ...(tool._meta ?? {}), ui: { ...(tool._meta?.ui ?? {}), resourceUri: KAI_SESSION_UI_URI } };
    }
    return res;
  });
};
