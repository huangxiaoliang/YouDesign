import type { RequirementCard, RequirementCardSet } from "@/lib/types";
import { marked } from "marked";
import type { ElementHook } from "dompurify";

/** artifact-only done（内容未变、仅回吐原页/空改兜底）时携带卡集：仅推进 artifactVersion，
 *  不重置 reviewStatus、不失效 link（DOM 未变，锚点仍有效），也不进入 inherited 待复核态。
 *  与 inheritRequirementCardSet（原型真更新后用）区分：这里原型没变，卡集无需重审。 */
export function carryOverRequirementCardSet(
  set: RequirementCardSet | undefined,
  artifactVersion: number
): RequirementCardSet | undefined {
  if (!set) return undefined;
  if (set.artifactVersion === artifactVersion) return set;
  const now = Date.now();
  return {
    ...set,
    artifactVersion,
    updatedAt: now,
    cards: set.cards.map((card) => ({
      ...card,
      links: card.links?.map((link) => ({ ...link, artifactVersion })),
    })),
  };
}

/** 原型更新后，保留原卡但显式进入待复核状态，失效 DOM 定位一律作废。
 *  preserveReviewStatus=true 时保留用户的 reviewStatus（用于直接改文案等轻量改动：
 *  DOM 可能变所以 anchor 仍失效，但卡片是否评审通过是用户判断，不该被一并重置）。 */
export function inheritRequirementCardSet(
  set: RequirementCardSet | undefined,
  artifactVersion: number,
  options?: { preserveReviewStatus?: boolean }
): RequirementCardSet | undefined {
  if (!set) return undefined;
  const now = Date.now();
  const preserveReview = options?.preserveReviewStatus;
  return {
    ...set,
    artifactVersion,
    basedOnArtifactVersion: set.artifactVersion,
    status: "inherited",
    updatedAt: now,
    cards: set.cards.map((card) => ({
      ...card,
      reviewStatus: preserveReview
        ? card.reviewStatus
        : card.reviewStatus === "obsolete" ? "obsolete" : "pending",
      links: card.links?.map((link) => ({
        ...link,
        artifactVersion,
        anchor: { ...link.anchor, valid: false },
      })),
    })),
  };
}

