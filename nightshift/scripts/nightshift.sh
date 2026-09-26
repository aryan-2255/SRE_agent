#!/usr/bin/env bash
# Run TrueForge and NightShift control in the background and restart them if they crash.
#   scripts/nightshift.sh start | stop | restart | status | logs [trueforge|control]
# A crashed or restarted control picks up unfinished incidents where they stopped (orchestrator.resume_unfinished).
# Control stays on the host (not in Docker) because TrueForge listens on localhost only; exposing it to a container
# network would expose its model keys and connectors too.
set -uo pipefail
cd "$(dirname "$0")/.."
LOGS=.data/logs
mkdir -p "$LOGS"

loop() {  # name, command... : run it again whenever it exits, until a stop file appears
  local name=$1; shift
  while true; do
    echo "[$(date '+%F %T')] starting $name" >> "$LOGS/$name.log"
    "$@" >> "$LOGS/$name.log" 2>&1
    echo "[$(date '+%F %T')] $name exited ($?)" >> "$LOGS/$name.log"
    [ -f "$LOGS/$name.stop" ] && break
    sleep 3
  done
}

keep_running() {  # detached from this terminal, so closing it does not stop NightShift
  nohup "$0" _loop "$@" >/dev/null 2>&1 &
  echo $! > "$LOGS/$1.pid"
}

is_running() { [ -f "$LOGS/$1.pid" ] && kill -0 "$(cat "$LOGS/$1.pid")" 2>/dev/null; }

start() {
  rm -f "$LOGS/trueforge.stop" "$LOGS/control.stop"
  is_running trueforge || keep_running trueforge ./scripts/start-trueforge.sh
  for _ in $(seq 90); do curl -sf localhost:8790/healthz >/dev/null && break; sleep 1; done
  is_running control || keep_running control ./.venv/bin/uvicorn control.app:app --host 127.0.0.1 --port 8090
  for _ in $(seq 30); do curl -sf localhost:8090/api/me >/dev/null && break; sleep 1; done
  status
}

stop() {
  touch "$LOGS/trueforge.stop" "$LOGS/control.stop"
  for n in control trueforge; do
    if is_running "$n"; then
      pkill -P "$(cat "$LOGS/$n.pid")" 2>/dev/null
      kill "$(cat "$LOGS/$n.pid")" 2>/dev/null
    fi
    rm -f "$LOGS/$n.pid"
  done
  pkill -f "uvicorn control.app:app" 2>/dev/null
  pkill -f "@truefoundry/trueforge" 2>/dev/null
  echo "stopped"
}

status() {
  printf "trueforge  %-4s  http://localhost:8790\n" "$(curl -sf localhost:8790/healthz >/dev/null && echo up || echo DOWN)"
  printf "control    %-4s  http://localhost:8090\n" "$(curl -sf localhost:8090/api/me >/dev/null && echo up || echo DOWN)"
  printf "ops-mcp    %-4s\n" "$(curl -sf localhost:8000/healthz >/dev/null && echo up || echo DOWN)"
}

case "${1:-status}" in
  _loop) shift; loop "$@" ;;
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 2; start ;;
  status) status ;;
  logs) tail -f "$LOGS/${2:-control}.log" ;;
  *) sed -n 2,6p "$0" ;;
esac
