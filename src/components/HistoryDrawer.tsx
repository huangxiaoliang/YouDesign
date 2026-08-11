"use client";

import { useState } from "react";
import type { SessionSummary } from "@/lib/store/sessions";

/** 把时间戳格式化成"今天 14:30 / 昨天 / 6-29"这种简短相对时间 */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  if (sameDay) return `今天 ${hh}:${mm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hh}:${mm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}-${d.getDate()} ${hh}:${mm}`;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

interface Props {
  open: boolean;
  variant?: "drawer" | "panel";
  summaries: SessionSummary[];
  currentId: string;
  onClose: () => void;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

export function HistoryDrawer({ open, variant = "drawer", summaries, currentId, onClose, onSwitch, onNew, onDelete, onRename }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  if (!open) return null;

  function startEdit(id: string, title: string) {
    setEditingId(id);
    setEditValue(title);
  }
  // 提交改名：空值→恢复默认名；未变则取消；同名提交幂等，onBlur 与 Enter 可能双触发但无害
  function commitRename(id: string, currentTitle: string) {
    const t = editValue.trim();
    setEditingId(null);
    if (t && t !== currentTitle) {
      onRename(id, t);
    } else if (!t) {
      onRename(id, "");
    }
  }
  function cancelRename() {
    setEditingId(null);
  }
  // 关闭/切换前清掉编辑态，避免残留
  const close = () => {
    setEditingId(null);
    onClose();
  };
  const switchTo = (id: string) => {
    setEditingId(null);
    onSwitch(id);
  };

  const content = (
    <aside className={variant === "panel" ? "hist-drawer hist-panel" : "hist-drawer"} onClick={(e) => e.stopPropagation()}>
      <div className="hist-head">
        <span className="hist-title">历史会话</span>
        {variant === "drawer" && (
          <button className="hist-close" onClick={close} title="关闭">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="3" y1="3" x2="11" y2="11" />
              <line x1="11" y1="3" x2="3" y2="11" />
            </svg>
          </button>
        )}
      </div>
      <button className="hist-new" onClick={onNew}>
        ＋ 新会话
      </button>
      <div className="hist-list">
        {summaries.length === 0 && <div className="hist-empty">还没有历史会话</div>}
        {summaries.map((s) => {
          const editing = editingId === s.id;
          return (
            <div
              key={s.id}
              className={`hist-item${s.id === currentId ? " active" : ""}`}
              onClick={() => switchTo(s.id)}
            >
              <div className="hist-item-main">
                {editing ? (
                  <input
                    className="hist-item-edit"
                    value={editValue}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditValue(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => commitRename(s.id, s.title)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename(s.id, s.title);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                  />
                ) : (
                  <div className="hist-item-title">{s.title}</div>
                )}
                <div className="hist-item-meta">
                  {fmtTime(s.updatedAt)} · {s.messageCount} 条{s.hasResult ? " · 有原型" : ""}
                </div>
              </div>
              {!editing && (
                <div className="hist-actions">
                  <button
                    className="hist-rename"
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation();
                      startEdit(s.id, s.title);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 2l2 2-7 7H3v-2L10 2z"/>
                  </svg>
                  </button>
                  <button
                    className="hist-del"
                    title="删除此会话"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`删除会话「${s.title}」？此操作不可恢复。`)) onDelete(s.id);
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
  if (variant === "panel") return content;
  return (
    <div className="hist-overlay" onClick={close}>
      {content}
    </div>
  );
}
