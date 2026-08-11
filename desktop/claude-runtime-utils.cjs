const fs = require("node:fs");
const path = require("node:path");

const CLAUDE_JOB_CANCELLED_CODE = "CLAUDE_JOB_CANCELLED";
const CLAUDE_JOB_OWNER = "youdesign-claude-job";
const CLAUDE_JOB_STATUS_VERSION = 1;
const CLAUDE_JOB_DIR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;
const CLAUDE_JOB_STATUSES = new Set(["running", "success", "failed", "cancelled", "needs_input", "no_change"]);

function createClaudeJobCancelledError(reason = "Claude Code CLI 修改已取消") {
  const error = new Error(reason);
  error.code = CLAUDE_JOB_CANCELLED_CODE;
  return error;
}

class ClaudeJobQueue {
  constructor() {
    this.accepting = true;
    this.pending = [];
    this.jobs = new Map();
    this.runningJob = null;
    this.pumping = false;
  }

  enqueue(jobId, task) {
    const id = String(jobId || "").trim();
    if (!id) return Promise.reject(new Error("缺少 Claude 任务 ID"));
    if (!this.accepting) return Promise.reject(createClaudeJobCancelledError("应用正在退出，Claude 任务未启动"));
    if (this.jobs.has(id)) return Promise.reject(new Error(`Claude 任务 ID 重复：${id}`));
    return new Promise((resolve, reject) => {
      const cancelListeners = new Set();
      const job = {
        id,
        state: "queued",
        cancelRequested: false,
        cancelReason: "",
        task,
        resolve,
        reject,
        onCancel(listener) {
          if (typeof listener !== "function") return () => {};
          if (job.cancelRequested) {
            queueMicrotask(() => listener(job.cancelReason));
            return () => {};
          }
          cancelListeners.add(listener);
          return () => cancelListeners.delete(listener);
        },
        requestCancel(reason) {
          if (job.cancelRequested) return;
          job.cancelRequested = true;
          job.cancelReason = reason || "Claude Code CLI 修改已取消";
          for (const listener of cancelListeners) listener(job.cancelReason);
          cancelListeners.clear();
        },
        throwIfCancelled() {
          if (job.cancelRequested) throw createClaudeJobCancelledError(job.cancelReason);
        },
      };
      this.jobs.set(id, job);
      this.pending.push(job);
      queueMicrotask(() => this.pump());
    });
  }

  cancel(jobId, reason = "Claude Code CLI 修改已取消") {
    const id = String(jobId || "").trim();
    const job = this.jobs.get(id);
    if (!job) return { cancelled: false, state: "not-found", jobId: id };
    if (job.state === "queued") {
      const index = this.pending.indexOf(job);
      if (index >= 0) this.pending.splice(index, 1);
      job.state = "cancelled";
      job.requestCancel(reason);
      this.jobs.delete(id);
      job.reject(createClaudeJobCancelledError(reason));
      return { cancelled: true, state: "queued", jobId: id };
    }
    if (job.state === "running" || job.state === "cancelling") {
      job.state = "cancelling";
      job.requestCancel(reason);
      return { cancelled: true, state: "running", jobId: id };
    }
    return { cancelled: false, state: job.state, jobId: id };
  }

  shutdown(reason = "应用退出，Claude 任务已取消") {
    this.accepting = false;
    const results = [];
    for (const jobId of Array.from(this.jobs.keys())) results.push(this.cancel(jobId, reason));
    return results;
  }

  status() {
    return {
      accepting: this.accepting,
      running: Boolean(this.runningJob),
      runningJobId: this.runningJob?.id,
      queueSize: this.pending.length,
      queuedJobIds: this.pending.map((job) => job.id),
    };
  }

  async waitForIdle(timeoutMs = 2_000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.runningJob || this.pending.length) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }

  async pump() {
    if (this.pumping || this.runningJob) return;
    this.pumping = true;
    try {
      while (!this.runningJob && this.pending.length) {
        const job = this.pending.shift();
        if (!job || job.cancelRequested) continue;
        this.runningJob = job;
        job.state = "running";
        try {
          job.throwIfCancelled();
          job.resolve(await job.task(job));
          job.state = "done";
        } catch (error) {
          job.reject(error);
          job.state = job.cancelRequested ? "cancelled" : "failed";
        } finally {
          this.jobs.delete(job.id);
          this.runningJob = null;
        }
      }
    } finally {
      this.pumping = false;
      if (!this.runningJob && this.pending.length) queueMicrotask(() => this.pump());
    }
  }
}

function appendTextTail(current, chunk, maxChars = 256 * 1024) {
  const combined = `${current || ""}${chunk || ""}`;
  return combined.length <= maxChars ? combined : combined.slice(-maxChars);
}

function createAsyncFileAppender(file) {
  const stream = fs.createWriteStream(file, { flags: "a" });
  let ended = false;
  let streamError = null;
  const closed = new Promise((resolve) => {
    stream.on("error", (error) => {
      streamError = streamError || error;
    });
    stream.on("close", resolve);
  });
  return {
    append(value) {
      if (ended || streamError || value === undefined || value === null || value === "") return false;
      return stream.write(String(value));
    },
    async close() {
      if (!ended) {
        ended = true;
        stream.end();
      }
      await closed;
      return streamError;
    },
  };
}

