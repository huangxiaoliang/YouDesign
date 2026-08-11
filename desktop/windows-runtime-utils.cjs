const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const WINDOWS_COMMAND_EXTENSIONS = new Set([".exe", ".com", ".cmd", ".bat"]);

function envValue(env, names) {
  const source = env && typeof env === "object" ? env : {};
  const wanted = new Set(names.map((name) => String(name).toLowerCase()));
  for (const [key, value] of Object.entries(source)) {
    if (wanted.has(key.toLowerCase()) && value) return String(value);
  }
  return "";
}

function windowsPathValue(env) {
  let value = "";
  for (const [key, candidate] of Object.entries(env && typeof env === "object" ? env : {})) {
    if (key.toLowerCase() === "path" && candidate) value = String(candidate);
  }
  return value;
}

function normalizeWindowsEnv(env, extraPathEntries = []) {
  const source = env && typeof env === "object" ? env : {};
  const next = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() !== "path") next[key] = value;
  }
  const seen = new Set();
  const pathEntries = [...extraPathEntries, ...windowsPathValue(source).split(path.delimiter)]
    .map((entry) => String(entry || "").trim())
    .filter((entry) => {
      if (!entry) return false;
      const normalized = path.resolve(entry).toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  next.Path = pathEntries.join(path.delimiter);
  return next;
}

function parseWhereOutput(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function isWindowsCommandFile(file, fsImpl = fs) {
  const candidate = String(file || "").trim();
  if (!candidate || !WINDOWS_COMMAND_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return false;
  try {
    return fsImpl.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function commandVariants(value, env) {
  const candidate = String(value || "").trim();
  if (!candidate) return [];
  if (path.extname(candidate)) return [candidate];
  const pathExt = envValue(env, ["PATHEXT"]) || ".COM;.EXE;.BAT;.CMD";
  return pathExt
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => WINDOWS_COMMAND_EXTENSIONS.has(ext))
    .map((ext) => `${candidate}${ext}`);
}

function whereWindowsCommand(command, options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  try {
    const result = spawnSyncImpl("where.exe", [command], {
      encoding: "utf8",
      timeout: Number(options.timeoutMs || 3_000),
      windowsHide: true,
      env: options.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result?.status !== 0) return [];
    return parseWhereOutput(result.stdout);
  } catch {
    return [];
  }
}

function discoverWindowsClaudeCli(options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fsImpl || fs;
  const home = options.home || envValue(env, ["USERPROFILE", "HOME"]);
  const appData = envValue(env, ["APPDATA"]);
  const localAppData = envValue(env, ["LOCALAPPDATA"]);
  const candidates = [];
  for (const command of ["claude.exe", "claude.cmd", "claude"]) {
    candidates.push(...whereWindowsCommand(command, { ...options, env }));
  }
  candidates.push(
    appData ? path.join(appData, "npm", "claude.cmd") : "",
    appData ? path.join(appData, "npm", "claude.exe") : "",
    localAppData ? path.join(localAppData, "Programs", "claude", "claude.exe") : "",
    home ? path.join(home, ".claude", "local", "claude.exe") : "",
    home ? path.join(home, ".local", "bin", "claude.exe") : "",
    home ? path.join(home, ".local", "bin", "claude.cmd") : ""
  );
  for (const dir of windowsPathValue(env).split(path.delimiter).filter(Boolean)) {
    candidates.push(...commandVariants(path.join(dir, "claude"), env));
  }
  return Array.from(new Set(candidates.filter(Boolean).map((candidate) => path.resolve(candidate)))).find((candidate) =>
    isWindowsCommandFile(candidate, fsImpl)
  ) || "";
}

function resolveConfiguredWindowsCommand(configured, options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fsImpl || fs;
  const value = String(configured || "").trim();
  if (!value || /^claude(?:\.(?:exe|cmd|bat|com))?$/i.test(value)) {
    return discoverWindowsClaudeCli(options);
  }
  const directCandidates = path.isAbsolute(value)
    ? commandVariants(value, env)
    : [];
  for (const candidate of directCandidates) {
    if (isWindowsCommandFile(candidate, fsImpl)) return path.resolve(candidate);
  }
  if (!path.isAbsolute(value) && !/[\\/]/.test(value)) {
    for (const candidate of whereWindowsCommand(value, { ...options, env })) {
      if (isWindowsCommandFile(candidate, fsImpl)) return path.resolve(candidate);
    }
  }
  return discoverWindowsClaudeCli(options);
}

function discoverGitBashPath(options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fsImpl || fs;
  const configured = envValue(env, ["CLAUDE_CODE_GIT_BASH_PATH"]);
  const candidates = [configured];
  const programFiles = envValue(env, ["ProgramFiles"]);
  const programFilesX86 = envValue(env, ["ProgramFiles(x86)"]);
  const localAppData = envValue(env, ["LOCALAPPDATA"]);
  candidates.push(
    programFiles ? path.join(programFiles, "Git", "bin", "bash.exe") : "",
    programFilesX86 ? path.join(programFilesX86, "Git", "bin", "bash.exe") : "",
    localAppData ? path.join(localAppData, "Programs", "Git", "bin", "bash.exe") : ""
  );
  candidates.push(
    ...whereWindowsCommand("bash.exe", { ...options, env }).filter(
      (candidate) => !/[\\/](?:Windows)[\\/](?:System32|Sysnative)[\\/]bash\.exe$/i.test(candidate)
    )
  );
  return Array.from(new Set(candidates.filter(Boolean).map((candidate) => path.resolve(candidate)))).find((candidate) => {
    try {
      return fsImpl.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || "";
}

function quoteCmdToken(value) {
  const token = String(value ?? "");
  return `"${token.replace(/"/g, '""')}"`;
}

function windowsSpawnSpec(command, args = [], env = process.env) {
  const executable = String(command || "");
  const ext = path.extname(executable).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") {
    return { command: executable, args: [...args], windowsVerbatimArguments: false };
  }
  const comspec = envValue(env, ["ComSpec"]) || "cmd.exe";
  const commandLine = [quoteCmdToken(executable), ...args.map(quoteCmdToken)].join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function windowsAccountKey(env) {
  return [
    envValue(env, ["USERPROFILE", "HOME"]),
    envValue(env, ["USERNAME", "USER"]),
    envValue(env, ["APPDATA"]),
  ].join("\u0000");
}

function captureProtocolUrl(argv) {
  return (Array.isArray(argv) ? argv : []).find((arg) => /^youdesign:\/\/capture(?:[/?#]|$)/i.test(String(arg || ""))) || "";
}

module.exports = {
  captureProtocolUrl,
  discoverGitBashPath,
  discoverWindowsClaudeCli,
  envValue,
  isWindowsCommandFile,
  normalizeWindowsEnv,
  parseWhereOutput,
  quoteCmdToken,
  resolveConfiguredWindowsCommand,
  windowsAccountKey,
  windowsPathValue,
  windowsSpawnSpec,
};
