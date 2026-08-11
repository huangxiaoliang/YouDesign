const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function pushIfTruthy(list, value) {
  if (value) list.push(value);
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ""), "utf8");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function isChildProcessRunning(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function terminateChildProcess(child, signal = "SIGTERM") {
  if (!isChildProcessRunning(child)) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function terminateChildProcessTree(child, signal = "SIGTERM") {
  if (!child) return false;
  if (process.platform === "win32") {
    if (!isChildProcessRunning(child)) return false;
    try {
      // Native Claude commonly runs as cmd.exe -> node.exe -> claude. Killing only
      // the direct child can orphan the descendants, so every cancellation path
      // terminates the complete Windows process tree.
      const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return result.status === 0 || !isChildProcessRunning(child);
    } catch {
      return terminateChildProcess(child, signal);
    }
  }
  if (Number.isInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      // The child may not be a process-group leader; fall back to the direct child.
    }
  }
  return terminateChildProcess(child, signal);
}

function scheduleChildProcessForceKill(child, delayMs = 2_000, options = {}) {
  const timer = setTimeout(() => {
    if (options.tree) terminateChildProcessTree(child, "SIGKILL");
    else terminateChildProcess(child, "SIGKILL");
  }, delayMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  byteLength,
  isChildProcessRunning,
  isExecutable,
  normalizeBaseUrl,
  parseEnvFile,
  pushIfTruthy,
  safeReaddir,
  scheduleChildProcessForceKill,
  sha256Text,
  sleep,
  terminateChildProcess,
  terminateChildProcessTree,
};
