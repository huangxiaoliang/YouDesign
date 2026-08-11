/**
 * 用户表（多人模式运行时只读访问）。
 * 数据文件：${config.data.dir}/users.json。写入由 scripts/user.mjs CLI 完成。
 * 无文件或无启用用户 → 回退单口令模式（登录为匿名 default 用户）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { verifyPasscode } from "./passcode";

export type UserRole = "user" | "admin";

export interface User {
  id: string;
  name: string;
  passcodeHash: string;
  enabled: boolean;
  role: UserRole;
  createdAt: string;
}

function usersFile(): string {
  return path.resolve(process.cwd(), config.data.dir, "users.json");
}

/** 读取全量用户（文件缺失/损坏返回空数组，不抛错） */
function readUsers(): User[] {
  try {
    if (!existsSync(usersFile())) return [];
    const raw = readFileSync(usersFile(), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as User[]) : [];
  } catch {
    return [];
  }
}

/** 是否进入多人模式（有 ≥1 个启用用户）。无用户表时走单口令回退 */
export function isMultiUserMode(): boolean {
  return readUsers().some((u) => u.enabled);
}

/** 按口令查找启用用户（登录用） */
export function findUserByPasscode(passcode: string): User | undefined {
  if (!passcode) return undefined;
  return readUsers().find((u) => u.enabled && verifyPasscode(passcode, u.passcodeHash));
}

export function findUserById(id: string): User | undefined {
  return readUsers().find((u) => u.id === id);
}

export function listUsers(): User[] {
  return readUsers();
}
