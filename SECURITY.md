# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in YouDesign, please report it responsibly:

- **Do NOT open a public GitHub issue.**
- Email the maintainer directly (see the repo owner profile) with a description and, if possible, a reproduction.
- You should receive an acknowledgement within a reasonable timeframe. Please do not disclose the issue publicly until it has been addressed.

## Credentials

- The tracked [`.env.example`](./.env.example) contains **placeholder values only** — no real API keys, passwords, or secrets. It is safe to read and copy.
- Real credentials live only in `.env.local`, which is git-ignored and **must never be committed**.
- The user password table (`data/users.json`) stores only SHA-256 digests of passcodes (no salt/pepper); it is environment-local data and also git-ignored.
- MySQL credentials are read solely from `YOUDESIGN_MYSQL_*` environment variables at runtime.

If you have ever committed real secrets by accident, rotate them immediately — do not rely on history rewriting alone.

## Trust Model

- The Next.js server is meant to run behind a login gate (`src/middleware.ts`). Do not expose it to untrusted users without authentication.
- The Electron desktop client executes the locally-installed Claude Code CLI for large-HTML edits, scoped to per-job working directories with `--permission-mode bypassPermissions --tools LS,Bash` and `TASK.md` constraints restricting Bash to read-only within the job dir. Treat the desktop client as a trusted local tool.
- The Chrome capture extension captures the rendered DOM of pages you visit and posts it to the local desktop server (`127.0.0.1:17631`) or, as a fallback, to the YouDesign web tab via `postMessage`. Captured source-page scripts are always disabled before being stored or previewed.
