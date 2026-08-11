/**
 * 会话持久化（纯前端，IndexedDB）。
 * 解决"刷新即丢 + 无历史可看"：把每个会话的对话、生成结果、版本栈、设置快照存到浏览器，
 * 刷新自动恢复上次会话，并可在历史抽屉里查看/切换/删除过往会话。
 *
 * 三个对象仓：
 *  - sessions：完整记录（含较大的 code/html），按 id 取单条
 *  - index：轻量摘要（标题/时间/消息数），列表只读它，避免把所有大 blob 载进内存
 *  - meta：键值杂项（如 lastActiveSessionId）
 * 仅在客户端调用（用到 indexedDB）。所有写操作同步维护 sessions + index。
 */
import { openDB, type IDBPDatabase } from "idb";
import type {
  ChatMessage,
  GenerationResult,
  MobilePreviewShell,
  ModelPreference,
  PreviewDeviceMode,
} from "@/lib/types";

const DB_NAME = "youdesign";
const DB_VERSION = 1;
const STORE_SESSIONS = "sessions";
const STORE_INDEX = "index";
const STORE_META = "meta";
const LAST_ACTIVE_KEY = "lastActiveSessionId";

/** 会话保留上限，超出按更新时间删最旧，防止 IndexedDB 配额膨胀 */
export const SESSION_LIMIT = 50;

/** 完整会话记录（落盘内容） */
export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  result: GenerationResult | null;
  history: GenerationResult[];
  histIdx: number;
  /** 设置快照，保证恢复后与当时一致 */
  styleProfileId: string;
  modelPreference?: ModelPreference;
  /** 快速模式（默认开）：仅首次生成生效，生成后锁定 */
  fastMode?: boolean;
  /** 预览视口偏好；仅影响本地展示，不改变原型 device 或生成结果。 */
  previewDeviceMode?: PreviewDeviceMode;
  /** 手机预览外壳；旧会话缺省为企微。 */
  mobilePreviewShell?: MobilePreviewShell;
  /** 需求卡评审侧栏是否展开；不影响原型产物。 */
  requirementCardsOpen?: boolean;
  /** 输入框历史（按发送时间正序），用于上下箭头回溯；旧会话无此字段 */
  inputHistory?: string[];
  /** 用户手动设置的标题；undefined=未手动改，回退 deriveTitle 自动推导 */
  customTitle?: string;
  /** 导出/分享时用户修改的文件名；undefined=未手动改，回退 flow.title 默认。不影响会话标题 */
  exportTitle?: string;
}

/** 列表用的轻量摘要 */
export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  hasResult: boolean;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB 不可用（非浏览器环境）"));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_INDEX)) {
          db.createObjectStore(STORE_INDEX, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }
      },
    });
  }
  return dbPromise;
}

function toSummary(rec: SessionRecord): SessionSummary {
  return {
    id: rec.id,
    title: rec.title,
    updatedAt: rec.updatedAt,
    messageCount: rec.messages.length,
    hasResult: !!rec.result,
  };
}

/** 保存（新增或覆盖）一个会话，并同步摘要索引；顺带做容量裁剪 */
export async function saveSession(rec: SessionRecord): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([STORE_SESSIONS, STORE_INDEX], "readwrite");
  await tx.objectStore(STORE_SESSIONS).put(rec);
  await tx.objectStore(STORE_INDEX).put(toSummary(rec));
  await tx.done;
  await pruneToLimit();
}

/**
 * 单独保存预览偏好，不改 updatedAt / 摘要索引，避免纯查看操作把会话重新置顶。
 * 会话尚未完成首次落盘时直接忽略；后续完整保存会带上最新偏好。
 */
