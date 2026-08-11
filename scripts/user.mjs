#!/usr/bin/env node
/**
 * 用户管理 CLI（多人模式）。
 *   node scripts/user.mjs add <name> [--admin]   新建用户，打印口令（仅此一次，请转交）
 *   node scripts/user.mjs list                   列出所有用户
 *   node scripts/user.mjs disable <id>           停用
 *   node scripts/user.mjs enable <id>            启用
 *   node scripts/user.mjs reset <id>             重置口令，打印新口令
 *   node scripts/user.mjs set-role <id> <user|admin>
 *
 * 数据文件：${YOUDESIGN_DATA_DIR:-data}/users.json（自动创建，已 gitignore）。
 * 口令只存 sha256 摘要；明文仅在 add/reset 时打印一次。
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const DATA_DIR = process.env.YOUDESIGN_DATA_DIR || "data";
const FILE = path.resolve(process.cwd(), DATA_DIR, "users.json");

function generatePasscode(len = 16) {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}
function hashPasscode(p) {
  return createHash("sha256").update(p, "utf8").digest("hex");
}
function readUsers() {
  if (!existsSync(FILE)) return [];
  try {
    const a = JSON.parse(readFileSync(FILE, "utf8"));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
function writeUsers(arr) {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(arr, null, 2) + "\n", "utf8");
}
function newId() {
  return "u_" + randomBytes(6).toString("hex");
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "add") {
  const name = rest[0];
  if (!name) {
    console.error("用法: add <name> [--admin]");
    process.exit(1);
  }
  const admin = rest.includes("--admin");
  const users = readUsers();
  const passcode = generatePasscode();
  const user = {
    id: newId(),
    name,
    passcodeHash: hashPasscode(passcode),
    enabled: true,
    role: admin ? "admin" : "user",
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);
  console.log(`已创建用户 ${name}（${user.id}，角色 ${user.role}）`);
  console.log(`口令（仅显示一次，请妥善转交）: ${passcode}`);
} else if (cmd === "list") {
  const users = readUsers();
  if (!users.length) {
    console.log("(无用户，当前为单口令回退模式)");
    process.exit(0);
  }
  for (const u of users) {
    console.log(`${u.id}\t${u.name}\t${u.role}\t${u.enabled ? "启用" : "停用"}\t${u.createdAt}`);
  }
} else if (cmd === "disable" || cmd === "enable") {
  const id = rest[0];
  if (!id) {
    console.error(`用法: ${cmd} <id>`);
    process.exit(1);
  }
  const users = readUsers();
  const u = users.find((x) => x.id === id);
  if (!u) {
    console.error("未找到用户: " + id);
    process.exit(1);
  }
  u.enabled = cmd === "enable";
  writeUsers(users);
  console.log(`${u.name} 已${cmd === "enable" ? "启用" : "停用"}`);
} else if (cmd === "reset") {
  const id = rest[0];
  if (!id) {
    console.error("用法: reset <id>");
    process.exit(1);
  }
  const users = readUsers();
  const u = users.find((x) => x.id === id);
  if (!u) {
    console.error("未找到用户: " + id);
    process.exit(1);
  }
  const passcode = generatePasscode();
  u.passcodeHash = hashPasscode(passcode);
  u.enabled = true;
  writeUsers(users);
  console.log(`${u.name} 口令已重置（仅显示一次）: ${passcode}`);
} else if (cmd === "set-role") {
  const id = rest[0];
  const role = rest[1];
  if (!id || (role !== "user" && role !== "admin")) {
    console.error("用法: set-role <id> <user|admin>");
    process.exit(1);
  }
  const users = readUsers();
  const u = users.find((x) => x.id === id);
  if (!u) {
    console.error("未找到用户: " + id);
    process.exit(1);
  }
  u.role = role;
  writeUsers(users);
  console.log(`${u.name} 角色已改为 ${role}`);
} else {
  console.error("用法: user.mjs <add|list|disable|enable|reset|set-role> ...");
  process.exit(1);
}
