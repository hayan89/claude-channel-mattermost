# Claude Channel Mattermost Repository Guide

## Scope And Sources Of Truth

- This is a Bun and TypeScript MCP channel that connects Claude Code to Mattermost. `server.ts`, `router.ts`, `approval-bridge.ts`, and `shared.ts` own the runtime behavior.
- Use `README.md`, `README.ko.md`, `package.json`, and `skills/*/SKILL.md` for the supported interface, access policies, and configuration flow.
- Keep `.claude-plugin/plugin.json`, the documented commands, and runtime behavior consistent when public behavior changes.

## Safety And Workflow

- Preserve pairing, allowlist, channel, attachment-path, and plan-mode gates. Treat any weakening of these controls as security-sensitive.
- Never commit or print `MATTERMOST_TOKEN`, channel state, downloaded attachments, pairing codes, or `.env` contents.
- Starting the server or router can connect a real bot. Sending, reacting, editing, downloading, pairing, or changing access policy requires explicit authorization for the exact account, channel, and action; verify authoritative Mattermost state afterward when a mutation is authorized.
- Keep tests isolated from real Mattermost services. Do not send messages or start the bot as documentation validation.
- Preserve unrelated user changes and solve general access-control or formatting behavior instead of special-casing fixtures.

## Validation

- Run `bun test` for behavior changes and `bun run typecheck` for TypeScript changes.
- For documentation-only changes, verify referenced files and commands, then run `git diff --check`.

## Model-Based Work Delegation

- When the main agent runs on the designated highest-tier model
  (currently GPT-6 Astra), reserve its work for planning, analysis,
  review, debugging/root-cause diagnosis, architecture, design,
  coordination, and final acceptance.
- Delegate all other execution work—including implementation,
  file edits, refactoring, test creation/execution, builds, and
  routine operational commands—to sub-agents using the designated
  second-tier model: currently gpt-5.6-sol with xhigh reasoning.
- Explicitly select the worker model and reasoning effort.
  Do not let workers inherit the highest-tier model by default.
- Give each worker clear scope, file ownership, acceptance criteria,
  and required verification. Provide only the context it needs.
- The main agent must review the resulting diff and verification
  evidence before declaring completion. Delegate review fixes back
  to the worker; do not duplicate the implementation.
- Reuse workers for related tasks. Parallelize only independent work.
  Workers must preserve other agents' and users' changes.
- Treat these model names as the configured role mapping, not as
  an inferred live price ranking. Do not silently substitute models.
- If delegation or the designated worker model is unavailable,
  report the limitation instead of silently doing execution work
  on the highest-tier model.
- Follow higher-priority instructions and existing authorization
  boundaries; delegation does not expand permission.
