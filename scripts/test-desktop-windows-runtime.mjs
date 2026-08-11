#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
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
} = require("../desktop/windows-runtime-utils.cjs");
const { sanitizeAttachmentName } = require("../desktop/attachment-utils.cjs");

const attachmentKinds = {
  html: { defaultExt: ".html", extensions: [".html", ".htm"] },
  zip: { defaultExt: ".zip", extensions: [".zip"] },
};

assert.equal(envValue({ Path: "A", USERPROFILE: "B" }, ["PATH"]), "A");
assert.equal(windowsPathValue({ pAtH: "A;B" }), "A;B");
assert.deepEqual(parseWhereOutput('"C:\\Program Files\\Claude\\claude.exe"\r\nC:\\Users\\测试\\claude.cmd\r\n'), [
  "C:\\Program Files\\Claude\\claude.exe",
  "C:\\Users\\测试\\claude.cmd",
]);
assert.equal(captureProtocolUrl(["YouDesign.exe", "--flag", "youdesign://capture"]), "youdesign://capture");
assert.equal(captureProtocolUrl(["YouDesign.exe", "https://example.com"]), "");
assert.match(quoteCmdToken("100% & ready"), /^"100% & ready"$/);
assert.equal(quoteCmdToken("中文 目录 & 任务.md"), '"中文 目录 & 任务.md"');
assert.equal(windowsAccountKey({ UserProfile: "C:/Users/a", UserName: "a", AppData: "C:/Users/a/AppData" }).split("\0").length, 3);
assert.equal(sanitizeAttachmentName("CON.html", "html", attachmentKinds), "_CON.html", "Windows 设备名即使带扩展名也必须避让");
assert.equal(sanitizeAttachmentName("CON.backup.html", "html", attachmentKinds), "_CON.backup.html", "Windows 设备名带多重扩展也必须避让");
assert.equal(sanitizeAttachmentName("lpt9.zip", "zip", attachmentKinds), "_lpt9.zip");
assert.equal(sanitizeAttachmentName("COM¹.html", "html", attachmentKinds), "_COM¹.html");
assert.equal(sanitizeAttachmentName("AUX", "html", attachmentKinds), "_AUX.html");
assert.equal(sanitizeAttachmentName("COM10.html", "html", attachmentKinds), "COM10.html", "非保留编号不得误伤");
assert.equal(sanitizeAttachmentName("客户 原型:最终版.html", "html", attachmentKinds), "客户 原型_最终版.html");
assert.equal(
  discoverGitBashPath({
    env: {},
    spawnSyncImpl: () => ({ status: 0, stdout: "C:\\Windows\\System32\\bash.exe\r\n" }),
    fsImpl: { statSync: () => ({ isFile: () => true }) },
  }),
  "",
  "WSL 的 system32/bash.exe 不得误判为 Git Bash"
);

{
  const normalized = normalizeWindowsEnv({ PATH: "/one", Path: "/two", HOME: "/home" }, ["/extra", "/extra"]);
  assert.equal(normalized.PATH, undefined);
  assert.equal(normalized.HOME, "/home");
  assert.deepEqual(normalized.Path.split(path.delimiter), ["/extra", "/two"]);
}

