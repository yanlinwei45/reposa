#!/bin/bash
cd "$(dirname "$0")"
PORT=3088
find_listener_pid() {
  lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | head -n 1
}

if [ -f runtime.pid ]; then
  PID=$(cat runtime.pid)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" 2>/dev/null || true
    fi
    echo "Stopped PID $PID"
    rm -f runtime.pid
  else
    echo "Process $PID not running"
    rm -f runtime.pid
  fi
else
  PID=$(find_listener_pid)
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
      kill -9 "$PID" 2>/dev/null || true
    fi
    echo "Stopped listener PID $PID on port $PORT"
  else
    echo "No runtime.pid found"
  fi
fi
