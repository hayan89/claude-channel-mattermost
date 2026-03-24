---
name: configure
description: Set up the Mattermost channel — save the server URL and bot token, review access policy. Use when the user pastes a Mattermost URL or token, asks to configure Mattermost, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /mattermost:configure — Mattermost Channel Setup

Writes the server URL and bot token to `~/.claude/channels/mattermost/.env` and
orients the user on access policy. The server reads both files at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Credentials** — check `~/.claude/channels/mattermost/.env` for
   `MATTERMOST_URL` and `MATTERMOST_TOKEN`. Show set/not-set; if set, show
   URL in full, token first 6 chars masked.

2. **Access** — read `~/.claude/channels/mattermost/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count and list of user IDs
   - Pending pairings: count, with codes and sender IDs if any
   - Channels opted in: count

3. **What next** — end with a concrete next step based on state:
   - No URL or token → *"Run `/mattermost:configure <url> <token>` with your
     Mattermost URL and bot token from System Console → Integrations → Bot
     Accounts."*
   - Credentials set, policy is pairing, nobody allowed → *"DM your bot on
     Mattermost. It replies with a code; approve with `/mattermost:access pair
     <code>`."*
   - Credentials set, someone allowed → *"Ready. DM your bot to reach the
     assistant."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is not a policy to stay on; it's a temporary
way to capture user IDs you don't know. Once the IDs are in, pairing has done
its job and should be turned off.

Drive the conversation this way:

1. Read the allowlist. Tell the user who's in it.
2. Ask: *"Is that everyone who should reach you through this bot?"*
3. **If yes and policy is still `pairing`** → *"Good. Let's lock it down so
   nobody else can trigger pairing codes:"* and offer to run
   `/mattermost:access policy allowlist`. Do this proactively — don't wait to
   be asked.
4. **If no, people are missing** → *"Have them DM the bot; you'll approve
   each with `/mattermost:access pair <code>`. Run this skill again once
   everyone's in and we'll lock it."* Or, if they can get user IDs
   directly: *"Go to the user's profile → three-dot menu → Copy ID, then
   `/mattermost:access allow <id>`."*
5. **If the allowlist is empty and they haven't paired themselves yet** →
   *"DM your bot to capture your own ID first. Then we'll add anyone else
   and lock it down."*
6. **If policy is already `allowlist`** → confirm this is the locked state.
   If they need to add someone, Copy ID is the clean path — no need to
   reopen pairing.

Never frame `pairing` as the correct long-term choice. Don't skip the
lockdown offer.

### `<url> <token>` — save both

1. Parse `$ARGUMENTS`: first argument is URL (starts with `http`), second is
   the token. If only one argument and it starts with `http`, it's a URL-only
   update. If it doesn't start with `http`, it's a token-only update.
2. `mkdir -p ~/.claude/channels/mattermost`
3. Read existing `.env` if present; update/add the `MATTERMOST_URL=` and/or
   `MATTERMOST_TOKEN=` lines, preserve other keys. Write back, no quotes
   around values.
4. `chmod 600 ~/.claude/channels/mattermost/.env` — credentials are sensitive.
5. Confirm, then show the no-args status so the user sees where they stand.

### `url <url>` — save URL only

1. Update only `MATTERMOST_URL=` in `.env`.

### `token <token>` — save token only

1. Update only `MATTERMOST_TOKEN=` in `.env`.

### `clear` — remove credentials

Delete the `MATTERMOST_URL=` and `MATTERMOST_TOKEN=` lines (or the file if
those are the only lines).

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. Credential changes need a session
  restart or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/mattermost:access` take effect immediately, no restart.
