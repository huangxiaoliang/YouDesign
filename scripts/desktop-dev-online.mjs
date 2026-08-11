#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const child = spawn(electronPath, ["desktop/main.cjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ELECTRON_DEV: "1",
    YOUDESIGN_DESKTOP_USE_LOCAL_SERVER: "false",
  },
  stdio: "inherit",
  windowsHide: false,
});

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal && process.platform !== "win32") process.kill(process.pid, signal);
  else process.exitCode = code ?? (signal ? 1 : 0);
});
