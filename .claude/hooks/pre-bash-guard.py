#!/usr/bin/env python3
# PreToolUse(Bash, 仅 git*): 拦截危险 git 操作
#   1) 在 main/master 上直接 commit / push → 拒绝（AGENTS.md §5：一功能一 PR，base main）
#   2) git push 显式推 main/master ref → 拒绝
#   3) git add 不入库路径 → 拒绝（AGENTS.md §4「绝不提交」+ .gitignore）
# 复合命令按 && / || / ; / | / 换行 拆成子命令，只检查真正是 `git <verb> ...` 的那段，
# 避免把 `gh pr create --base main` 里的 main 误判为 push 目标、
# 或把 `echo "git commit"` 误判为真 commit。
import sys, json, subprocess, re, shlex
from _log import log

data = json.load(sys.stdin)
cmd = data.get("tool_input", {}).get("command", "")


def deny(reason):
    log("prebash.deny", reason=reason[:200], cmd_head=cmd[:200])
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def git_subcommands(cmd):
    """拆复合命令，返回所有 `git <verb> ...` 子命令的词列表（shlex 解析，去引号）。"""
    subs = []
    for piece in re.split(r'\s*(?:&&|\|\||;|\||\n)\s*', cmd):
        piece = piece.strip()
        if re.match(r'^git\s+\S+', piece):
            try:
                subs.append(shlex.split(piece))
            except ValueError:
                subs.append(piece.split())
    return subs


subs = git_subcommands(cmd)
verbs = {s[1] for s in subs if len(s) >= 2}

# 1) main/master 上 commit / push（HEAD 分支判定，不看命令里的字面量）
#    若命令会先切到非 main 分支（checkout -b / switch -c / checkout <branch>），则放行——
#    PreToolUse 时 checkout 尚未执行，HEAD 仍在 main，不能据此误判。
if verbs & {"commit", "push"}:
    will_switch = False
    for s in subs:
        if len(s) >= 2 and s[1] in ("checkout", "switch"):
            tgt = None
            for i, t in enumerate(s[2:], start=2):
                if t in ("-b", "-c", "-B") and i + 1 < len(s):
                    tgt = s[i + 1]
                    break
            if tgt is None:
                for t in s[2:]:
                    if not t.startswith("-"):
                        tgt = t
                        break
            if tgt and tgt not in ("main", "master", "-"):
                will_switch = True
                break
    if not will_switch:
        try:
            r = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"],
                               capture_output=True, text=True)
            branch = r.stdout.strip()
        except Exception:
            branch = ""
        if branch in ("main", "master"):
            deny(f"禁止在 {branch} 分支直接 commit/push（AGENTS.md §5：一功能一 PR，base main）。"
                 f"请先 `git checkout -b feat/...`。如确需操作 main，请人工执行。")

# 2) git push 显式推 main/master ref：只看 push 子命令的 ref 参数（选项跳过）
for s in subs:
    if len(s) >= 2 and s[1] == "push":
        for tok in s[2:]:
            if tok.startswith("-"):
                continue  # 选项（-u / --force 等）
            for ref in tok.split(":"):  # ref 或 src:dst refspec
                if ref in ("main", "master"):
                    deny("禁止直接 push main/master 分支（AGENTS.md §5）。请走 feat/fix 分支 + PR。")

# 3) git add 不入库路径：只看 add 子命令的路径参数
FORBIDDEN = re.compile(r'(\.env\.local|vendor/|\.next/|node_modules/|output/|tmp/|reference/|\.playwright-cli/)')
for s in subs:
    if len(s) >= 2 and s[1] == "add":
        for tok in s[2:]:
            if tok.startswith("-"):
                continue
            if FORBIDDEN.search(tok):
                deny("禁止 git add 不入库路径（vendor/.next/output 等，见 .gitignore 与 AGENTS.md §4）。"
                     "请用具体源码路径 `git add src/...`。")

log("prebash.allow", cmd_head=cmd[:160])
sys.exit(0)
