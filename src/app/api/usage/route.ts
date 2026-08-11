import { NextResponse } from "next/server";
import { readUsageSummary } from "@/lib/meter/store";
import { listUsers } from "@/lib/auth/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/usage —— 只读聚合用量（按人/模型/天）。登录即可见。 */
export async function GET() {
  try {
    const summary = await readUsageSummary();
    const users = new Map(listUsers().map((u) => [u.id, u.name]));
    const nameOf = (id: string) => users.get(id) ?? (id === "default" ? "默认(共享口令)" : id);
    return NextResponse.json({
      ...summary,
      byUser: summary.byUser.map((u) => ({ ...u, name: nameOf(u.userId) })),
    });
  } catch (err) {
    console.error("[usage] query failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "用量数据暂时不可用" }, { status: 503 });
  }
}
