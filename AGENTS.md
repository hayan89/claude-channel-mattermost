# Mattermost Channel Guide

Shared defaults: `/home/hyunseung/AGENTS.md`.

- Use `README.md`, `README.ko.md`, and `package.json` for the Bun/TypeScript interface; keep plugin metadata and runtime behavior consistent.
- Preserve pairing, allowlist, channel, attachment-path, and plan-mode gates. Never expose bot tokens, private messages, pairing codes, or state files.
- Real bot/account actions need authorization. Keep tests isolated; do not start the bot or send messages for documentation checks.
- Run `bun test` for behavior changes and `bun run typecheck` for TypeScript changes. Documentation-only work needs path checks and `git diff --check`.
- Preserve unrelated changes and use task branches with PRs into `main`.
