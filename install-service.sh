#!/usr/bin/env bash
set -euo pipefail

# ── Claude Channel Mattermost Router — systemd service installer ───────────
#
# Usage:
#   ./install-service.sh          # install & start
#   ./install-service.sh remove   # stop & remove

SERVICE_NAME="claude-channel-router"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUN_PATH="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
USER="$(whoami)"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# ── Colors ─────────────────────────────────────────────────────────────────
red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
cyan()  { printf '\033[0;36m%s\033[0m\n' "$*"; }

# ── Remove ─────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "remove" ]]; then
  cyan "Stopping and removing ${SERVICE_NAME}..."
  sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  sudo rm -f "$UNIT_FILE"
  sudo systemctl daemon-reload
  green "Service removed."
  exit 0
fi

# ── Preflight checks ──────────────────────────────────────────────────────
if [[ ! -x "$BUN_PATH" ]]; then
  red "bun not found at $BUN_PATH"
  echo "Install bun: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/router.ts" ]]; then
  red "router.ts not found in $PROJECT_DIR"
  exit 1
fi

ENV_FILE="$HOME/.claude/channels/mattermost/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  red ".env not found at $ENV_FILE"
  echo "Run /mattermost:configure to set up credentials first."
  exit 1
fi

# ── Install dependencies ──────────────────────────────────────────────────
cyan "Installing dependencies..."
cd "$PROJECT_DIR" && "$BUN_PATH" install --no-summary

# ── Write unit file ───────────────────────────────────────────────────────
cyan "Writing systemd unit to $UNIT_FILE..."

sudo tee "$UNIT_FILE" > /dev/null <<EOF
[Unit]
Description=Claude Channel Mattermost Router
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${PROJECT_DIR}
ExecStart=${BUN_PATH} ${PROJECT_DIR}/router.ts
Restart=on-failure
RestartSec=5

# Environment
Environment=HOME=${HOME}
Environment=PATH=${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${HOME}/.claude/channels/mattermost
ReadWritePaths=/tmp

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

# ── Enable & start ────────────────────────────────────────────────────────
cyan "Reloading systemd and starting service..."
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl start "$SERVICE_NAME"

# ── Status ─────────────────────────────────────────────────────────────────
echo ""
green "Service installed and started!"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status  $SERVICE_NAME    # check status"
echo "  sudo journalctl -u     $SERVICE_NAME -f # follow logs"
echo "  sudo systemctl restart $SERVICE_NAME    # restart"
echo "  sudo systemctl stop    $SERVICE_NAME    # stop"
echo "  ./install-service.sh remove             # uninstall"
echo ""

sudo systemctl status "$SERVICE_NAME" --no-pager
