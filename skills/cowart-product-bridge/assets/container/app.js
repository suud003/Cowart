import {
  collectPageTransitions,
  layoutPages,
  normalizePagePosition,
  PAGE_CARD_HEIGHT,
  PAGE_CARD_WIDTH,
  routeTransition
} from './semantic-canvas-layout.js';
import {createAnnotationCoordinateMapper} from './annotation-geometry.js';

const $=(s,p=document)=>p.querySelector(s), $$=(s,p=document)=>[...p.querySelectorAll(s)];
const SVG_NS='http://www.w3.org/2000/svg',CANVAS_MIN_WIDTH=2400,CANVAS_MIN_HEIGHT=1600,CANVAS_MARGIN=160;
const state={project:null,module:0,page:0,view:'review',doc:'prd',annotations:true,adding:false,retargetId:null,activeAnnotationId:null,annotationCleanup:null,annotationReady:false,prototypeScale:1,loadToken:0,zoom:.6,prototypeHtml:'',prd:''};
const api={
  async project(){const r=await fetch('/api/project',{cache:'no-store'});if(!r.ok)throw Error(await r.text());return r.json()},
  async saveProject(){saveLabel('保存中…');const r=await fetch('/api/project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(state.project)});if(!r.ok)throw Error(await r.text());saveLabel('已保存 interaction-prd.json')},
  async file(path){const r=await fetch('/api/file?path='+encodeURIComponent(path),{cache:'no-store'});if(!r.ok)throw Error(await r.text());return r.text()},
  async files(){const r=await fetch('/api/files');return (await r.json()).files},
  async saveFile(path,content){const r=await fetch('/api/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path,content})});if(!r.ok)throw Error(await r.text())}
};
function module(){return state.project.modules[state.module]} function page(){return module().pages[state.page]}
function saveLabel(t){$('#saveState').textContent=t} function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),1800)}
function esc(s=''){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function markdown(md=''){
  let inCode=false,inList=false,out=[];
  for(const raw of md.split(/\r?\n/)){const line=raw;
    if(line.startsWith('```')){if(inList){out.push('</ul>');inList=false}out.push(inCode?'</code></pre>':'<pre><code>');inCode=!inCode;continue}
    if(inCode){out.push(esc(line)+'\n');continue}
    const h=line.match(/^(#{1,4})\s+(.*)$/);if(h){if(inList){out.push('</ul>');inList=false}const n=h[1].length;out.push(`<h${n}>${inline(h[2])}</h${n}>`);continue}
    const li=line.match(/^\s*[-*]\s+(.*)$/);if(li){if(!inList){out.push('<ul>');inList=true}out.push('<li>'+inline(li[1])+'</li>');continue}
    if(inList){out.push('</ul>');inList=false}
    if(/^>\s?/.test(line))out.push('<blockquote>'+inline(line.replace(/^>\s?/,''))+'</blockquote>');else if(line.trim())out.push('<p>'+inline(line)+'</p>')
  }if(inList)out.push('</ul>');return out.join('')
}
function inline(s){return esc(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')}
async function loadCurrent(){const token=++state.loadToken,p=page(),m=module(),[prototypeHtml,prd]=await Promise.all([api.file(p.prototypePath),api.file(m.prdPath)]);if(token!==state.loadToken)return false;state.prototypeHtml=prototypeHtml;state.prd=prd;renderReview();return true}
function renderRail(){const root=$('#railItems');root.innerHTML='';state.project.modules.forEach((m,i)=>{const b=document.createElement('button');b.textContent=String(i+1).padStart(2,'0');b.title=m.title;b.className=i===state.module?'active':'';b.onclick=async()=>{state.module=i;state.page=0;state.activeAnnotationId=null;state.retargetId=null;state.adding=false;await refresh()};root.append(b)});if(state.project.settings?.showShaping){state.project.documents.forEach(d=>{const b=document.createElement('button');b.className='docShortcut';b.textContent=d.id.slice(0,3).toUpperCase();b.title=d.title;b.onclick=()=>openSource(d.path);root.append(b)})}}
function renderHeader(){const p=state.project.product;$('#productName').textContent=p.name;$('#stage').textContent=p.stage||'SHAPING';$('#toggleShaping').textContent=state.project.settings?.showShaping?'隐藏过程文档':'显示过程文档';renderRail();const sel=$('#pageSelect');sel.innerHTML=module().pages.map((p,i)=>`<option value="${i}">${esc(p.title)}</option>`).join('');sel.value=state.page}
function fitFrame(){const p=page(),stage=$('.prototypeStage'),available=Math.max(400,stage.clientWidth-88),scale=Math.min(1,available/p.viewport.width);state.prototypeScale=scale;const frame=$('#prototypeFrame');frame.style.width=p.viewport.width+'px';frame.style.height=p.viewport.height+'px';frame.style.transform=`scale(${scale})`;frame.style.marginBottom=-(p.viewport.height*(1-scale))+'px';$('#viewportLabel').textContent=`DESKTOP / ${p.viewport.width} × ${p.viewport.height}`;requestAnimationFrame(updateAnnotationPositions)}
function renderReview(){const p=page(),frame=$('#prototype');state.annotationCleanup?.();state.annotationCleanup=null;state.annotationReady=false;frame.onload=bindAnnotationTracking;frame.srcdoc=state.prototypeHtml;fitFrame();renderAnnotations();renderDoc()}

function frameDocument(){try{return $('#prototype').contentDocument}catch{return null}}
function cssEscape(value){return window.CSS?.escape?CSS.escape(String(value)):String(value).replace(/[^a-zA-Z0-9_-]/g,c=>`\\${c}`)}
function stableSelector(doc,element){
  const nodes=[];for(let node=element;node&&node!==doc.body;node=node.parentElement)nodes.push(node);
  for(const node of nodes){
    if(node.dataset?.annotationAnchor){const key=node.dataset.annotationAnchor,selector=`[data-annotation-anchor="${cssEscape(key)}"]`;try{if(doc.querySelectorAll(selector).length===1)return {selector,strategy:'semantic',anchorKey:key}}catch{}}
  }
  for(const node of nodes){
    const candidates=[];if(node.dataset?.annotationKey)candidates.push(`[data-annotation-key="${cssEscape(node.dataset.annotationKey)}"]`);if(node.id)candidates.push(`#${cssEscape(node.id)}`);if(node.dataset?.requirement)candidates.push(`[data-requirement="${cssEscape(node.dataset.requirement)}"]`);
    for(const selector of candidates){try{if(doc.querySelectorAll(selector).length===1)return {selector,strategy:'stable'}}catch{}}
  }
  return null;
}
function annotationSelector(annotation){return annotation.anchor?.key?`[data-annotation-anchor="${cssEscape(annotation.anchor.key)}"]`:annotation.target?.selector}
function targetElement(annotation){const selector=annotationSelector(annotation),doc=frameDocument();if(!selector||!doc)return null;try{const matches=doc.querySelectorAll(selector);return matches.length===1?matches[0]:null}catch{return null}}
function annotationMapper(){const frame=$('#prototype'),layer=$('#annotationLayer');if(!frame||!layer)return null;return createAnnotationCoordinateMapper({frameRect:frame.getBoundingClientRect(),frameOffsetWidth:frame.offsetWidth,frameOffsetHeight:frame.offsetHeight,frameClientLeft:frame.clientLeft,frameClientTop:frame.clientTop,layerRect:layer.getBoundingClientRect(),layerOffsetWidth:layer.offsetWidth,layerOffsetHeight:layer.offsetHeight,layerClientLeft:layer.clientLeft,layerClientTop:layer.clientTop})}
function targetPoint(annotation){
  const frame=$('#prototype'),layer=$('#annotationLayer'),mapper=annotationMapper(),element=targetElement(annotation),target=annotation.anchor?{ratioX:annotation.anchor.point?.x,ratioY:annotation.anchor.point?.y,offsetX:annotation.anchor.offset?.x,offsetY:annotation.anchor.offset?.y}:annotation.target||{};
  if(element){
    const rect=element.getBoundingClientRect(),positions={center:[.5,.5],top:[.5,0],right:[1,.5],bottom:[.5,1],left:[0,.5],'top-left':[0,0],'top-right':[1,0],'bottom-left':[0,1],'bottom-right':[1,1]},pair=positions[target.position]||positions.center;
    const ratioX=Number.isFinite(target.ratioX)?target.ratioX:pair[0],ratioY=Number.isFinite(target.ratioY)?target.ratioY:pair[1];
    const framePoint={x:rect.left+rect.width*ratioX+(Number(target.offsetX)||0),y:rect.top+rect.height*ratioY+(Number(target.offsetY)||0)},point=mapper?.frameToLayer(framePoint)||framePoint,layerRect=mapper?.frameRectToLayer(rect)||rect;
    const style=element.ownerDocument.defaultView.getComputedStyle(element),rendered=element.getClientRects().length>0&&style.visibility!=='hidden'&&style.display!=='none';
    return {x:point.x,y:point.y,rect:layerRect,element,anchored:true,visible:rendered&&rect.bottom>=0&&rect.right>=0&&rect.top<=frame.clientHeight&&rect.left<=frame.clientWidth};
  }
  return {x:layer.clientWidth*(Number(annotation.x)||0)/100,y:layer.clientHeight*(Number(annotation.y)||0)/100,anchored:false,visible:true};
}
function updateAnnotationPositions(){
  const layer=$('#annotationLayer');if(!layer||!state.project)return;
  for(const annotation of page().annotations||[]){
    const marker=layer.querySelector(`[data-annotation-id="${cssEscape(annotation.id)}"]`);if(!marker)continue;
    const point=targetPoint(annotation),hasAnchor=Boolean(annotation.anchor||annotation.target),fallback=!point.anchored,fallbackReason=hasAnchor?'锚点未找到，正在使用坐标兜底':'仅有坐标定位，建议重新绑定语义锚点';marker.style.left=point.x+'px';marker.style.top=point.y+'px';marker.style.transform=`scale(${1/state.prototypeScale}) translate(-50%,-50%)`;marker.hidden=!state.annotationReady||!point.visible;marker.classList.toggle('fallback',fallback);marker.title=`${annotation.title} · ${annotation.requirementId||'未关联需求'}${fallback?' · '+fallbackReason:''}`;
  }
  const highlight=layer.querySelector('.annotationTarget'),active=(page().annotations||[]).find(a=>String(a.id)===String(state.activeAnnotationId));
  if(!state.annotationReady||!highlight||!active){if(highlight)highlight.hidden=true;return}
  const point=targetPoint(active);if(!point.anchored||!point.visible){highlight.hidden=true;return}
  highlight.hidden=false;highlight.style.left=point.rect.left+'px';highlight.style.top=point.rect.top+'px';highlight.style.width=point.rect.width+'px';highlight.style.height=point.rect.height+'px';
}
function bindAnnotationTracking(){
  state.annotationCleanup?.();const frame=$('#prototype'),doc=frameDocument(),win=frame.contentWindow;if(!doc||!win)return;state.annotationReady=false;$('#annotationLayer')?.classList.remove('ready');
  let raf=0,motionRaf=0,motionUntil=0,cancelled=false;const timers=[];const schedule=()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(updateAnnotationPositions)};
  const trackMotion=()=>{schedule();if(performance.now()<motionUntil)motionRaf=requestAnimationFrame(trackMotion);else motionRaf=0};
  const beginMotion=()=>{motionUntil=performance.now()+1500;if(!motionRaf)trackMotion()};
  doc.addEventListener('scroll',schedule,true);doc.addEventListener('load',schedule,true);doc.addEventListener('transitionrun',beginMotion,true);doc.addEventListener('transitionend',schedule,true);doc.addEventListener('animationstart',beginMotion,true);doc.addEventListener('animationend',schedule,true);win.addEventListener('resize',schedule);
  const resizeObserver=window.ResizeObserver?new ResizeObserver(schedule):null;resizeObserver?.observe(doc.documentElement);for(const annotation of page().annotations||[]){const element=targetElement(annotation);if(element){resizeObserver?.observe(element);if(element.parentElement)resizeObserver?.observe(element.parentElement)}}
  const mutationObserver=new MutationObserver(schedule);mutationObserver.observe(doc.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
  const reveal=()=>{if(cancelled||frameDocument()!==doc)return;state.annotationReady=true;$('#annotationLayer')?.classList.add('ready');schedule()};
  Promise.resolve(doc.fonts?.ready).catch(()=>undefined).then(()=>requestAnimationFrame(()=>requestAnimationFrame(reveal)));
  timers.push(setTimeout(schedule,120),setTimeout(schedule,500),setTimeout(schedule,1200));
  state.annotationCleanup=()=>{cancelled=true;cancelAnimationFrame(raf);cancelAnimationFrame(motionRaf);timers.forEach(clearTimeout);doc.removeEventListener('scroll',schedule,true);doc.removeEventListener('load',schedule,true);doc.removeEventListener('transitionrun',beginMotion,true);doc.removeEventListener('transitionend',schedule,true);doc.removeEventListener('animationstart',beginMotion,true);doc.removeEventListener('animationend',schedule,true);win.removeEventListener('resize',schedule);resizeObserver?.disconnect();mutationObserver.disconnect()};
}
function focusAnnotation(annotation){
  state.activeAnnotationId=annotation.id;$$('.annotationBubble',$('#annotationLayer')).forEach(marker=>marker.classList.toggle('active',String(marker.dataset.annotationId)===String(annotation.id)));const element=targetElement(annotation);element?.scrollIntoView({behavior:'smooth',block:'center',inline:'center'});updateAnnotationPositions();setTimeout(updateAnnotationPositions,350);
  state.doc='notes';syncDocTabs();renderDoc();document.querySelector(`[data-note="${annotation.id}"]`)?.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function renderAnnotations(){
  const layer=$('#annotationLayer');layer.className=[state.adding?'adding':'',state.annotationReady?'ready':''].filter(Boolean).join(' ');layer.innerHTML='';if(!state.annotations)return;
  for(const annotation of page().annotations||[]){const marker=document.createElement('button');marker.className='annotationBubble';marker.dataset.annotationId=annotation.id;marker.textContent=annotation.id;marker.classList.toggle('active',String(annotation.id)===String(state.activeAnnotationId));marker.onclick=event=>{event.stopPropagation();focusAnnotation(annotation)};layer.append(marker)}
  const highlight=document.createElement('div');highlight.className='annotationTarget';highlight.hidden=true;layer.append(highlight);updateAnnotationPositions();
}
function renderDoc(){
  const box=$('#docContent');if(state.doc==='prd'){box.innerHTML=markdown(state.prd);return}
  const notes=page().annotations||[];box.innerHTML=notes.length?`<h2>页面标注</h2>`+notes.map(a=>`<article class="note" data-note="${a.id}"><div class="noteHead"><span class="bubble">${a.id}</span><strong>${esc(a.title)}</strong><button class="retarget" data-retarget="${a.id}">重新定位</button><button class="delete" data-delete="${a.id}">删除</button></div><p>${esc(a.body)}</p><small>${esc(a.requirementId||'未关联需求')} · ${a.anchor?.key?'语义锚点 '+esc(a.anchor.key):a.target?.selector?'元素锚点 '+esc(a.target.selector):'坐标标注（建议重新定位）'}</small></article>`).join(''):'<h2>页面标注</h2><p>暂无标注。选择“添加标注”，然后点击原型中的目标元素。</p>';
  $$('[data-note]',box).forEach(card=>card.onclick=()=>{const a=notes.find(x=>String(x.id)===card.dataset.note);if(a)focusAnnotation(a)});
  $$('[data-retarget]',box).forEach(button=>button.onclick=event=>{event.stopPropagation();state.retargetId=button.dataset.retarget;state.activeAnnotationId=button.dataset.retarget;state.adding=true;renderAnnotations();toast('请点击原型中的新目标元素')});
  $$('[data-delete]',box).forEach(button=>button.onclick=async event=>{event.stopPropagation();page().annotations=page().annotations.filter(a=>String(a.id)!==button.dataset.delete);if(String(state.activeAnnotationId)===button.dataset.delete)state.activeAnnotationId=null;await api.saveProject();renderAnnotations();renderDoc()});
}
function syncDocTabs(){$$('.docTabs button').forEach(b=>b.classList.toggle('active',b.dataset.doc===state.doc))}
async function refresh(){renderHeader();await loadCurrent();if(state.view==='canvas')await renderCanvas()}
function annotationLocationFromEvent(event){
  const layer=$('#annotationLayer'),mapper=annotationMapper(),layerPoint=mapper?.screenToLayer({x:event.clientX,y:event.clientY})||{x:0,y:0},framePoint=mapper?.screenToFrame({x:event.clientX,y:event.clientY})||layerPoint,doc=frameDocument();
  const location={x:+(layerPoint.x/layer.clientWidth*100).toFixed(2),y:+(layerPoint.y/layer.clientHeight*100).toFixed(2)};
  const hit=doc?.elementFromPoint(framePoint.x,framePoint.y);if(!hit||hit===doc.body||hit===doc.documentElement)return location;
  const identified=stableSelector(doc,hit);if(!identified)return location;
  let target=hit;try{target=doc.querySelector(identified.selector)||hit}catch{}
  const rect=target.getBoundingClientRect(),ratioX=rect.width?Math.max(0,Math.min(1,(framePoint.x-rect.left)/rect.width)):.5,ratioY=rect.height?Math.max(0,Math.min(1,(framePoint.y-rect.top)/rect.height)):.5;
  if(identified.anchorKey)location.anchor={type:'element',key:identified.anchorKey,point:{x:+ratioX.toFixed(3),y:+ratioY.toFixed(3)},offset:{x:0,y:0}};
  else location.target={selector:identified.selector,ratioX:+ratioX.toFixed(3),ratioY:+ratioY.toFixed(3),strategy:identified.strategy};return location;
}
async function addAnnotation(event){
  if(!state.adding)return;const location=annotationLocationFromEvent(event);
  if(state.retargetId!==null){const annotation=(page().annotations||[]).find(a=>String(a.id)===String(state.retargetId));if(annotation){annotation.x=location.x;annotation.y=location.y;delete annotation.anchor;delete annotation.target;if(location.anchor)annotation.anchor=location.anchor;else if(location.target)annotation.target=location.target}state.retargetId=null;state.adding=false;await api.saveProject();renderAnnotations();renderDoc();toast(location.anchor||location.target?'已绑定到目标元素':'未找到稳定元素，已保存坐标兜底');return}
  const id=Math.max(0,...(page().annotations||[]).map(a=>Number(a.id)))+1,title=prompt('标注标题');if(!title){state.adding=false;renderAnnotations();return}
  const body=prompt('说明（可包含规则、状态或反馈）','')||'',requirementId=prompt('关联需求 ID（可留空）','')||'';page().annotations??=[];page().annotations.push({id,...location,title,body,requirementId});state.adding=false;state.activeAnnotationId=id;await api.saveProject();renderAnnotations();state.doc='notes';syncDocTabs();renderDoc();toast(location.anchor||location.target?'标注已绑定到目标元素':'标注已保存；建议通过“重新定位”绑定元素')
}
function download(name,content,type='text/plain'){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
async function exportModule(){const m=module();let md=state.prd+'\n\n---\n\n## 页面标注与原型\n';let html=`<!doctype html><meta charset="utf-8"><title>${esc(state.project.product.name)} · ${esc(m.title)}</title><style>body{margin:0;font-family:system-ui;background:#eee}section{margin:24px;background:white;border:1px solid #ccc}h2{padding:16px}iframe{width:100%;height:800px;border:0}</style>`;for(const p of m.pages){md+=`\n### ${p.title}\n\n- 原型：\`${p.prototypePath}\`\n`+(p.annotations||[]).map(a=>`- ${a.id}. **${a.title}** — ${a.body} (${a.requirementId||'未关联需求'})`).join('\n')+'\n';const body=await api.file(p.prototypePath);html+=`<section><h2>${esc(p.title)}</h2><iframe srcdoc="${esc(body)}"></iframe></section>`}download(`${m.id}.md`,md,'text/markdown');setTimeout(()=>download(`${m.id}-prototype.html`,html,'text/html'),150);toast('已导出 Markdown 与可交互原型')}
async function openSource(path){const dialog=$('#sourceDialog'),files=await api.files(),sel=$('#fileSelect');sel.innerHTML=files.map(f=>`<option>${esc(f)}</option>`).join('');sel.value=path||module().prdPath;$('#sourceText').value=await api.file(sel.value);dialog.showModal()}
function pagePosition(p){return normalizePagePosition(p.position)}
function pageRect(p){const position=pagePosition(p);return {...position,w:PAGE_CARD_WIDTH,h:PAGE_CARD_HEIGHT}}
function svgNode(name,attributes={},text=''){const node=document.createElementNS(SVG_NS,name);for(const [key,value] of Object.entries(attributes)){if(value!==null&&value!==undefined&&value!=='')node.setAttribute(key,String(value))}if(text)node.textContent=text;return node}
function sizeCanvasWorld(records){
  const right=Math.max(0,...records.map(p=>pagePosition(p).x+PAGE_CARD_WIDTH));
  const bottom=Math.max(0,...records.map(p=>pagePosition(p).y+PAGE_CARD_HEIGHT));
  const width=Math.max(CANVAS_MIN_WIDTH,Math.ceil(right+CANVAS_MARGIN));
  const height=Math.max(CANVAS_MIN_HEIGHT,Math.ceil(bottom+CANVAS_MARGIN));
  const world=$('#canvasWorld');world.style.width=width+'px';world.style.height=height+'px';
  const svg=$('#edges');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);return {width,height};
}
async function renderCanvas(){const pages=state.project.modules.flatMap((m,mi)=>m.pages.map((p,pi)=>({m,mi,p,pi})));const htmls=await Promise.all(pages.map(x=>api.file(x.p.prototypePath)));const cards=$('#cards');cards.innerHTML='';pages.forEach((x,i)=>{const c=document.createElement('article'),position=pagePosition(x.p);c.className='pageCard';c.dataset.page=x.p.id;c.style.left=position.x+'px';c.style.top=position.y+'px';c.innerHTML=`<header><span>${esc(x.p.title)}</span><small>${esc(x.m.title)}</small></header><div class="mini"><iframe></iframe></div>`;c.querySelector('iframe').srcdoc=htmls[i];c.ondblclick=async()=>{state.module=x.mi;state.page=x.pi;state.view='review';switchView();await refresh()};dragCard(c,x.p);cards.append(c)});drawEdges(pages);applyZoom()}
function drawEdges(pages){
  const svg=$('#edges'),records=pages.map(({p})=>p),pageMap=new Map(records.map(p=>[p.id,p]));sizeCanvasWorld(records);svg.replaceChildren();
  svg.setAttribute('role','img');svg.setAttribute('aria-labelledby','product-flow-title product-flow-desc');svg.setAttribute('focusable','false');
  svg.append(svgNode('title',{id:'product-flow-title'},'产品页面关系图'));
  const transitions=collectPageTransitions(records),descriptions=transitions.slice(0,40).map(t=>{const from=pageMap.get(t.from)?.title||t.from,to=pageMap.get(t.to)?.title||t.to,direction=t.direction==='bidirectional'?'双向连接':t.direction==='none'?'无向关联':'流向',label=t.displayLabel?`，关系为“${t.displayLabel}”`:'';return `${from}${direction}${to}${label}`});
  const overflow=transitions.length>descriptions.length?`；另有 ${transitions.length-descriptions.length} 条关系未展开描述`:'';
  svg.append(svgNode('desc',{id:'product-flow-desc'},descriptions.length?`共 ${transitions.length} 条页面关系：${descriptions.join('；')}${overflow}`:'当前没有页面关系。'));
  const defs=svgNode('defs'),marker=svgNode('marker',{id:'product-flow-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse',markerUnits:'strokeWidth'});marker.append(svgNode('path',{d:'M 0 0 L 10 5 L 0 10 z',class:'arrowMarker'}));defs.append(marker);svg.append(defs);
  for(const transition of transitions){
    const from=pageMap.get(transition.from),to=pageMap.get(transition.to);if(!from||!to)continue;
    const obstacles=records.filter(record=>record.id!==transition.from&&record.id!==transition.to).map(pageRect),route=routeTransition(pageRect(from),pageRect(to),transition,{selfLoop:transition.from===transition.to,obstacles}),path=svgNode('path',{class:`arrow arrow--${route.type}`,d:route.d,'data-relation':route.type,'data-from':transition.from,'data-to':transition.to,'data-direction':route.direction,'data-path':route.path,'data-payload':route.payload||null,'data-route':route.routeKind,'aria-hidden':'true'});path.style.markerStart=route.markerStart?'url(#product-flow-arrow)':'none';path.style.markerEnd=route.markerEnd?'url(#product-flow-arrow)':'none';svg.append(path);
    if(route.displayLabel)svg.append(svgNode('text',{class:'edgeLabel',x:route.labelPoint.x,y:route.labelPoint.y,'text-anchor':'middle','dominant-baseline':'central','aria-hidden':'true'},route.displayLabel));
  }
}
function dragCard(card,p){const head=$('header',card);head.onpointerdown=e=>{head.setPointerCapture(e.pointerId);p.position=pagePosition(p);const start={x:e.clientX,y:e.clientY,l:p.position.x,t:p.position.y};head.onpointermove=ev=>{p.position.x=Math.round(start.l+(ev.clientX-start.x)/state.zoom);p.position.y=Math.round(start.t+(ev.clientY-start.y)/state.zoom);card.style.left=p.position.x+'px';card.style.top=p.position.y+'px';drawEdges(state.project.modules.flatMap(m=>m.pages.map(p=>({m,p}))))};head.onpointerup=async()=>{head.onpointermove=null;await api.saveProject();toast('画布位置已保存')}}}
function applyZoom(){$('#canvasWorld').style.transform=`scale(${state.zoom})`;$('#zoomLabel').textContent=Math.round(state.zoom*100)+'%'}
function switchView(){$('#reviewView').hidden=state.view!=='review';$('#canvasView').hidden=state.view!=='canvas';$$('.viewTabs button').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view));if(state.view==='canvas')renderCanvas();else setTimeout(fitFrame,0)}
$('#pageSelect').onchange=async e=>{state.page=Number(e.target.value);state.activeAnnotationId=null;state.retargetId=null;state.adding=false;await loadCurrent()};$('#toggleAnnotations').onclick=()=>{state.annotations=!state.annotations;$('#toggleAnnotations').textContent=state.annotations?'隐藏标注':'显示标注';renderAnnotations()};$('#addAnnotation').onclick=()=>{state.retargetId=null;state.adding=!state.adding;renderAnnotations();toast(state.adding?'点击原型中的目标元素添加标注':'已取消添加')};$('#annotationLayer').onclick=addAnnotation;
$$('.docTabs button').forEach(b=>b.onclick=()=>{state.doc=b.dataset.doc;syncDocTabs();renderDoc()});$$('.viewTabs button').forEach(b=>b.onclick=()=>{state.view=b.dataset.view;switchView()});
$('#expandPrototype').onclick=()=>{const w=open();w.document.write(state.prototypeHtml);w.document.close()};$('#exportModule').onclick=exportModule;$('#editSource').onclick=()=>openSource(module().prdPath);
$('#toggleShaping').onclick=async()=>{state.project.settings??={};state.project.settings.showShaping=!state.project.settings.showShaping;await api.saveProject();renderHeader()};
$('#fileSelect').onchange=async e=>$('#sourceText').value=await api.file(e.target.value);$('#saveFile').onclick=async e=>{e.preventDefault();const path=$('#fileSelect').value;await api.saveFile(path,$('#sourceText').value);if(path===module().prdPath)state.prd=$('#sourceText').value;if(path===page().prototypePath)state.prototypeHtml=$('#sourceText').value;renderReview();saveLabel('已保存 '+path);toast('源文件已保存')};
$('#autoArrange').onclick=async()=>{const pages=state.project.modules.flatMap(m=>m.pages),layout=layoutPages(pages,{direction:'left-to-right',originX:80,originY:80});for(const p of pages){if(layout.positions[p.id])p.position=layout.positions[p.id]}await api.saveProject();await renderCanvas();toast('已按页面关系自动排列')};$('#zoomOut').onclick=()=>{state.zoom=Math.max(.3,state.zoom-.1);applyZoom()};$('#zoomIn').onclick=()=>{state.zoom=Math.min(1,state.zoom+.1);applyZoom()};
addEventListener('resize',()=>{if(state.view==='review'){fitFrame();updateAnnotationPositions()}});
addEventListener('message',async event=>{const message=event.data;if(!message||message.type!=='interaction-prd:navigate'||typeof message.pageId!=='string'||!state.project)return;for(let mi=0;mi<state.project.modules.length;mi++){const pi=state.project.modules[mi].pages.findIndex(p=>p.id===message.pageId);if(pi>=0){state.module=mi;state.page=pi;state.view='review';switchView();await refresh();return}}});
(async()=>{try{state.project=await api.project();renderHeader();await loadCurrent()}catch(err){document.body.innerHTML=`<pre style="padding:32px">Yogurt Product Bridge failed to load:\n${esc(String(err))}</pre>`}})();
