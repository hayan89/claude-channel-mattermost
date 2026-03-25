# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-06-14

### Added

- Mattermost messaging bridge with 5 built-in tools (reply, react, edit, fetch history, download attachments)
- Multi-layer access control: pairing codes, allowlists, per-channel gating, static mode
- Plan mode workflow (`!plan` / `!go` / `!cancel`)
- Per-channel notes persistence across sessions
- Multi-channel router daemon (`router.ts`) for per-channel Claude isolation
- Shared module (`shared.ts`) with common types, constants, and utilities
- Channel-scoped MCP server mode (`MATTERMOST_CHANNEL_SCOPE`)
- Auto-chunking with configurable chunk modes (`length`, `newline`)
- Typing indicator on inbound messages
- Atomic state file writes with `chmod 0o600`
