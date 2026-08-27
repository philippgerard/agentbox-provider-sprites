#!/usr/bin/env bash
set -euo pipefail

# Sprites installs language shims under /.sprite/bin. sudo uses a restricted
# secure_path, so make the platform tools visible before the preflight.
export PATH="/.sprite/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

ASSET_DIR=/tmp/agentbox-runtime
trap 'rm -rf "$ASSET_DIR"' EXIT

if [ "$(id -u)" -ne 0 ]; then
  echo 'install-box.sh must run as root' >&2
  exit 64
fi

for command in node git tmux sudo useradd install; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "install-box.sh: required command missing: $command" >&2
    exit 65
  fi
done

if ! id vscode >/dev/null 2>&1; then
  useradd -m -s /bin/bash vscode
fi

install -d -m 0755 /etc/sudoers.d
printf '%s\n' \
  'sprite ALL=(ALL) NOPASSWD:SETENV: ALL' \
  'vscode ALL=(ALL) NOPASSWD:SETENV: ALL' \
  > /etc/sudoers.d/90-agentbox-sprites
chmod 0440 /etc/sudoers.d/90-agentbox-sprites
if command -v visudo >/dev/null 2>&1; then
  visudo -cf /etc/sudoers >/dev/null
fi

install -d -m 0755 \
  /workspace \
  /run/agentbox \
  /var/log/agentbox \
  /var/lib/agentbox \
  /etc/agentbox \
  /etc/claude-code \
  /usr/local/share/agentbox
chown vscode:vscode /workspace /run/agentbox /var/log/agentbox /var/lib/agentbox

install -m 0755 "$ASSET_DIR/ctl.cjs" /usr/local/bin/agentbox-ctl
install -m 0755 "$ASSET_DIR/agentbox-checkpoint-cleanup" /usr/local/bin/agentbox-checkpoint-cleanup
install -m 0755 "$ASSET_DIR/agentbox-open" /usr/local/bin/agentbox-open
ln -sfn /usr/local/bin/agentbox-open /usr/local/bin/xdg-open
install -m 0755 "$ASSET_DIR/gh-shim" /usr/local/bin/gh
install -m 0755 "$ASSET_DIR/git-shim" /usr/local/bin/git
install -m 0755 "$ASSET_DIR/ntn-shim" /usr/local/bin/ntn
ln -sfn /usr/local/bin/ntn /usr/local/bin/notion
install -m 0755 "$ASSET_DIR/linear-shim" /usr/local/bin/linear

install -m 0644 "$ASSET_DIR/claude-managed-settings.json" /etc/claude-code/managed-settings.json
install -m 0644 "$ASSET_DIR/agentbox-codex-hooks.json" /usr/local/share/agentbox/codex-hooks.json
install -m 0644 "$ASSET_DIR/opencode-agentbox-plugin.js" /usr/local/share/agentbox/opencode-agentbox-plugin.js
install -m 0644 "$ASSET_DIR/agentbox-setup-skill.md" /usr/local/share/agentbox/setup-guide.md

cat > /etc/claude-code/CLAUDE.md <<'PROMPT'
# AgentBox sandbox (Sprites provider)

This is a persistent, hardware-isolated Sprites environment managed by AgentBox.
Work as `vscode`; passwordless sudo is available. The host filesystem is not
mounted. `/workspace` is a normal checkout seeded from the host repository.

The filesystem persists while the Sprite hibernates. Processes may be restarted
after a cold wake; AgentBox runs its supervisor as a Sprite service. Docker and
VNC are not provided by this provider.

Use `agentbox-ctl git push|fetch|pull -- <args>` for operations that must reach
the host repository or its credentials. Use `agentbox-ctl git pr <op> [args...]`
for GitHub PR operations. Use `agentbox-ctl cp toHost` and
`agentbox-ctl cp fromHost` for approved host file transfers.

