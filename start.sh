#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

HOST_DEFAULT="${DSA_HOST:-0.0.0.0}"
PORT_DEFAULT="${DSA_PORT:-8000}"

HOST="$HOST_DEFAULT"
PORT="$PORT_DEFAULT"

ARGS=("$@")
for ((i=0; i<${#ARGS[@]}; i++)); do
  case "${ARGS[$i]}" in
    --host)
      if (( i + 1 < ${#ARGS[@]} )); then HOST="${ARGS[$((i+1))]}"; fi
      ;;
    --port)
      if (( i + 1 < ${#ARGS[@]} )); then PORT="${ARGS[$((i+1))]}"; fi
      ;;
  esac
done

LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/dsa.pid"
LOG_FILE="$LOG_DIR/dsa-start.log"

mkdir -p "$LOG_DIR"

kill_pid() {
  local pid="$1"
  if [ -z "$pid" ]; then
    return 0
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi

  pkill -TERM -P "$pid" >/dev/null 2>&1 || true
  kill -TERM "$pid" >/dev/null 2>&1 || true

  local waited=0
  while kill -0 "$pid" >/dev/null 2>&1; do
    if [ "$waited" -ge 10 ]; then
      break
    fi
    sleep 1
    waited="$((waited + 1))"
  done

  if kill -0 "$pid" >/dev/null 2>&1; then
    pkill -KILL -P "$pid" >/dev/null 2>&1 || true
    kill -KILL "$pid" >/dev/null 2>&1 || true
  fi
}

if [ -f "$PID_FILE" ]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${old_pid:-}" ] && kill -0 "$old_pid" >/dev/null 2>&1; then
    kill_pid "$old_pid"
  fi
  rm -f "$PID_FILE"
fi

if command -v lsof >/dev/null 2>&1; then
  listen_pid="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
  if [ -n "${listen_pid:-}" ]; then
    kill_pid "$listen_pid"
  fi
fi

VENV_DIR="$ROOT_DIR/.venv"
PYTHON=""

if [ -x "$VENV_DIR/bin/python" ]; then
  PYTHON="$VENV_DIR/bin/python"
else
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BOOTSTRAP="$(command -v python3)"
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BOOTSTRAP="$(command -v python)"
  else
    echo "python3/python 未找到" >&2
    exit 1
  fi
  "$PYTHON_BOOTSTRAP" -m venv "$VENV_DIR"
  PYTHON="$VENV_DIR/bin/python"
fi

REQ_FILE="$ROOT_DIR/requirements.txt"
HASH_FILE="$VENV_DIR/.requirements.sha256"

if [ -f "$REQ_FILE" ]; then
  req_hash="$(shasum -a 256 "$REQ_FILE" | awk '{print $1}')"
  installed_hash="$(cat "$HASH_FILE" 2>/dev/null || true)"
  if [ "$req_hash" != "$installed_hash" ]; then
    "$PYTHON" -m pip install -r "$REQ_FILE"
    printf '%s' "$req_hash" > "$HASH_FILE"
  else
    if ! "$PYTHON" -m pip check >/dev/null 2>&1; then
      "$PYTHON" -m pip install -r "$REQ_FILE"
    fi
  fi
fi

MODE="${DSA_MODE:-serve-only}"

CMD=("$PYTHON" "-u" "main.py")
case "$MODE" in
  serve)
    CMD+=("--serve")
    ;;
  serve-only|webui-only|webui)
    CMD+=("--serve-only")
    ;;
  *)
    CMD+=("--serve-only")
    ;;
esac
CMD+=("--host" "$HOST" "--port" "$PORT")
CMD+=("${ARGS[@]}")

nohup env PYTHONNOUSERSITE=1 "${CMD[@]}" >"$LOG_FILE" 2>&1 &
new_pid="$!"
printf '%s' "$new_pid" > "$PID_FILE"

echo "started pid=$new_pid host=$HOST port=$PORT log=$LOG_FILE"
