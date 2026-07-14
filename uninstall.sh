#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHELL_RC="${SHELL_RC:-$HOME/.zshrc}"

if [ -f "$SHELL_RC" ]; then
  python3 - "$SHELL_RC" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
start = "# failover-proxy start"
end = "# failover-proxy end"

while start in text and end in text:
    before, rest = text.split(start, 1)
    _, after = rest.split(end, 1)
    text = before + after

path.write_text(text.strip() + "\n")
PY
fi

if [ -f "$HOME/.local/bin/claude" ] && grep -q "$PROJECT_DIR/start-with-claude.sh" "$HOME/.local/bin/claude"; then
  rm "$HOME/.local/bin/claude"
fi

pids="$(lsof -i :${PORT:-9000} -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -n "$pids" ]; then
  for pid in $pids; do
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$cmd" in
      *"node server.js"*) kill "$pid" 2>/dev/null || true ;;
    esac
  done
fi

echo "Removed failover-proxy shell integration. Restore ~/.claude/settings.json from ~/.claude/backups if needed."