export function createManualRequirementCard(input: {
  artifactVersion: number;
  card: Omit<RequirementCard, "id" | "reviewStatus">;
  existing?: RequirementCardSet;
}): RequirementCardSet {
  const now = Date.now();
  const cards = input.existing?.cards ?? [];
  // 单调计数：优先用 set.nextManualSeq；旧会话无该字段时从现有 BR-xx 兜底推断，删除后不复用旧编号。
  const fallbackMax = cards.reduce((max, card) => {
    const match = /^BR-(\d+)$/.exec(card.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  const seq = Math.max(input.existing?.nextManualSeq ?? 0, fallbackMax) + 1;
  const card: RequirementCard = {
    ...input.card,
    id: `BR-${String(seq).padStart(2, "0")}`,
    reviewStatus: "pending",
  };
  return input.existing
    ? { ...input.existing, cards: [...cards, card], nextManualSeq: seq, updatedAt: now }
    : { version: 1, artifactVersion: input.artifactVersion, status: "ready", generatedAt: now, updatedAt: now, nextManualSeq: seq, cards: [card] };
}

export function exportRequirementCardsMarkdown(set: RequirementCardSet, title: string): string {
  const statusLabel = { pending: "待复核", confirmed: "已确认", question: "存疑", obsolete: "作废" } as const;
  return [
    `# ${title} - 需求评审`,
    "",
    `原型版本：V${set.artifactVersion}${set.status === "inherited" ? `（继承自 V${set.basedOnArtifactVersion}，待复核）` : ""}`,
    "",
    ...set.cards.map((card) => [
      `## ${card.id} ${card.title}`,
      `- 优先级：${card.priority}`,
      `- 状态：${statusLabel[card.reviewStatus]}`,
      "",
      "**说明：**",
      "",
      // 说明原样成块输出（不再做 `\n`→`  \n` 的无差别替换，避免污染围栏代码块内容；行首缩进/列表/代码块等结构在导出 .md 里正常渲染）
      card.description,
      ...(card.links?.length
        ? ["", "- 关联区块：", ...card.links.map((link) => `  - ${link.label}${link.anchor.valid ? "" : "（待复核）"}`)]
        : []),
      "",
    ].join("\n")),
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
}

/** 生成附带需求卡的 HTML 片段（追加到导出/分享的原型 HTML 末尾）：
 *  - marker(需数字) 定位到各 link 对应的 DOM 元素（脚本用 selector/domPath/text 定位，带重试以兼容 DPL 异步渲染）
 *  - hover marker 或卡 → 画贝塞尔连线（失效 link 虚线），与 app 一致
 *  - 需求卡面板：默认右侧展开、可自由拖动、可整体收起为小条不挡页面
 *  卡内容逐字段转义防 XSS/破页；JSON 数据里 < 转义防 </script> 注入。 */
export async function buildRequirementCardsSectionHtml(set: RequirementCardSet): Promise<string> {
  // dompurify 依赖 window，dynamic import 仅在浏览器端（导出时）加载，SSR 安全
  const DOMPurify = (await import("dompurify")).default;
  const statusLabel = { pending: "待复核", confirmed: "已确认", question: "存疑", obsolete: "作废" } as const;
  // 链接统一新标签打开 + 防回退引用；导出后移除钩子避免在共享 DOMPurify 实例上累积。
  const linkHook: ElementHook = (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  };
  DOMPurify.addHook("afterSanitizeAttributes", linkHook);
  const cardsHtml = set.cards.map((card) => {
    const links = (card.links ?? []).map((l) => `<li>${escapeHtml(l.label)}${l.anchor.valid ? "" : "（待复核）"}</li>`).join("");
    // description 按 Markdown 渲染（marked 转 HTML + DOMPurify 防 XSS）；禁用 <img>（纯文本需求说明，防破图/追踪像素）
    const descHtml = DOMPurify.sanitize(marked.parse(card.description || "", { breaks: true, gfm: true }) as string, { FORBID_TAGS: ["img"] });
    return `<div class="yd-card" data-yd-card-id="${escapeHtml(card.id)}">
  <div class="yd-card-meta"><span>${escapeHtml(card.id)}</span><span class="yd-rc-prio ${card.priority.toLowerCase()}">${card.priority}</span><span>${statusLabel[card.reviewStatus]}</span></div>
  <h4>${escapeHtml(card.title)}</h4>
  <div class="yd-card-desc">${descHtml}</div>
  ${links ? `<div class="yd-rc-links">关联区块：<ul>${links}</ul></div>` : ""}
</div>`;
  }).join("");
  DOMPurify.removeHook("afterSanitizeAttributes", linkHook);
  const linkData = set.cards.flatMap((card) =>
    (card.links ?? []).map((l) => ({
      cardId: card.id,
      linkId: l.id,
      label: l.label,
      valid: l.anchor.valid,
      selector: l.anchor.selector,
      domPath: l.anchor.domPath,
      text: l.anchor.text,
      role: l.anchor.role,
    }))
  );
  const dataJson = JSON.stringify(linkData).replace(/</g, "\\u003c");
  return `<style>
.yd-panel{position:fixed;right:12px;top:2.5vh;width:320px;max-width:92vw;height:95vh;background:#fff;border:1px solid #e5e6eb;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.14);z-index:99999;font-family:-apple-system,"PingFang SC",sans-serif;font-size:12.5px;color:#1f2329;display:flex;flex-direction:column}
.yd-panel-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:9px 10px;border-bottom:1px solid #e5e6eb;background:#fafbfc;border-radius:8px 8px 0 0;cursor:move;user-select:none}
.yd-panel-head .yd-head-title{display:inline-flex;align-items:center;gap:6px}
.yd-panel-head .yd-drag-hint{color:#86909c;font-size:11px;letter-spacing:1px;pointer-events:none;white-space:nowrap}
.yd-panel.collapsed .yd-drag-hint{display:none}
.yd-panel-head strong{font-size:13px}
.yd-panel-head .yd-count{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#e6fffb;color:#006d75;font-size:11px;line-height:18px;text-align:center}
.yd-panel-head .yd-toggle{border:0;background:transparent;color:#86909c;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:4px}
.yd-panel-head .yd-toggle:hover{background:#eef0f3;color:#1f2329}
.yd-panel-body{overflow:auto;padding:10px 12px}
.yd-panel.collapsed{width:auto;height:auto;max-height:none}
.yd-panel.collapsed .yd-panel-body{display:none}
.yd-card{margin-bottom:10px;padding:10px;border:1px solid #e5e6eb;border-radius:6px;background:#fff}
.yd-card.hover{border-color:#13a8a8;box-shadow:0 0 0 2px rgba(19,168,168,.12)}
.yd-card-meta{display:flex;gap:6px;font-size:11px;color:#86909c;margin-bottom:6px}
.yd-card-meta span{padding:1px 5px;border-radius:3px;background:#f2f3f5}
.yd-rc-prio.p0{background:#fff1f0;color:#cf1322}
.yd-rc-prio.p1{background:#fff7e6;color:#ad6800}
.yd-rc-prio.p2{background:#e6fffb;color:#006d75}
.yd-card h4{margin:4px 0;font-size:13px;line-height:1.45}
.yd-rc-scope{color:#13a8a8;font-size:11.5px;margin-bottom:4px}
.yd-card-desc{margin:4px 0;color:#4e5969;line-height:1.55;font-size:12.5px}
.yd-card-desc p{margin:4px 0;white-space:pre-wrap;word-break:break-word}
.yd-card-desc ul,.yd-card-desc ol{margin:4px 0;padding-left:20px}
.yd-card-desc li{margin:2px 0}
.yd-card-desc code{background:#f2f3f5;padding:1px 4px;border-radius:3px;font-size:12px}
.yd-card-desc strong{font-weight:600}
.yd-card-desc h1,.yd-card-desc h2,.yd-card-desc h3,.yd-card-desc h4,.yd-card-desc h5,.yd-card-desc h6{margin:6px 0 4px;font-size:13px;font-weight:600}
.yd-card-desc a{color:#1677ff;text-decoration:none;word-break:break-all}
.yd-card-desc a:hover{text-decoration:underline}
.yd-card-desc del{color:#86909c}
.yd-card-desc blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid #e5e6eb;color:#86909c}
.yd-card-desc table{border-collapse:collapse;margin:4px 0;font-size:12px}
.yd-card-desc th,.yd-card-desc td{border:1px solid #e5e6eb;padding:3px 6px}
.yd-card-desc input[type=checkbox]{margin-right:4px}
.yd-rc-acc,.yd-rc-links ul{margin:4px 0;padding-left:16px;color:#86909c;line-height:1.55}
.yd-rc-links{margin-top:6px;font-size:11.5px;color:#86909c}
.yd-marker{position:fixed;width:30px;height:30px;border:3px solid #1677ff;border-radius:50%;background:#eaf2ff;color:#1677ff;font-size:15px;font-weight:700;line-height:24px;text-align:center;z-index:99998;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.15)}
.yd-marker.invalid{border-style:dashed;border-color:#ad6800;background:#fff7e6;color:#ad6800}
.yd-marker.hover{box-shadow:0 0 0 3px rgba(22,119,255,.2),0 2px 6px rgba(0,0,0,.15)}
.yd-svg{position:fixed;inset:0;width:100%;height:100%;z-index:99997;pointer-events:none;overflow:visible}
.yd-line{fill:none;stroke:#1677ff;stroke-width:1;stroke-dasharray:3 2;opacity:.65}
.yd-line.invalid{stroke:#ad6800}
.yd-line.hover{stroke-width:2;stroke-dasharray:none;opacity:1}
</style>
<div class="yd-panel" id="yd-panel">
  <div class="yd-panel-head"><div class="yd-head-title"><strong>需求评审</strong><span class="yd-count">${set.cards.length}</span></div><span class="yd-drag-hint" aria-hidden="true">可拖动</span><button type="button" class="yd-toggle" title="收起/展开">收起</button></div>
  <div class="yd-panel-body">${cardsHtml}</div>
</div>
<div id="yd-marker-layer"></div>
<svg class="yd-svg" aria-hidden="true"><g id="yd-lines"></g></svg>
<script type="application/json" id="yd-data">${dataJson}</script>
<script>(function(){
  var data;
  try{ data=JSON.parse(document.getElementById('yd-data').textContent||'[]'); }catch(e){ data=[]; }
  var panel=document.getElementById('yd-panel');
  if(!panel) return;
  var head=panel.querySelector('.yd-panel-head');
  var toggleBtn=panel.querySelector('.yd-toggle');
  var lineG=document.getElementById('yd-lines');
  var layer=document.getElementById('yd-marker-layer');
  var markers={};
  var curHoverMarkerKey=null, curHoverCardId=null, hoverTimer;
  function locate(link){
    var el=null, sels=[link.selector,link.domPath].filter(Boolean);
    for(var i=0;i<sels.length;i++){ try{ var f=document.querySelector(sels[i]); if(f){ el=f; break; } }catch(e){} }
    if(!el&&link.text){
      var targetRole=link.role;
      var roleOf=function(n){ return n.getAttribute('role')||n.tagName.toLowerCase(); };
      var all=document.body?document.body.querySelectorAll('button,a,input,textarea,select,label,th,td,h1,h2,h3,p,span,div'):[];
      var t=String(link.text).replace(/\\s+/g,' ').trim();
      var exact=[], partial=[];
      for(var j=0;j<all.length;j++){ var n=all[j]; var tx=(n.textContent||'').replace(/\\s+/g,' ').trim(); if(!tx) continue; if(tx===t) exact.push(n); else if(tx.indexOf(t)>=0) partial.push(n); }
      // 收紧：anchor 记录了 role（关联时 el.getAttribute('role')||tagName）时只接受 role 匹配的候选，避免同名异类元素误命中
      var pick = targetRole ? exact.filter(function(n){return roleOf(n)===targetRole;}) : exact;
      if(!pick.length) pick = targetRole ? partial.filter(function(n){return roleOf(n)===targetRole;}) : partial;
      if(pick.length){
        pick.sort(function(a,b){ var ta=(a.textContent||'').replace(/\\s+/g,' ').trim(), tb=(b.textContent||'').replace(/\\s+/g,' ').trim(); return ta.length-tb.length || a.childElementCount-b.childElementCount; });
        el=pick[0];
      }
    }
    return el;
  }
  function buildMarkers(){
    layer.innerHTML=''; markers={};
    data.forEach(function(item){
      var el=locate(item); if(!el) return;
      var m=document.createElement('div');
      m.className='yd-marker'+(item.valid?'':' invalid');
      m.textContent=String(item.cardId).replace(/^BR-/,'')||'·';
      m.setAttribute('data-yd-key',item.cardId+'--'+item.linkId);
      m.title=item.cardId+' · '+item.label+(item.valid?'':' · 待复核');
      layer.appendChild(m);
      markers[item.cardId+'--'+item.linkId]={el:m,target:el,cardId:item.cardId,linkId:item.linkId,valid:item.valid};
    });
    bindHover();
    positionMarkers();
    drawAllLines();
  }
  // 遮挡判定：目标被同文档内更高层元素（抽屉/弹层/遮罩）盖住时不画 marker，避免 marker 压在打开的弹层上方。
  // 与 app 内 refreshRequirementLinkBoxes 的遮挡判定对称：取目标中心点 elementsFromPoint 栈，从顶往下找，
  // 跳过本脚本注入的 marker 层/面板/连线 svg（它们在目标之上但不算遮挡），第一个真实元素若不是目标自身或
  // 其子孙即视为被遮挡。仅影响渲染（marker 隐藏；连线用 marker rect，marker display:none → rect=0 → 自动不画）。
  function isCovered(target, r){
    var cx=r.left+r.width/2, cy=r.top+r.height/2;
    var stack;
    try { stack=document.elementsFromPoint(cx,cy)||[]; } catch(e){ return false; }
    for(var i=0;i<stack.length;i++){
      var e=stack[i];
      if(e===target||target.contains(e)) return false;
      if(e.closest && e.closest('#yd-marker-layer,#yd-panel,#yd-lines')) continue;
      return true;
    }
    return false;
  }
  function positionMarkers(){
    // 同一目标元素被多个 link 关联时(一标多卡)，按命中顺序横向错开 24px，
    // 避免 marker 精确重叠、顶层抢光 pointer 致底层无法悬停。与 app 内 refreshRequirementLinkBoxes 对齐。
    var seen = new Map();
    Object.keys(markers).forEach(function(k){
      var m=markers[k]; var r=m.target.getBoundingClientRect();
      if(r.width<=0||r.height<=0){ m.el.style.display='none'; return; }
      if(isCovered(m.target,r)){ m.el.style.display='none'; return; }
      m.el.style.display='';
      var idx = seen.get(m.target) || 0;
      seen.set(m.target, idx + 1);
      m.el.style.left=(r.left+Math.min(Math.max(r.width-24,0),12) + idx*24)+'px';
      m.el.style.top=(r.top+4)+'px';
    });
  }
  function highlightCard(cardId,on){
    panel.querySelectorAll('[data-yd-card-id]').forEach(function(c){
      if(on&&c.getAttribute('data-yd-card-id')===cardId) c.classList.add('hover'); else c.classList.remove('hover');
    });
  }
  // 常显所有 marker↔卡 连线（细虚线）；hover 的线加 hover class（粗实）。与 app 内一致。
  function drawAllLines(){
    lineG.innerHTML='';
    Object.keys(markers).forEach(function(k){
      var m=markers[k];
      var cardEl=panel.querySelector('[data-yd-card-id="'+m.cardId+'"]');
      if(!cardEl) return;
      var mr=m.el.getBoundingClientRect(); if(mr.width<=0) return;
      var cRect=cardEl.getBoundingClientRect(); if(cRect.width<=0) return;
      var hovered = curHoverMarkerKey===k || curHoverCardId===m.cardId;
      var fromX=mr.right, fromY=mr.top+mr.height/2;
      var toX=cRect.left, toY=cRect.top+cRect.height/2;
      var dx=Math.max(24,(toX-fromX)/2);
      var path=document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d','M '+fromX+' '+fromY+' C '+(fromX+dx)+' '+fromY+', '+(toX-dx)+' '+toY+', '+toX+' '+toY);
      path.setAttribute('class','yd-line'+(m.valid?'':' invalid')+(hovered?' hover':''));
      lineG.appendChild(path);
    });
  }
  function clearHover(){ curHoverMarkerKey=null; curHoverCardId=null; highlightCard(null,false); Object.keys(markers).forEach(function(k){ markers[k].el.classList.remove('hover'); }); drawAllLines(); }
  function bindHover(){
    Object.keys(markers).forEach(function(k){
      var m=markers[k];
      m.el.onmouseenter=function(){ clearTimeout(hoverTimer); Object.keys(markers).forEach(function(k2){ markers[k2].el.classList.remove('hover'); }); m.el.classList.add('hover'); highlightCard(m.cardId,true); curHoverMarkerKey=k; curHoverCardId=null; drawAllLines(); };
      m.el.onmouseleave=function(){ hoverTimer=setTimeout(clearHover,120); };
    });
  }
  panel.querySelectorAll('[data-yd-card-id]').forEach(function(c){
    c.onmouseenter=function(){ clearTimeout(hoverTimer); var cid=c.getAttribute('data-yd-card-id'); Object.keys(markers).forEach(function(k){ if(markers[k].cardId===cid) markers[k].el.classList.add('hover'); }); highlightCard(cid,true); curHoverCardId=cid; curHoverMarkerKey=null; drawAllLines(); };
    c.onmouseleave=function(){ hoverTimer=setTimeout(clearHover,120); };
  });
  // 拖动
  var dragging=false, ox=0, oy=0;
  head.addEventListener('mousedown',function(e){
    if(e.target===toggleBtn) return;
    dragging=true;
    var r=panel.getBoundingClientRect();
    ox=e.clientX-r.left; oy=e.clientY-r.top;
    panel.style.right='auto'; panel.style.bottom='auto';
    panel.style.left=r.left+'px'; panel.style.top=r.top+'px';
    e.preventDefault();
  });
  document.addEventListener('mousemove',function(e){
    if(!dragging) return;
    var r=panel.getBoundingClientRect();
    var x=Math.max(0,Math.min(e.clientX-ox,window.innerWidth-r.width));
    var y=Math.max(0,Math.min(e.clientY-oy,window.innerHeight-r.height));
    panel.style.left=x+'px'; panel.style.top=y+'px';
    schedule(); // 浮窗移动时 card rect 变，重算 marker 位置 + 连线（节流）
  });
  document.addEventListener('mouseup',function(){ dragging=false; schedule(); }); // 拖结束校准一次
  // 收起/展开
  toggleBtn.addEventListener('click',function(){
    var c=panel.classList.toggle('collapsed');
    toggleBtn.textContent=c?'展开':'收起';
  });
  // 滚动/resize 重定位 + 重绘当前 hover 连线
  var st;
  function schedule(){ clearTimeout(st); st=setTimeout(function(){ positionMarkers(); drawAllLines(); },80); }
  window.addEventListener('scroll',schedule,true);
  window.addEventListener('resize',schedule);
  // 抽屉/弹层常用 transform/opacity/visibility 过渡开关：class 变化瞬间 MutationObserver 触发一次刷新，
  // 但此时遮罩 overlay 的 visibility 可能还在过渡中（visible→hidden 在过渡结束才生效），遮挡判定会落空
  // （关闭抽屉时 overlay 仍可见→背景 marker 误判遮挡、不恢复）。监听 transitionend，过渡结束再刷一次。
  document.addEventListener('transitionend',schedule,true);
  // 抽屉/弹层开关不触发 scroll/resize，监听 DOM 变化刷新 marker（与 app 内 MutationObserver 对应）。
  // 过滤本脚本注入的 marker 层/面板/连线 svg 自身变化（positionMarkers 改 marker style 会触发观察者），
  // 否则 positionMarkers → marker style 变 → 观察者 → schedule → positionMarkers 形成反馈。
  if(window.MutationObserver){
    var mo=new MutationObserver(function(muts){
      for(var i=0;i<muts.length;i++){
        var t=muts[i].target;
        if(t && t.nodeType===1 && t.closest && t.closest('#yd-marker-layer,#yd-panel,#yd-lines')) continue;
        schedule();
        return;
      }
    });
    mo.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class']});
  }
  // 初始化（带重试，兼容 DPL 沙箱异步渲染）
  var tries=0;
  function init(){ buildMarkers(); var found=Object.keys(markers).length; if(found<data.length&&tries<15){ tries++; setTimeout(init,300); } }
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded',init); } else { init(); }
})();
</script>`;
}
