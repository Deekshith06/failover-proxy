#!/bin/bash

PROXY_PORT="${PORT:-9000}"
PROXY_DIR="${FAILOVER_PROXY_DIR:-$HOME/failover-proxy}"
PROXY_LOG="${FAILOVER_PROXY_LOG:-/tmp/failoverproxy.log}"
CLAUDE_BIN="${CLAUDE_BIN:-}"
PROXY_PID=""

if [ -z "$CLAUDE_BIN" ]; then
  for candidate in /opt/homebrew/bin/claude /usr/local/bin/claude /usr/bin/claude; do
    if [ -x "$candidate" ]; then
      CLAUDE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$CLAUDE_BIN" ]; then
  resolved="$(command -v claude 2>/dev/null || true)"
  if [ -n "$resolved" ] && [ "$resolved" != "$HOME/.local/bin/claude" ]; then
    CLAUDE_BIN="$resolved"
  fi
fi

if [ -z "$CLAUDE_BIN" ]; then
  echo "Could not find Claude Code. Set CLAUDE_BIN=/path/to/claude and try again."
  exit 1
fi

start_proxy() {
  if [ -z "${OPENROUTER_KEYS:-}" ]; then
    echo "Warning: OPENROUTER_KEYS is not set. The proxy will not start."
  fi

  echo "Starting OpenRouter multi-key proxy..."
  cd "$PROXY_DIR" || exit 1
  PORT="$PROXY_PORT" node server.js > "$PROXY_LOG" 2>&1 &
  PROXY_PID=$!

  for i in {1..10}; do
    if lsof -i :$PROXY_PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "Proxy is up (PID $PROXY_PID)."
      return 0
    fi
    sleep 0.5
  done

  echo "Proxy did not start. Check $PROXY_LOG."
  exit 1
}

cleanup() {
  if [ -n "$PROXY_PID" ]; then
    echo "Stopping OpenRouter multi-key proxy (PID $PROXY_PID)..."
    kill "$PROXY_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

existing_pids=$(lsof -i :$PROXY_PORT -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$existing_pids" ]; then
  for pid in $existing_pids; do
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
    case "$cmd" in
      *"node server.js"*)
        echo "Found stray proxy on :$PROXY_PORT, killing PID $pid..."
        kill "$pid" 2>/dev/null
        ;;
      *)
        echo "Port $PROXY_PORT is already used by: $cmd"
        exit 1
        ;;
    esac
  done
  sleep 1
fi

start_proxy
"$CLAUDE_BIN" "$@"
