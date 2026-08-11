// 图片模式链路自测：复用前端同款 downscale，POST /api/generate，流式观察断点。
import { readFileSync, readFileSync as _r } from "node:fs";

// 从 .env.local 取访问口令，登录拿 cookie
const env = readFileSync("./.env.local", "utf8");
const PASSWORD = (env.match(/^YOUDESIGN_ACCESS_PASSWORD=(.*)$/m) || [])[1]?.trim() || "";
const cookie = await (async () => {
  const r = await fetch("http://localhost:3001/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const sc = r.headers.get("set-cookie") || "";
  const m = sc.match(/yd_auth=([^;]+)/);
  return m ? `yd_auth=${m[1]}` : "";
})();
if (!cookie) {
  console.error("登录失败，无法继续。");
  process.exit(1);
}
console.log(`[auth] 登录成功，拿到 cookie`);

const PNG = readFileSync("./.playwright-cli/page-2026-06-29T14-20-02-595Z.png");
const b64png = PNG.toString("base64");
const dataUrl = `data:image/png;base64,${b64png}`;

// 模拟浏览器 downscaleImage（canvas → 1568px JPEG 0.9）。node 没 canvas，用 sharp? 退而求其次：
// 直接把 PNG 原图当 image/png 附件发（route 只看 mediaType/data，不强制 jpeg）。
// 同时另测一张"大 body"：直接把整张 PNG base64 塞进去。

function makePayload({ label, mediaType, data, name }) {
  return {
    requirement: "自测：根据这张截图生成一个简单的登录页原型",
    mode: "generate",
    useDpl: false,
    allowClarify: false,
    rawHtml: false,
    fastMode: true,
    attachments: { images: [{ mediaType, data, name }], documents: [] },
    modelPreference: "auto",
  };
}

async function runOnce(label, payload) {
  const bodySize = Buffer.byteLength(JSON.stringify(payload));
  console.log(`\n===== ${label} | body=${(bodySize / 1024).toFixed(0)}KB =====`);
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180000); // 3min 上限
  let firstByteAt = null;
  let lastEventAt = null;
  let eventCount = 0;
  let lastErrEvent = null;
  let transportError = null;
  const stageMarks = {}; // stage -> {start, done}
  let maxGap = 0;
  let maxGapBetween = "";
  let prevEvtAt = null;
  let lastStageLabel = "";
  try {
    const res = await fetch("http://localhost:3001/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    console.log(`[resp] status=${res.status} ttfb=${((Date.now() - t0) / 1000).toFixed(2)}s`);
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      console.log(`[resp] non-stream body: ${text.slice(0, 300)}`);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!firstByteAt) firstByteAt = Date.now();
      lastEventAt = Date.now();
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        eventCount++;
        const evAt = Date.now();
        if (prevEvtAt) {
          const gap = evAt - prevEvtAt;
          if (gap > maxGap) { maxGap = gap; maxGapBetween = lastStageLabel + "→next"; }
        }
        prevEvtAt = evAt;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "step") {
            console.log(`[step +${((evAt - t0) / 1000).toFixed(1)}s] ${ev.stage}:${ev.status} ${ev.detail ?? ""}`);
            if (ev.status === "start") { stageMarks[ev.stage] = { start: evAt }; lastStageLabel = `${ev.stage}:start`; }
            else if (ev.status === "done" && stageMarks[ev.stage]?.start) {
              stageMarks[ev.stage].dur = evAt - stageMarks[ev.stage].start;
            }
          }
          else if (ev.type === "error") { lastErrEvent = ev.message; console.log(`[error-event +${((evAt - t0) / 1000).toFixed(1)}s] ${ev.message}`); }
          else if (ev.type === "done") console.log(`[done +${((evAt - t0) / 1000).toFixed(1)}s] flow.title=${ev.result?.flow?.title}`);
          else if (ev.type === "clarify") console.log(`[clarify] ${JSON.stringify(ev.questions)}`);
          else console.log(`[${ev.type} +${((evAt - t0) / 1000).toFixed(1)}s]`);
        } catch { /* partial */ }
      }
    }
  } catch (e) {
    transportError = e;
    console.log(`[TRANSPORT-ERROR] name=${e.name} message=${e.message} cause=${e.cause?.message ?? e.cause ?? "-"}`);
  } finally {
    clearTimeout(timer);
    const now = Date.now();
    console.log(`[summary] events=${eventCount} firstByte=${firstByteAt ? ((firstByteAt - t0) / 1000).toFixed(2) + "s" : "-"} lastEventToNow=${lastEventAt ? ((now - lastEventAt) / 1000).toFixed(2) + "s" : "-"} total=${((now - t0) / 1000).toFixed(2)}s`);
    console.log(`[stages] ${Object.entries(stageMarks).map(([k, v]) => `${k}=${((v.dur ?? 0) / 1000).toFixed(1)}s`).join(" ")}`);
    console.log(`[maxgap] ${maxGapBetween} = ${(maxGap / 1000).toFixed(1)}s`);
    console.log(`[verdict] transportError=${transportError ? transportError.message : "none"} errEvent=${lastErrEvent ?? "none"}`);
  }
}

// 0) 纯文本对照（无图片）
await runOnce("text-only", {
  requirement: "自测：生成一个简单的登录页原型",
  mode: "generate",
  useDpl: false,
  allowClarify: false,
  rawHtml: false,
  fastMode: true,
  attachments: { images: [], documents: [] },
  modelPreference: "auto",
});

// 1) 单张真实截图（PNG）
await runOnce("single-png", makePayload({ mediaType: "image/png", data: b64png, name: "page.png" }));

// 2) 大 body：同一张图塞两张（模拟 2 附件，撑大 body）
await runOnce("double-png", {
  ...makePayload({ mediaType: "image/png", data: b64png, name: "page.png" }),
  attachments: { images: [{ mediaType: "image/png", data: b64png, name: "p1.png" }, { mediaType: "image/png", data: b64png, name: "p2.png" }], documents: [] },
});
