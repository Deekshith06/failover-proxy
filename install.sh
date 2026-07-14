#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHELL_RC="${SHELL_RC:-$HOME/.zshrc}"
CLAUDE_SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"

mkdir -p "$HOME/.local/bin" "$HOME/.claude/backups"

cd "$PROJECT_DIR"
npm run check

if [ -f "$HOME/.local/bin/claude" ] && ! grep -q "failover-proxy" "$HOME/.local/bin/claude" 2>/dev/null; then
  cp "$HOME/.local/bin/claude" "$HOME/.local/bin/claude.backup.$TIMESTAMP"
fi

cat > "$HOME/.local/bin/claude" <<EOF
#!/usr/bin/env bash
exec "$PROJECT_DIR/start-with-claude.sh" "\$@"
EOF
chmod +x "$HOME/.local/bin/claude" "$PROJECT_DIR/start-with-claude.sh"

OPENROUTER_KEYS_VALUE="${OPENROUTER_KEYS:-}"
if [ -z "$OPENROUTER_KEYS_VALUE" ]; then
  OPENROUTER_KEYS_VALUE="YOUR_OPENROUTER_KEY_1,YOUR_OPENROUTER_KEY_2"
fi

touch "$SHELL_RC"
python3 - "$SHELL_RC" "$PROJECT_DIR" "$OPENROUTER_KEYS_VALUE" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
project_dir = sys.argv[2]
keys = sys.argv[3]
text = path.read_text()
start = "# failover-proxy start"
end = "# failover-proxy end"

while start in text and end in text:
    before, rest = text.split(start, 1)
    _, after = rest.split(end, 1)
    text = before + after

block = f'''
{start}
export FAILOVER_PROXY_DIR="{project_dir}"
export OPENROUTER_KEYS="{keys}"
alias claude="{project_dir}/start-with-claude.sh"
{end}
'''

path.write_text(text.rstrip() + "\n" + block)
PY

if [ -f "$CLAUDE_SETTINGS" ]; then
  cp "$CLAUDE_SETTINGS" "$HOME/.claude/backups/settings.json.failover-proxy.$TIMESTAMP.bak"
fi

node <<'JS'
const fs = require('fs');
const path = process.env.CLAUDE_SETTINGS || `${process.env.HOME}/.claude/settings.json`;
let settings = {};

if (fs.existsSync(path)) {
  settings = JSON.parse(fs.readFileSync(path, 'utf8'));
}

settings.env = settings.env || {};
settings.env.ANTHROPIC_BASE_URL = `http://localhost:${process.env.PORT || '9000'}`;
settings.env.ANTHROPIC_AUTH_TOKEN = 'dummy-not-used';
settings.env.ANTHROPIC_API_KEY = '';
settings.env.ANTHROPIC_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'moonshotai/kimi-k2.6:free';
settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'minimax/m2-5:free';
settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek/deepseek-v4-flash:free';
settings.env.CLAUDE_CODE_SUBAGENT_MODEL = 'openai/gpt-oss-120b:free';
settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1';
settings.env.DISABLE_TELEMETRY = '1';
settings.hasCompletedOnboarding = true;

fs.mkdirSync(`${process.env.HOME}/.claude`, { recursive: true });
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
JS

if [ "$OPENROUTER_KEYS_VALUE" = "YOUR_OPENROUTER_KEY_1,YOUR_OPENROUTER_KEY_2" ]; then
  echo "Installed. Edit $SHELL_RC and replace OPENROUTER_KEYS with real OpenRouter keys."
else
  echo "Installed with OPENROUTER_KEYS from your environment."
fi

echo "Run: source \"$SHELL_RC\" && claude"
