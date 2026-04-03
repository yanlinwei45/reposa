#!/bin/bash
set -euo pipefail
if [ -d /opt/homebrew/opt/node@22/bin ]; then
  export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
else
  export PATH=/opt/homebrew/bin:$PATH
fi
cd "$(dirname "$0")"
NPM_BIN=$(command -v npm)
NODE_BIN=$(command -v node)
if [ -z "$NODE_BIN" ]; then
  echo "node not found in PATH"
  exit 1
fi
PORT=3088
find_listener_pid() {
  lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}
health_check() {
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1
}
if [ -f runtime.pid ]; then
  PID=$(cat runtime.pid)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Already running with PID $PID"
    exit 0
  else
    rm -f runtime.pid
  fi
fi
LISTENER_PID=$(find_listener_pid)
if [ -n "$LISTENER_PID" ]; then
  echo "Port $PORT is already in use by PID $LISTENER_PID"
  exit 1
fi

nohup "$NODE_BIN" src/index.js >> runtime.log 2>&1 < /dev/null &
APP_PID=$!
disown "$APP_PID" 2>/dev/null || true
echo "$APP_PID" > runtime.pid

for i in $(seq 1 30); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "Failed to start process"
    rm -f runtime.pid
    exit 1
  fi

  if health_check; then
    echo "Started PID $APP_PID"
    echo "Port: $PORT"
    echo "Log: $(pwd)/runtime.log"
    exit 0
  fi

  sleep 1
done

echo "Process started but health endpoint is not ready"
if kill -0 "$APP_PID" 2>/dev/null; then
  kill "$APP_PID" 2>/dev/null || true
fi
rm -f runtime.pid
exit 1
