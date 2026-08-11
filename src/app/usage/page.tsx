"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { withBase } from "@/lib/basePath";
import { useTheme } from "@/lib/theme/ThemeContext";

interface Totals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}
interface UserAgg {
  userId: string;
  name: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
}
interface ModelAgg {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}
interface DayAgg {
  day: string;
  calls: number;
  cost: number;
}
interface UsageData {
  totals: Totals;
  byUser: UserAgg[];
  byModel: ModelAgg[];
  byDay: DayAgg[];
}

const fmt = (n: number) => n.toLocaleString("zh-CN");
const fmtCost = (n: number) => `¥${n.toFixed(4)}`;

export default function UsagePage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [err, setErr] = useState("");
  const { theme } = useTheme();
  const isDark = theme.id === "yemu";

  useEffect(() => {
    fetch(withBase("/api/usage"))
      .then(async (r) => {
        if (!r.ok) {
          setErr(r.status === 401 ? "未登录" : "加载失败");
          return null;
        }
        return r.json();
      })
      .then((d) => d && setData(d))
      .catch(() => setErr("网络错误"));
  }, []);

  const textColor = isDark ? "#e5e5e5" : "#111";
  const mutedColor = isDark ? "#8b8b8b" : "#888";
  const bgColor = isDark ? "#0a0a0a" : "#fff";
  const borderColor = isDark ? "#2e2e2e" : "#e5e6eb";

  if (err) {
    return (
      <div style={{ padding: 24, color: textColor, background: bgColor, minHeight: "100vh" }}>
        {err}。请先 <a href={withBase("/login")} style={{ color: isDark ? "#64CEFB" : "#1e40af" }}>登录</a>。
      </div>
    );
  }
  if (!data) return <div style={{ padding: 24, color: textColor, background: bgColor, minHeight: "100vh" }}>加载中…</div>;

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif", color: textColor, background: bgColor, minHeight: "100vh" }}>
      <h2 style={{ marginBottom: 8 }}>用量与费用</h2>
      <p style={{ color: mutedColor, fontSize: 13, marginBottom: 24 }}>
        按公开刊例价估算（可在 data/prices.json 覆盖）；仅含 LLM chat 调用，不含 embedding。
      </p>

      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <Stat label="总调用" value={fmt(data.totals.calls)} />
        <Stat label="输入 token" value={fmt(data.totals.inputTokens)} />
        <Stat label="输出 token" value={fmt(data.totals.outputTokens)} />
        <Stat label="总费用" value={fmtCost(data.totals.cost)} />
      </div>

      <h3>按用户</h3>
      <Table headers={["用户", "调用", "输入", "输出", "缓存读", "费用"]} borderColor={borderColor}>
        {data.byUser.map((u) => (
          <tr key={u.userId}>
            <td>{u.name}</td>
            <td>{fmt(u.calls)}</td>
            <td>{fmt(u.inputTokens)}</td>
            <td>{fmt(u.outputTokens)}</td>
            <td>{fmt(u.cacheReadTokens)}</td>
            <td>{fmtCost(u.cost)}</td>
          </tr>
        ))}
      </Table>

      <h3>按模型</h3>
      <Table headers={["模型", "调用", "输入", "输出", "费用"]} borderColor={borderColor}>
        {data.byModel.map((m) => (
          <tr key={m.model}>
            <td>{m.model}</td>
            <td>{fmt(m.calls)}</td>
            <td>{fmt(m.inputTokens)}</td>
            <td>{fmt(m.outputTokens)}</td>
            <td>{fmtCost(m.cost)}</td>
          </tr>
        ))}
      </Table>

      <h3>按天</h3>
      <Table headers={["日期", "调用", "费用"]} borderColor={borderColor}>
        {data.byDay.map((d) => (
          <tr key={d.day}>
            <td>{d.day}</td>
            <td>{fmt(d.calls)}</td>
            <td>{fmtCost(d.cost)}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#f5f6f8", borderRadius: 8, padding: "12px 16px", minWidth: 120 }}>
      <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4, color: "#222" }}>{value}</div>
    </div>
  );
}

function Table({ headers, children, borderColor }: { headers: string[]; children: ReactNode; borderColor: string }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 24 }}>
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h} style={{ textAlign: "left", padding: "8px", borderBottom: `2px solid ${borderColor}` }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
