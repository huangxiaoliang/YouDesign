"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RequirementCard, RequirementCardLink, RequirementCardSet } from "@/lib/types";
import { createManualRequirementCard, exportRequirementCardsMarkdown } from "@/lib/requirementCardUtils";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const STATUS_LABEL = { pending: "待复核", confirmed: "已确认", question: "存疑", obsolete: "作废" } as const;
const PRIORITY_LABEL = { P0: "P0", P1: "P1", P2: "P2" } as const;

/** 外链统一新标签打开（防回退引用）；图片禁用（需求说明为纯文本，防破图/追踪像素） */
const markdownComponents: Components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  img: () => null,
};

type Filter = "all" | RequirementCard["reviewStatus"];
type ManualDraft = {
  title: string;
  priority: RequirementCard["priority"];
  description: string;
};

function downloadMarkdown(content: string, title: string) {
  const safe = (title || "需求评审").replace(/[\\/:*?"<>|]/g, "_");
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safe}-需求评审.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function emptyDraft(): ManualDraft {
  return { title: "", priority: "P1", description: "" };
}

/** 保存说明时只清尾部空白，保留行首缩进（避免破坏行首缩进代码块等 Markdown 结构） */
function trimDescriptionEnd(s: string): string {
  return s.replace(/\s+$/, "");
}

/** 需求说明 textarea 的纯文本 Markdown 快捷键：
 *  - Tab：在光标处插 2 空格缩进；Shift+Tab 删行首 2 空格反缩进
 *  - Enter：当前行是 `- x` / `* x` / `1. x` 时，新行自动续前缀（有序递增）；空列表项回车退出列表 */
function handleDescriptionKey(e: React.KeyboardEvent<HTMLTextAreaElement>, draft: ManualDraft, setDraft: (d: ManualDraft) => void) {
  const ta = e.currentTarget;
  const { selectionStart: s, selectionEnd: en, value } = ta;
  if (e.key === "Tab") {
    e.preventDefault();
    if (e.shiftKey) {
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      if (value.slice(lineStart, lineStart + 2) === "  ") {
        const next = value.slice(0, lineStart) + value.slice(lineStart + 2);
        setDraft({ ...draft, description: next });
        window.requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = Math.max(lineStart, s - 2); });
      }
    } else {
      const next = value.slice(0, s) + "  " + value.slice(en);
      setDraft({ ...draft, description: next });
      window.requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
    }
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const lineText = value.slice(lineStart, s);
    const m = lineText.match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
    if (!m) return;
    const [, indent, marker, content] = m;
    e.preventDefault();
    if (!content) {
      // 空列表项回车：清前缀退出列表
      const next = value.slice(0, lineStart) + value.slice(s);
      setDraft({ ...draft, description: next });
      window.requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = lineStart; });
      return;
    }
    let nextMarker = marker;
    if (/^\d+\.$/.test(marker)) nextMarker = (Number(marker.slice(0, -1)) + 1) + ".";
    const insert = "\n" + indent + nextMarker + " ";
    const next = value.slice(0, s) + insert + value.slice(s);
    setDraft({ ...draft, description: next });
    window.requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + insert.length; });
  }
}

function draftFromCard(card: RequirementCard): ManualDraft {
  return {
    title: card.title,
    priority: card.priority,
    description: card.description,
  };
}

function cardFromDraft(card: RequirementCard, draft: ManualDraft): RequirementCard {
  return {
    ...card,
    title: draft.title.trim(),
    priority: draft.priority,
    description: trimDescriptionEnd(draft.description),
  };
}

