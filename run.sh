#!/bin/bash
set -e
if [ -d /opt/homebrew/opt/node@22/bin ]; then
  export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
else
  export PATH=/opt/homebrew/bin:$PATH
fi
cd "$(dirname "$0")"
NPM_BIN=$(command -v npm)
if [ -z "$NPM_BIN" ]; then
  echo "npm not found in PATH"
  exit 1
fi
if [ -f runtime.pid ]; then
  PID=$(cat runtime.pid)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Already running with PID $PID"
    exit 0
  else
    rm -f runtime.pid
  fi
fi
nohup "$NPM_BIN" start > runtime.log 2>&1 &
APP_PID=$!
echo "$APP_PID" > runtime.pid
sleep 1
if kill -0 "$APP_PID" 2>/dev/null; then
  echo "Started PID $APP_PID"
  echo "Log: $(pwd)/runtime.log"
else
  echo "Failed to start process"
  rm -f runtime.pid
  exit 1
fi