export async function saveSessionPreviewSettings(
  id: string,
  settings: {
    previewDeviceMode?: PreviewDeviceMode;
    mobilePreviewShell?: MobilePreviewShell;
    requirementCardsOpen?: boolean;
  }
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORE_SESSIONS, "readwrite");
  const store = tx.objectStore(STORE_SESSIONS);
  const rec = (await store.get(id)) as SessionRecord | undefined;
  if (rec) await store.put({ ...rec, ...settings });
  await tx.done;
}

/** 读单条完整会话 */
export async function loadSession(id: string): Promise<SessionRecord | undefined> {
  const db = await getDb();
  return db.get(STORE_SESSIONS, id);
}

/** 删除一条会话（含摘要） */
export async function removeSession(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([STORE_SESSIONS, STORE_INDEX], "readwrite");
  await tx.objectStore(STORE_SESSIONS).delete(id);
  await tx.objectStore(STORE_INDEX).delete(id);
  await tx.done;
}

/** 手动重命名一条会话：仅改 title + customTitle，保留原 updatedAt 不调整列表排序。
 *  title 为空串时表示"恢复默认名称"——清掉 customTitle，用 deriveTitle 重算。 */
export async function renameSession(id: string, title: string): Promise<void> {
  const rec = await loadSession(id);
  if (!rec) return;
  if (title === "") {
    rec.title = deriveTitle(rec.messages, rec.result);
    rec.customTitle = undefined;
  } else {
    rec.title = title;
    rec.customTitle = title;
  }
  await saveSession(rec);
}

/** 列出全部会话摘要，按更新时间倒序 */
export async function listSummaries(): Promise<SessionSummary[]> {
  const db = await getDb();
  const all: SessionSummary[] = await db.getAll(STORE_INDEX);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getLastActiveId(): Promise<string | undefined> {
  const db = await getDb();
  return db.get(STORE_META, LAST_ACTIVE_KEY);
}

export async function setLastActiveId(id: string): Promise<void> {
  const db = await getDb();
  await db.put(STORE_META, id, LAST_ACTIVE_KEY);
}

/** 会话数超上限时，删除最旧的若干条 */
async function pruneToLimit(): Promise<void> {
  const db = await getDb();
  const all: SessionSummary[] = await db.getAll(STORE_INDEX);
  if (all.length <= SESSION_LIMIT) return;
  const oldest = all.sort((a, b) => a.updatedAt - b.updatedAt).slice(0, all.length - SESSION_LIMIT);
  const tx = db.transaction([STORE_SESSIONS, STORE_INDEX], "readwrite");
  for (const s of oldest) {
    await tx.objectStore(STORE_SESSIONS).delete(s.id);
    await tx.objectStore(STORE_INDEX).delete(s.id);
  }
  await tx.done;
}

/** 纯附件上传时首条 user 消息的占位正文 */
const ATTACH_ONLY_PLACEHOLDER = "(根据上传内容生成)";

/** 由首条用户消息/结果推导一个简短标题 */
export function deriveTitle(messages: ChatMessage[], result: GenerationResult | null): string {
  const firstUserMsg = messages.find((m) => m.role === "user");
  const firstUser = firstUserMsg?.content?.trim();
  if (firstUser) {
    // 去掉发送时拼接的 [附：…图…文档] 标注
    const clean = firstUser.replace(/\s*\[附：[^\]]*\]\s*$/, "").trim();
    if (clean && clean !== ATTACH_ONLY_PLACEHOLDER) {
      return clean.length > 30 ? clean.slice(0, 30) + "…" : clean;
    }
    // 纯附件上传：content 是占位符，改用附件文件名区分（全部拼接，避免同名无法区分）
    const names = firstUserMsg?.attachments?.map((a) => a.name).filter(Boolean) ?? [];
    if (names.length > 0) {
      const label = names.join("、");
      return label.length > 30 ? label.slice(0, 30) + "…" : label;
    }
  }
  if (result?.flow?.title) return result.flow.title;
  return "未命名会话";
}

/** 生成一个会话 id（优先 crypto.randomUUID，降级时间戳+随机） */
export function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
