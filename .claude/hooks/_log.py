#!/usr/bin/env python3
"""共享 hook 日志：追加 JSON 行到 tmp/hooks.jsonl（tmp/ 已 gitignore）。
所有日志写失败都被吞掉——绝不影响 hook 主逻辑。
项目根用脚本自身位置推导（.claude/hooks/_log.py → root），不依赖 cwd。"""
import json, datetime
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_LOG = _ROOT / "tmp" / "hooks.jsonl"


def log(event: str, **fields):
    try:
        _LOG.parent.mkdir(parents=True, exist_ok=True)
        rec = {"ts": datetime.datetime.now().isoformat(timespec="seconds"),
               "event": event}
        rec.update(fields)
        with open(_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass
