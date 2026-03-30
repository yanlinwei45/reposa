#!/bin/bash
cd "$(dirname "$0")"
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
  echo "No runtime.pid found"
fi