function CardEditor({ card, onSave, onCancel }: { card: RequirementCard; onSave: (card: RequirementCard) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(() => draftFromCard(card));
  const canSave = Boolean(draft.title.trim() && draft.description.trim());
  return <div className="requirement-card-editor">
    <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} aria-label="需求卡标题" placeholder="需求标题" />
    <select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as RequirementCard["priority"] })} aria-label="优先级">
      {(Object.keys(PRIORITY_LABEL) as RequirementCard["priority"][]).map((priority) => <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>)}
    </select>
    <textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} aria-label="需求说明" placeholder="需求说明" onKeyDown={(e) => handleDescriptionKey(e, draft, setDraft)} />
    <div className="requirement-card-editor-actions"><button type="button" onClick={onCancel}>取消</button><button type="button" className="send sm" disabled={!canSave} onClick={() => onSave(cardFromDraft(card, draft))}>保存</button></div>
  </div>;
}

export function RequirementCardsPanel({
  open,
  set,
  title,
  artifactVersion,
  loading,
  hasArtifact,
  linkingCardId,
  activeCardId,
  onClose,
  onUpdate,
  onStartLink,
  onFocusLink,
  onCardHover,
  onCardLayoutChange,
}: {
  open: boolean; set?: RequirementCardSet; title: string; artifactVersion: number; loading: boolean;
  hasArtifact: boolean;
  linkingCardId?: string | null;
  activeCardId?: string | null;
  onClose: () => void; onUpdate: (set: RequirementCardSet) => void;
  onStartLink: (cardId: string) => void;
  onFocusLink: (cardId: string, linkId: string) => void;
  onCardHover?: (cardId: string | null) => void;
  onCardLayoutChange?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ManualDraft>(() => emptyDraft());
  // 子卡上下拖动排序（任何筛选下都可拖，改 cards 数组顺序；不可见卡相对位置保持）
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<{ id: string; after: boolean } | null>(null);
  // 拖头部标题栏移动整个需求卡浮窗（浮窗盖在原型上，可自由拖动，夹在视口内）
  function onHeadMouseDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("button")) return; // 不抢关闭按钮
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const ox = e.clientX - rect.left;
    const oy = e.clientY - rect.top;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    let raf = 0;
    const onMove = (ev: MouseEvent) => {
      const r = panel.getBoundingClientRect();
      const x = Math.max(0, Math.min(ev.clientX - ox, window.innerWidth - r.width));
      const y = Math.max(0, Math.min(ev.clientY - oy, window.innerHeight - r.height));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      // 浮窗移动时卡 rect 变，rAF 节流重算连线（常显线终点跟着卡走）
      if (onCardLayoutChange) { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => onCardLayoutChange()); }
    };
    const onUp = () => {
      cancelAnimationFrame(raf);
      if (onCardLayoutChange) onCardLayoutChange(); // 拖结束再校准一次
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  }
  const cards = useMemo(() => (set?.cards ?? []).filter((card) => filter === "all" || card.reviewStatus === filter), [set, filter]);
  useEffect(() => {
    if (!open || !activeCardId) return;
    if (filter !== "all") setFilter("all");
    window.requestAnimationFrame(() => {
      listRef.current?.querySelector(`[data-req-card-id="${CSS.escape(activeCardId)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  }, [activeCardId, filter, open]);
  const prevOpenRef = useRef(open);
  useEffect(() => {
    // 关侧栏时清掉半填表单/编辑/筛选，下次打开是干净态（组件常驻、open=false 仍 mount）
    if (prevOpenRef.current && !open) {
      setAdding(false);
      setEditing(null);
      setFilter("all");
      setDraft(emptyDraft());
    }
    prevOpenRef.current = open;
  }, [open]);
  if (!open) return null;
  const buildSet = (cards: RequirementCard[]): RequirementCardSet => set
    ? { ...set, updatedAt: Date.now(), cards }
    : { version: 1, artifactVersion, status: "ready", generatedAt: Date.now(), updatedAt: Date.now(), cards };
  // 拖动排序：把 fromId 的卡移到 toId 前/后（after=true 放后面），底层 cards 数组重排
  const reorderCards = (fromId: string, toId: string, after: boolean) => {
    if (!set || fromId === toId) return;
    const next = [...set.cards];
    const fromIdx = next.findIndex((c) => c.id === fromId);
    if (fromIdx < 0) return;
    const [moved] = next.splice(fromIdx, 1);
    const toIdx = next.findIndex((c) => c.id === toId);
    if (toIdx < 0) next.push(moved);
    else next.splice(after ? toIdx + 1 : toIdx, 0, moved);
    onUpdate(buildSet(next));
  };
  const updateCard = (next: RequirementCard) => {
    if (!set) return;
    onUpdate(buildSet(set.cards.map((card) => card.id === next.id ? next : card)));
    setEditing(null);
  };
  const removeCard = (id: string) => {
    if (!set) return;
    onUpdate(buildSet(set.cards.filter((card) => card.id !== id)));
  };
  const removeLink = (card: RequirementCard, linkId: string) => {
    updateCard({ ...card, links: card.links?.filter((link) => link.id !== linkId) });
  };
  const addManual = () => {
    if (!draft.title.trim() || !draft.description.trim()) return;
    const next = createManualRequirementCard({ artifactVersion, existing: set, card: {
      title: draft.title.trim(),
      priority: draft.priority,
      description: trimDescriptionEnd(draft.description),
    } });
    onUpdate(next); setAdding(false); setDraft(emptyDraft());
  };
  const canAdd = Boolean(draft.title.trim() && draft.description.trim());
  return <aside ref={panelRef} className="requirement-cards-panel" aria-label="需求卡">
    <div className="requirement-cards-head" onMouseDown={onHeadMouseDown} title="按住拖动需求卡">
      <div><strong>需求卡</strong><span>{set?.cards.length ?? 0}</span></div>
      <span className="requirement-cards-drag-hint" aria-hidden="true">可拖动</span>
      <button type="button" className="icon-btn" aria-label="隐藏需求卡" title="隐藏需求卡" onClick={onClose}>×</button>
    </div>
    {set?.status === "inherited" && <div className="requirement-cards-inherited"><span>基于 V{set.basedOnArtifactVersion} 继承，当前版本待复核</span><button type="button" className="requirement-cards-inherited-mark" title="把本版本所有非作废卡片标记为已复核（reviewStatus 置为已确认），并隐藏此提示" onClick={() => onUpdate({
      ...set,
      status: "ready",
      updatedAt: Date.now(),
      // 与按钮文案一致：非作废卡一律置为已确认（作废卡保留作废，不复活）
      cards: set.cards.map((card) => card.reviewStatus === "obsolete" ? card : { ...card, reviewStatus: "confirmed" }),
    })}>标记已复核</button></div>}
    <div className="requirement-cards-actions">
      <button type="button" className="send sm" disabled={loading || !hasArtifact} title={hasArtifact ? undefined : "请先生成原型"} onClick={() => setAdding((value) => !value)}>{adding ? "收起" : "新增"}</button>
      <button type="button" disabled={!set || set.cards.length === 0} onClick={() => set && downloadMarkdown(exportRequirementCardsMarkdown(set, title), title)}>导出</button>
    </div>
    {adding && <div className="requirement-card-editor manual">
      <input autoFocus value={draft.title} placeholder="需求标题" onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
      <select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as RequirementCard["priority"] })} aria-label="优先级">
        {(Object.keys(PRIORITY_LABEL) as RequirementCard["priority"][]).map((priority) => <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>)}
      </select>
      <textarea value={draft.description} placeholder="需求说明" onChange={(event) => setDraft({ ...draft, description: event.target.value })} onKeyDown={(e) => handleDescriptionKey(e, draft, setDraft)} />
      <div className="requirement-card-editor-actions"><button type="button" onClick={() => setAdding(false)}>取消</button><button type="button" className="send sm" disabled={!canAdd} onClick={addManual}>添加</button></div>
    </div>}
    {(set?.cards.length ?? 0) > 0 && <div className="requirement-card-filters" role="tablist" aria-label="需求卡状态筛选">
      {(["all", "pending", "confirmed", "question", "obsolete"] as Filter[]).map((item) => <button key={item} type="button" className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "全部" : STATUS_LABEL[item]}</button>)}
    </div>}
    {!set || set.cards.length === 0 ? <div className="requirement-cards-empty">{hasArtifact ? "暂无需求卡。评审时可手动添加关键变更点和待确认问题；原型出新版本后，已有卡片会自动继承并进入待复核。" : "请先生成原型，再在此添加需求卡进行评审。"}</div> : <div className="requirement-cards-list" ref={listRef}>
      {cards.length === 0 ? <div className="requirement-cards-empty">该筛选下没有需求卡。</div> : cards.map((card) => <article
        key={card.id}
        data-req-card-id={card.id}
        className={`requirement-card${activeCardId === card.id ? " active" : ""}${draggedId === card.id ? " dragging" : ""}${dragOver?.id === card.id ? (dragOver.after ? " drag-over-after" : " drag-over-before") : ""}`}
        draggable={editing !== card.id}
        onDragStart={(e) => { setDraggedId(card.id); e.dataTransfer.effectAllowed = "move"; }}
        onDragOver={(e) => { e.preventDefault(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setDragOver({ id: card.id, after: (e.clientY - r.top) > r.height / 2 }); }}
        onDragLeave={() => { if (dragOver?.id === card.id) setDragOver(null); }}
        onDrop={(e) => { e.preventDefault(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); const after = (e.clientY - r.top) > r.height / 2; if (draggedId && draggedId !== card.id) reorderCards(draggedId, card.id, after); setDraggedId(null); setDragOver(null); }}
        onDragEnd={() => { setDraggedId(null); setDragOver(null); }}
        onMouseEnter={() => onCardHover?.(card.id)}
        onMouseLeave={() => onCardHover?.(null)}
      >
        <div className="requirement-card-meta"><span>{card.id}</span><span className={`priority ${card.priority.toLowerCase()}`}>{card.priority}</span><span>{STATUS_LABEL[card.reviewStatus]}</span></div>
        {editing === card.id ? <CardEditor card={card} onCancel={() => setEditing(null)} onSave={updateCard} /> : <>
          <h3>{card.title}</h3><div className="requirement-card-desc"><ReactMarkdown remarkPlugins={[remarkBreaks, remarkGfm]} components={markdownComponents}>{card.description}</ReactMarkdown></div>
          {Boolean(card.links?.length) && <div className="requirement-card-links">
            {card.links?.map((link: RequirementCardLink) => (
              <div key={link.id} className={`requirement-card-link${link.anchor.valid ? "" : " invalid"}`}>
                <span title={link.label}>{link.label}{link.anchor.valid ? "" : " · 待复核"}</span>
                <button type="button" onClick={() => onFocusLink(card.id, link.id)}>查看</button>
                <button type="button" onClick={() => removeLink(card, link.id)}>解绑</button>
              </div>
            ))}
          </div>}
          <div className="requirement-card-state"><span>{STATUS_LABEL[card.reviewStatus]}</span><button type="button" disabled={(!hasArtifact || loading) && linkingCardId !== card.id} title={(!hasArtifact || loading) && linkingCardId !== card.id ? "请先生成原型" : undefined} onClick={() => onStartLink(card.id)}>{linkingCardId === card.id ? "正在点选" : "关联区块"}</button><button type="button" onClick={() => updateCard({ ...card, reviewStatus: card.reviewStatus === "confirmed" ? "pending" : "confirmed" })}>{card.reviewStatus === "confirmed" ? "取消确认" : "确认"}</button><button type="button" onClick={() => updateCard({ ...card, reviewStatus: card.reviewStatus === "question" ? "pending" : "question" })}>{card.reviewStatus === "question" ? "取消存疑" : "存疑"}</button><button type="button" onClick={() => updateCard({ ...card, reviewStatus: card.reviewStatus === "obsolete" ? "pending" : "obsolete" })}>{card.reviewStatus === "obsolete" ? "恢复" : "作废"}</button><button type="button" onClick={() => setEditing(card.id)}>编辑</button><button type="button" className="danger" onClick={() => removeCard(card.id)}>删除</button></div>
        </>}
      </article>)}
    </div>}
  </aside>;
}