function writeClaudeJobStatus(jobDir, status, detail = "") {
  try {
    fs.writeFileSync(
      path.join(jobDir, "job-status.json"),
      `${JSON.stringify(
        {
          owner: CLAUDE_JOB_OWNER,
          version: CLAUDE_JOB_STATUS_VERSION,
          status,
          detail: String(detail || "").slice(0, 500),
          finishedAt: Date.now(),
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    return true;
  } catch {
    return false;
  }
}

function readClaudeJobInfo(fullPath, entry) {
  try {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    if (!CLAUDE_JOB_DIR_RE.test(entry.name)) return null;
    const stat = fs.statSync(fullPath);
    const metadata = JSON.parse(fs.readFileSync(path.join(fullPath, "job-status.json"), "utf8"));
    if (metadata.owner !== CLAUDE_JOB_OWNER || Number(metadata.version) !== CLAUDE_JOB_STATUS_VERSION) return null;
    const status = typeof metadata.status === "string" ? metadata.status : "";
    if (!CLAUDE_JOB_STATUSES.has(status)) return null;
    const finishedAt = Number.isFinite(Number(metadata.finishedAt)) ? Number(metadata.finishedAt) : stat.mtimeMs;
    return { fullPath, status, finishedAt };
  } catch {
    return null;
  }
}

function resolveSafeCleanupRoot(root, protectedRoots = []) {
  try {
    const resolved = fs.realpathSync(root);
    if (resolved === path.parse(resolved).root) return "";
    const protectedPaths = protectedRoots
      .filter(Boolean)
      .map((candidate) => {
        try {
          return fs.realpathSync(candidate);
        } catch {
          return path.resolve(candidate);
        }
      });
    const isProtectedOrAncestor = protectedPaths.some(
      (protectedPath) => resolved === protectedPath || protectedPath.startsWith(`${resolved}${path.sep}`)
    );
    return isProtectedOrAncestor ? "" : resolved;
  } catch {
    return "";
  }
}

function cleanupClaudeJobDirs(root, options = {}) {
  const resolvedRoot = resolveSafeCleanupRoot(root, options.protectedRoots);
  if (!resolvedRoot) return { removed: [], retained: 0, skippedUnsafeRoot: true };
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const successTtlMs = Number(options.successTtlMs || 7 * 24 * 60 * 60 * 1_000);
  const otherTtlMs = Number(options.otherTtlMs || 7 * 24 * 60 * 60 * 1_000);
  const maxOtherJobs = Number.isFinite(Number(options.maxOtherJobs)) ? Math.max(0, Number(options.maxOtherJobs)) : 20;
  const removed = [];
  const remove = (job) => {
    const relative = path.relative(resolvedRoot, job.fullPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    try {
      fs.rmSync(job.fullPath, { recursive: true, force: true });
      removed.push(job.fullPath);
      return true;
    } catch {
      return false;
    }
  };
  const jobs = [];
  let entries = [];
  try {
    entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
  } catch {
    return { removed, retained: 0 };
  }
  for (const entry of entries) {
    const info = readClaudeJobInfo(path.join(resolvedRoot, entry.name), entry);
    if (info) jobs.push(info);
  }
  const retained = [];
  for (const job of jobs) {
    const ttl = job.status === "success" ? successTtlMs : otherTtlMs;
    if (now - job.finishedAt > ttl) remove(job);
    else retained.push(job);
  }
  const otherJobs = retained.filter((job) => job.status !== "success").sort((a, b) => b.finishedAt - a.finishedAt);
  for (const job of otherJobs.slice(maxOtherJobs)) remove(job);
  return { removed, retained: retained.length - Math.max(0, otherJobs.length - maxOtherJobs) };
}

function summarizeClaudeApiFailure(event) {
  if (!event || typeof event !== "object") return "";
  const status = Number(event.api_error_status);
  const isApiFailure =
    event.terminal_reason === "api_error" ||
    (Number.isFinite(status) && status >= 400) ||
    (event.is_error === true && event.error === "server_error");
  if (!isApiFailure) return "";
  let detail = typeof event.result === "string" ? event.result : "";
  if (!detail && Array.isArray(event?.message?.content)) {
    detail = event.message.content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join(" ");
  }
  detail = detail.replace(/^API Error:\s*/i, "").trim();
  const statusText = Number.isFinite(status) && status >= 400 ? `（HTTP ${status}）` : "";
  const retryHint = Number.isFinite(status) && status >= 500 ? "；模型服务暂时不可用，请稍后重试" : "";
  return `模型服务请求失败${statusText}${detail ? `：${detail}` : ""}${retryHint}`.slice(0, 500);
}

module.exports = {
  CLAUDE_JOB_CANCELLED_CODE,
  CLAUDE_JOB_OWNER,
  ClaudeJobQueue,
  appendTextTail,
  cleanupClaudeJobDirs,
  createAsyncFileAppender,
  createClaudeJobCancelledError,
  summarizeClaudeApiFailure,
  writeClaudeJobStatus,
};