{
  const direct = windowsSpawnSpec("C:\\Tools\\claude.exe", ["auth", "status"], { ComSpec: "cmd.exe" });
  assert.equal(direct.command, "C:\\Tools\\claude.exe");
  assert.deepEqual(direct.args, ["auth", "status"]);
  assert.equal(direct.windowsVerbatimArguments, false);

  const shim = windowsSpawnSpec("C:\\Program Files\\nodejs\\claude.cmd", ["-p", "read TASK.md"], { ComSpec: "C:\\Windows\\System32\\cmd.exe" });
  assert.equal(shim.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(shim.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(shim.args[3], /"C:\\Program Files\\nodejs\\claude\.cmd"/);
  assert.match(shim.args[3], /"read TASK\.md"/);
  assert.equal(shim.windowsVerbatimArguments, true);

  const specialShim = windowsSpawnSpec("C:\\Users\\测试 用户\\AppData\\Roaming\\npm\\claude.cmd", ["-p", "读取 C:\\原型 & 资料\\TASK.md"], { ComSpec: "cmd.exe" });
  assert.match(specialShim.args[3], /"C:\\Users\\测试 用户\\AppData\\Roaming\\npm\\claude\.cmd"/);
  assert.match(specialShim.args[3], /"读取 C:\\原型 & 资料\\TASK\.md"/);
}

{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "yd-win-runtime-"));
  try {
    const npmDir = path.join(temp, "npm");
    const gitDir = path.join(temp, "Git", "bin");
    fs.mkdirSync(npmDir, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    const cli = path.join(npmDir, "claude.cmd");
    const bash = path.join(gitDir, "bash.exe");
    fs.writeFileSync(cli, "@echo off\n");
    fs.writeFileSync(bash, "stub\n");

    const failedWhere = () => ({ status: 1, stdout: "" });
    const env = { APPDATA: temp, ProgramFiles: temp, PATHEXT: ".EXE;.CMD", Path: npmDir };
    assert.equal(isWindowsCommandFile(cli), true);
    assert.equal(discoverWindowsClaudeCli({ env, spawnSyncImpl: failedWhere }), cli);
    assert.equal(resolveConfiguredWindowsCommand(cli, { env, spawnSyncImpl: failedWhere }), cli);
    assert.equal(discoverGitBashPath({ env, spawnSyncImpl: failedWhere }), bash);

    const whereCli = path.join(temp, "where", "claude.exe");
    fs.mkdirSync(path.dirname(whereCli), { recursive: true });
    fs.writeFileSync(whereCli, "stub\n");
    const successfulWhere = (_cmd, args) =>
      args[0] === "claude.exe" ? { status: 0, stdout: `${whereCli}\r\n` } : { status: 1, stdout: "" };
    assert.equal(discoverWindowsClaudeCli({ env: {}, spawnSyncImpl: successfulWhere }), whereCli);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

{
  const main = fs.readFileSync(path.join(projectRoot, "desktop/main.cjs"), "utf8");
  const desktopUtils = fs.readFileSync(path.join(projectRoot, "desktop/desktop-utils.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "desktop/preload.cjs"), "utf8");
  const builder = fs.readFileSync(path.join(projectRoot, "electron-builder.thin.win.yml"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.match(main, /discoverWindowsClaudeCli/);
  assert.match(main, /discoverGitBashPath/);
  assert.match(main, /captureProtocolUrl\(process\.argv\)/, "Windows 冷启动必须识别协议参数");
  assert.match(desktopUtils, /taskkill\.exe[\s\S]*?"\/PID"[\s\S]*?"\/T"[\s\S]*?"\/F"/, "Windows 必须终止完整进程树");
  assert.match(preload, /onExportSaved\(callback\)/, "Windows 薄包必须暴露桌面静默导出完成通知");
  assert.match(preload, /revealExportFile\(filePath\)/, "Windows 薄包必须支持在资源管理器中定位导出文件");
  assert.match(builder, /target:\s+nsis/);
  assert.match(builder, /arch:\s+[\s\S]*?- x64/);
  assert.match(builder, /perMachine:\s+false/);
  assert.match(builder, /signExecutable:\s+false/);
  assert.match(builder, /desktop\/\*\*\/\*/, "Windows 薄包必须完整收录共享 desktop 运行时");
  assert.doesNotMatch(builder, /\.next\/standalone/);
  assert.match(builder, /["']!node_modules\/\*\*["']/, "Windows 薄包必须显式排除 node_modules");
  assert.equal(pkg.scripts["desktop:nsis:thin:win"].includes("electron-builder.thin.win.yml"), true);
  assert.equal(pkg.version, "0.2.0", "Windows 安装包版本必须与本次发布版本一致");
  for (const requiredFile of [
    "attachment-utils.cjs",
    "capture-payload-utils.cjs",
    "captured-page-runtime.cjs",
    "claude-fragment-utils.cjs",
    "claude-html-utils.cjs",
    "claude-runtime-utils.cjs",
    "desktop-utils.cjs",
    "main.cjs",
    "preload.cjs",
    "prototype-navigation-core.cjs",
    "windows-runtime-utils.cjs",
  ]) {
    assert.equal(fs.existsSync(path.join(projectRoot, "desktop", requiredFile)), true, `Windows 薄包缺少运行时资源: ${requiredFile}`);
  }
  const extensionManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "extension/youdesign-capture/manifest.json"), "utf8"));
  assert.equal(extensionManifest.version, "0.2.9", "随 Windows 客户端交付的 Chrome 扩展版本必须为 0.2.9");
}

console.log("desktop Windows runtime tests passed");
