#!/usr/bin/env python3
# PostToolUse(Write|Edit): 敏感文件改动提醒 + 标记 dirty 供 Stop 跑 typecheck
#   - prompts.ts / config.ts / .env* / profiles.ts → 注入提醒到模型上下文
#   - src/**/*.{ts,tsx} / scripts/**/*.{mjs,ts} → 写 marker，Stop 时跑 typecheck
import sys, json, os, re
from _log import log

data = json.load(sys.stdin)
file = data.get("tool_input", {}).get("file_path") or data.get("tool_response", {}).get("filePath", "")
sid = data.get("session_id", "nosession")
marker = f"/tmp/yd-code-dirty.{sid}"

msgs = []
if file.endswith("src/lib/prompts.ts"):
    msgs.append("改了 prompts.ts——直接影响原型保真度，改前后请人工对比几个典型需求（AGENTS.md §4/§6，eval 尚无）。")
if file.endswith(".env.local") or os.path.basename(file) == ".env":
    msgs.append("改了 .env / .env.local——含密钥口令，绝不提交（AGENTS.md §4）。ROUTE_* 变化影响模型路由。")
if file.endswith("src/lib/config.ts"):
    msgs.append("改了 config.ts——模型路由/密钥读取入口，确认 .env.example 同步且未硬编码。")
if file.endswith("src/lib/style/profiles.ts"):
    msgs.append("改了 style profiles——品牌色两道闸（colorFidelityRule + normalizeBrandColors）会自动跟进，确认 themeCss token 同步。")

# 标记 dirty：仅 src/ 或 scripts/ 下的代码文件
marker_set = False
if re.search(r'/src/.*\.(ts|tsx)$', file) or re.search(r'/scripts/.*\.(mjs|ts)$', file):
    try:
        open(marker, "w").close()
        marker_set = True
    except Exception:
        pass

log("postedit", session=sid, file=os.path.basename(file) or "?",
    reminded=bool(msgs), marker_set=marker_set)

if msgs:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": " / ".join(msgs),
        }
    }))
sys.exit(0)
