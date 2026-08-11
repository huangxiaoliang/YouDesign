#!/usr/bin/env python3
# Stop: 若本会话改过 src/scripts 代码（marker 存在），跑一次 typecheck；
#   失败 → decision:block 回灌错误让 Claude 继续修；通过 → 静默。
# marker 由 post-edit-reminder.py 写入。仅代码改动才触发，闲聊不跑。
# 执行日志：tmp/hooks.jsonl（`tail -f tmp/hooks.jsonl` 观测成功/失败/耗时）
import sys, json, os, subprocess, time
from _log import log

data = json.load(sys.stdin)
sid = data.get("session_id", "nosession")
marker = f"/tmp/yd-code-dirty.{sid}"

if not os.path.exists(marker):
    log("stop.skip", session=sid, reason="no-marker-未改代码")
    sys.exit(0)
os.remove(marker)

log("stop.typecheck.start", session=sid)
t0 = time.time()
r = subprocess.run(["npm", "run", "--silent", "typecheck"],
                   capture_output=True, text=True)
dur_ms = int((time.time() - t0) * 1000)

if r.returncode != 0:
    out = (r.stdout + r.stderr).strip().splitlines()
    err = "\n".join(out[-60:])
    log("stop.typecheck.fail", session=sid, duration_ms=dur_ms,
        error_tail=err[:2000])
    print(json.dumps({
        "decision": "block",
        "reason": f"⚠️ npm run typecheck 失败，请修复后再停止：\n\n{err}",
    }))
else:
    log("stop.typecheck.pass", session=sid, duration_ms=dur_ms)
sys.exit(0)
