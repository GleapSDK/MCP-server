/**
 * The A2UI 1.0 renderer of the Kai session view, as browser JavaScript inlined
 * into the page (no external loads). It defines `safeUrl(value)`,
 * `renderSurface(surface, mount, openLink)` and `planSurface(items, explanation)`.
 *
 * Contract: surface data only ever reaches the page through `textContent`,
 * `createTextNode` and the `src` of an https image; nothing is parsed as HTML.
 * Links and images are plain https URLs (`safeUrl`), and an `event` action is
 * shown disabled because this view cannot answer a surface.
 *
 * Kept as a string so the page and the tests run the same code.
 */
export const A2UI_RENDERER_JS = String.raw`
function safeUrl(v){if(typeof v!=='string'||v.length>2000)return null;var u;try{u=new URL(v)}catch(e){return null}
return u.protocol==='https:'&&!u.username&&!u.password?u.href:null}
function a2uiPointer(model,path){var parts=path.split('/'),cur=model;for(var i=0;i<parts.length;i++){if(!parts[i])continue;
var k=parts[i].replace(/~1/g,'/').replace(/~0/g,'~');if(cur==null||typeof cur!=='object'||!Object.prototype.hasOwnProperty.call(cur,k))return undefined;cur=cur[k]}return cur}
function a2uiStr(v){return typeof v==='string'?v:typeof v==='number'||typeof v==='boolean'?String(v):''}
function renderSurface(s,mount,openLink){mount.textContent='';
if(!s||typeof s!=='object'||!Array.isArray(s.components))return false;
var byId={},used={},model=s.dataModel&&typeof s.dataModel==='object'?s.dataModel:{};
s.components.forEach(function(c){if(c&&typeof c==='object'&&typeof c.id==='string')byId[c.id]=c});
function val(v){return v&&typeof v==='object'&&!Array.isArray(v)&&typeof v['@path']==='string'?a2uiPointer(model,v['@path']):v}
function text(v){return a2uiStr(val(v))}
function el(tag,cls,t){var e=document.createElement(tag);if(cls)e.className=cls;if(t!=null&&t!=='')e.textContent=t;return e}
function markdown(e,t){t.split('\n').forEach(function(line,i){if(i)e.appendChild(document.createElement('br'));
line.split('**').forEach(function(part,j){if(!part)return;if(j%2){e.appendChild(el('strong',null,part))}else{e.appendChild(document.createTextNode(part))}})});return e}
function link(label,url){var u=safeUrl(text(url));if(!u)return el('span',null,label);var a=el('a',null,label);
a.onclick=function(ev){if(ev&&ev.preventDefault)ev.preventDefault();openLink(u)};return a}
function list(v){v=val(v);return Array.isArray(v)?v:[]}
function node(id,depth){var c=byId[id];if(typeof id!=='string'||!c||used[id]||depth>32)return null;used[id]=true;return build(c,depth+1)}
function group(cls,c,depth){var e=el('div',cls);list(c.children).forEach(function(id){var n=node(id,depth);if(n)e.appendChild(n)});return e}
function button(c,depth){var b=el('button','btn'+(c.variant==='primary'?' primary':c.variant==='borderless'?' borderless':''));
var label=node(c.child,depth);if(label)b.appendChild(label);else b.textContent='Open';
var a=c.action&&typeof c.action==='object'?c.action:{},f=a.functionCall&&typeof a.functionCall==='object'?a.functionCall:null;
var u=f&&f['@call']==='openUrl'&&f.args&&typeof f.args==='object'?safeUrl(text(f.args.url)):null;
if(u){b.onclick=function(){openLink(u)}}else{b.disabled=true;if(a.event)b.title='Answer this in Gleap.'}return b}
function timeline(c){var ul=el('ul','timeline');list(c.steps).forEach(function(s){if(!s||typeof s!=='object')return;
var li=el('li',/^(done|current|upcoming|failed)$/.test(s.state)?s.state:'upcoming');li.appendChild(el('span','dot'));
var body=el('span');body.appendChild(el('span',null,text(s.label)));var sub=[text(s.detail),text(s.date)].filter(Boolean).join(' · ');
if(sub)body.appendChild(el('span','muted sub',sub));li.appendChild(body);ul.appendChild(li)});return ul}
function keyValue(c){var e=el('div','kv');list(c.items).forEach(function(i){if(!i||typeof i!=='object')return;var r=el('div','kv-row');
r.appendChild(el('span','muted',text(i.label)));r.appendChild(link(text(i.value),i.url));e.appendChild(r)});return e}
function meter(c){var used=Number(val(c.used))||0,limit=Number(val(c.limit))||0,e=el('div','meter');
e.appendChild(el('div',null,text(c.label)+' '+used+' / '+limit+(c.unit?' '+text(c.unit):'')));var bar=el('div','bar'),fill=el('div','fill');
fill.style.width=(limit>0?Math.min(100,Math.round(used/limit*100)):0)+'%';bar.appendChild(fill);e.appendChild(bar);return e}
function progress(c){var steps=list(c.steps).map(text),cur=Number(val(c.current))||0,e=el('div','progress');
e.appendChild(el('span','muted','Step '+Math.min(cur+1,steps.length)+' of '+steps.length));if(steps[cur])e.appendChild(el('span',null,' '+steps[cur]));return e}
function code(c){var e=el('div','code'),t=text(c.code);e.appendChild(el('pre',null,t));var b=el('button','btn borderless',text(c.copyLabel)||'Copy');
b.onclick=function(){try{navigator.clipboard.writeText(t)}catch(err){b.disabled=true}};e.appendChild(b);return e}
function plain(c){var e=el('div');['title','label','text','value','description','detail','caption'].forEach(function(k){var t=text(c[k]);if(t)e.appendChild(el('div',null,t))});return e}
function build(c,depth){switch(c.component){
case 'Column':return group('col',c,depth);case 'Row':return group('row',c,depth);
case 'List':return group(c.direction==='horizontal'?'row':'col',c,depth);
case 'Card':var card=el('div','a2card'),inner=node(c.child,depth);if(inner)card.appendChild(inner);return card;
case 'Divider':return el('div','divider');case 'Icon':return null;
case 'Text':return markdown(el('div',c.variant==='caption'?'muted caption':null),text(c.text));
case 'Image':var src=safeUrl(text(c.url));if(!src)return null;var img=el('img','img');img.src=src;img.alt=text(c.description);return img;
case 'Button':return button(c,depth);
case 'GleapStatusPill':return el('span','pill '+(/^(info|success|warning|danger)$/.test(c.tone)?c.tone:'neutral'),text(c.label));
case 'GleapTimeline':return timeline(c);case 'GleapKeyValue':return keyValue(c);
case 'GleapReceipt':var r=el('div','receipt'+(val(c.struck)===true?' struck':''));r.appendChild(el('span','pill '+(/^(success|pending|danger)$/.test(c.tone)?c.tone:'neutral'),text(c.label)));
var d=text(c.detail);if(d)r.appendChild(el('span','muted',' '+d));return r;
case 'GleapMeter':return meter(c);case 'GleapProgress':return progress(c);case 'GleapCodeCopy':return code(c);
default:return plain(c)}}
var root=node('root',0);if(root)mount.appendChild(root);return !!root}
var PLAN_STATE={pending:'upcoming',todo:'upcoming',in_progress:'current',inprogress:'current','in-progress':'current',active:'current',completed:'done',complete:'done',done:'done',cancelled:'upcoming',canceled:'upcoming'};
function planSurface(items,explanation){items=Array.isArray(items)?items:[];
var steps=items.map(function(i){var st=String(i&&i.status||'').toLowerCase(),c=st==='cancelled'||st==='canceled';
return {label:String(i&&i.content||''),state:PLAN_STATE[st]||'upcoming',detail:c?'Cancelled':undefined}});
var done=steps.filter(function(s){return s.state==='done'}).length;
var comps=[{id:'root',component:'Column',children:['head'].concat(explanation?['why']:[]).concat(['steps'])},
{id:'head',component:'Row',children:['title','count']},{id:'title',component:'Text',text:'**Plan**'},
{id:'count',component:'Text',variant:'caption',text:done+' of '+steps.length+' done'},{id:'steps',component:'GleapTimeline',steps:steps}];
if(explanation)comps.push({id:'why',component:'Text',variant:'caption',text:String(explanation)});
return {v:'1.0',surfaceId:'kaicode:pending:plan',catalogId:'https://gleap.io/a2ui/catalog/v1.json',components:comps,dataModel:{}}}
`;
