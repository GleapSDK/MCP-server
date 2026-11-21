import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * MCP Apps view for the Kai Code session tools (update_plan, wrap_up,
 * share_screenshot, publish_artifact). Hosts that support MCP Apps
 * (SEP-1865, modelcontextprotocol/ext-apps) render this page inline under the
 * tool call with the result's `structuredContent`; every other client reads
 * the text content, which always carries the full result.
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
:root{color-scheme:light dark;--bg:var(--color-background-primary,#fff);--fg:var(--color-text-primary,#18181b);--muted:var(--color-text-secondary,#71717a);--line:var(--color-border-primary,#e4e4e7);--accent:#485bff;--on-accent:#fff;--ok:#16a34a;--radius:var(--border-radius-md,10px);font-family:var(--font-sans,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:var(--color-background-primary,#18181b);--fg:var(--color-text-primary,#f4f4f5);--muted:var(--color-text-secondary,#a1a1aa);--line:var(--color-border-primary,#3f3f46);--accent:#8b98ff;--on-accent:#0b0b12}}
:root[data-theme=dark]{--bg:var(--color-background-primary,#18181b);--fg:var(--color-text-primary,#f4f4f5);--muted:var(--color-text-secondary,#a1a1aa);--line:var(--color-border-primary,#3f3f46);--accent:#8b98ff;--on-accent:#0b0b12}
html,body{margin:0;background:transparent;color:var(--fg);font-size:14px;line-height:1.45}
.card{border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;background:var(--bg)}
.head{display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:8px}
.tag{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
ul{list-style:none;margin:0;padding:0}li{display:flex;gap:8px;padding:3px 0;align-items:flex-start}
.dot{flex:none;width:14px;height:14px;margin-top:3px;border-radius:50%;border:1.5px solid var(--muted);box-sizing:border-box}
.in_progress .dot{border-color:var(--accent);border-width:4px}.completed .dot{background:var(--ok);border-color:var(--ok)}
.completed span,.cancelled span{color:var(--muted)}.cancelled span{text-decoration:line-through}
p{margin:0 0 8px}.muted{color:var(--muted)}
a{color:var(--accent);cursor:pointer;text-decoration:none}
</style></head><body><div id="root" class="card"><span class="muted">Waiting for Gleap…</span></div>
<script>
(function(){
var root=document.getElementById('root'),nextId=1,pending={},args=null;
function post(m){window.parent.postMessage(m,'*')}
function request(method,params){var id=nextId++;post({jsonrpc:'2.0',id:id,method:method,params:params});return new Promise(function(r){pending[id]=r})}
function notify(method,params){post({jsonrpc:'2.0',method:method,params:params||{}})}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e}
function applyContext(ctx){if(!ctx)return;if(ctx.theme)document.documentElement.setAttribute('data-theme',ctx.theme);
var v=ctx.styles&&ctx.styles.variables;if(v)for(var k in v){if(/^--[\\w-]+$/.test(k)&&typeof v[k]==='string')document.documentElement.style.setProperty(k,v[k])}}
function head(tag,title){var h=el('div','head');h.appendChild(el('span','tag',tag));if(title)h.appendChild(el('span',null,title));return h}
function render(d){if(!d||typeof d!=='object')return;root.textContent='';
if(d.kind==='plan'){var items=d.items||[],done=items.filter(function(i){return i.status==='completed'}).length;
root.appendChild(head('Plan',done+' of '+items.length+' done'));if(d.explanation)root.appendChild(el('p','muted',d.explanation));
var ul=el('ul');items.forEach(function(i){var li=el('li',i.status);li.appendChild(el('span','dot'));li.appendChild(el('span',null,i.content));ul.appendChild(li)});root.appendChild(ul)}
else if(d.kind==='wrap_up'){root.appendChild(head('Wrap-up'));root.appendChild(el('p',null,d.recap));if(d.ask)root.appendChild(el('p',null,d.ask)).style.fontWeight='600';
var f=root.appendChild(el('p','muted','Also shown as the next step on the Gleap session.'));f.style.marginTop='8px';
if(d.url){f.appendChild(document.createTextNode(' '));var o=el('a',null,'Open in Gleap');o.onclick=function(){request('ui/open-link',{url:d.url})};f.appendChild(o)}}
else if(d.kind==='share'){root.appendChild(head('Screenshot',d.label||''));root.appendChild(el('p',null,d.caption));
root.appendChild(el('p','muted',d.status==='shared'?'Shared with your operator in Gleap.':'Shared once the upload command ran.'))}
else if(d.kind==='artifact'){root.appendChild(head('Page',d.title));if(d.description)root.appendChild(el('p','muted',d.description));
if(d.url){var a=el('a',null,'Open in Gleap');a.onclick=function(){request('ui/open-link',{url:d.url})};root.appendChild(a)}}
else{root.appendChild(el('span','muted','Done.'))}}
window.addEventListener('message',function(e){var m=e.data;if(!m||m.jsonrpc!=='2.0')return;
if(m.id!=null&&pending[m.id]&&!m.method){pending[m.id](m);delete pending[m.id];return}
if(m.method==='ui/notifications/tool-input'){args=m.params&&m.params.arguments;if(args&&args.items)render({kind:'plan',items:args.items,explanation:args.explanation})}
else if(m.method==='ui/notifications/tool-result'){var r=m.params||{};if(r.isError){root.textContent='';root.appendChild(el('span','muted',(r.content&&r.content[0]&&r.content[0].text)||'Failed.'))}else render(r.structuredContent&&r.structuredContent.view)}
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