If `/workspace/agentbox.yaml` exists, inspect services with
`agentbox-ctl status`. Box identity is in `/etc/agentbox/box.env` and the
`AGENTBOX_*` environment variables.
PROMPT
chmod 0644 /etc/claude-code/CLAUDE.md

cat > /etc/tmux.conf <<'TMUX'
set -g default-terminal "tmux-256color"
set -as terminal-overrides ",*:Tc"
set -as terminal-features ",*:hyperlinks"
set -as terminal-features ",*:RGB"
set -g allow-passthrough on
set -g set-clipboard on
set -g extended-keys on
set -as terminal-features ",*:extkeys"
set -g mouse on
set -g history-limit 50000
set -g escape-time 0
TMUX

install -d -m 0755 -o vscode -g vscode \
  /home/vscode/.claude \
  /home/vscode/.claude/skills/agentbox-setup \
  /home/vscode/.codex \
  /home/vscode/.local/share/opencode \
  /home/vscode/.agentbox-creds/claude \
  /home/vscode/.agentbox-creds/codex \
  /home/vscode/.agentbox-creds/opencode
# `install -d` applies -o/-g to the leaf only, so the intermediate dirs it had
# to create (/home/vscode/.local, .../share, .../.agentbox-creds) stay
# root-owned — and AgentBox seeds write INTO them as vscode (OpenCode's
# model-state seed failed with "mkdir: Permission denied" for exactly this).
chown -R vscode:vscode /home/vscode/.local /home/vscode/.agentbox-creds
sudo -u vscode -H ln -sfn /home/vscode/.agentbox-creds/claude/.credentials.json \
  /home/vscode/.claude/.credentials.json
sudo -u vscode -H ln -sfn /home/vscode/.agentbox-creds/codex/auth.json \
  /home/vscode/.codex/auth.json
sudo -u vscode -H ln -sfn /home/vscode/.agentbox-creds/opencode/auth.json \
  /home/vscode/.local/share/opencode/auth.json
sudo -u vscode -H ln -sfn /home/vscode/.claude/_claude.json /home/vscode/.claude.json
sudo -u vscode -H cp /usr/local/share/agentbox/setup-guide.md \
  /home/vscode/.claude/skills/agentbox-setup/SKILL.md

# The Sprite base image installs the coding agents (claude, codex, gemini,
# cursor-agent) under the platform's own `sprite` user, whose home is 0750 —
# `vscode` cannot even traverse it, so every agent is missing from the box
# user's PATH. Open the traverse bit (not the read bit: `o+x` on a dir permits
# path resolution, not listing) and put the dir on vscode's PATH below. This
# grants nothing new — vscode already has passwordless sudo.
if [ -d /home/sprite ]; then
  chmod o+x /home/sprite
fi

cat > /etc/profile.d/agentbox.sh <<'PROFILE'
if [ -r /etc/agentbox/box.env ]; then
  set -a
  . /etc/agentbox/box.env
  set +a
fi
PATH=/usr/local/bin:/home/vscode/.local/bin:/home/sprite/.local/bin:/.sprite/bin:$(printf '%s' "$PATH" | sed -e 's#^/usr/local/bin:##' -e 's#:/usr/local/bin:#:#g' -e 's#:/usr/local/bin$##')
export PATH
export COLORTERM=${COLORTERM:-truecolor}
export DISABLE_AUTOUPDATER=${DISABLE_AUTOUPDATER:-1}
export BROWSER=${BROWSER:-/usr/local/bin/agentbox-open}
case $- in
  *i*)
    if [ "$PWD" = "$HOME" ] && [ -d /workspace ]; then
      cd /workspace
    fi
    ;;
esac
PROFILE
chmod 0644 /etc/profile.d/agentbox.sh

sudo -u vscode -H bash -lc 'git config --global --add safe.directory "*"'
sudo -u vscode -H bash -lc 'command -v node >/dev/null && command -v git >/dev/null && command -v tmux >/dev/null'

echo 'AgentBox runtime installed'
