#!/usr/bin/env bash
# Stops everything run-local.sh started: the app, this project's Postgres
# container, and then Docker Desktop. Safe to run when some or all of it is
# already stopped. Data in Postgres is kept.
#
# Docker Desktop is left running if containers from other projects are still
# up, so their work isn't cut off.
#
# Usage: ./stop-local.sh               stop the app, Postgres and Docker Desktop
#        ./stop-local.sh --keep-docker stop the app and Postgres, leave Docker Desktop on
set -uo pipefail
cd "$(dirname "$0")"

QUIT_DOCKER=1
[[ "${1:-}" == "--keep-docker" ]] && QUIT_DOCKER=0

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "Stopping the app"
# Every next-server started from this folder, on any port.
pids=()
for pid in $(pgrep -f 'next-server' 2>/dev/null); do
  [[ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | tail -1)" == "n$PWD" ]] && pids+=("$pid")
done
if (( ${#pids[@]} )); then
  kill "${pids[@]}" 2>/dev/null
  for _ in $(seq 1 10); do
    alive=()
    for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && alive+=("$pid"); done
    (( ${#alive[@]} )) || break
    sleep 1
  done
  if (( ${#alive[@]} )); then
    echo "Still running after 10 s, forcing: ${alive[*]}"
    kill -9 "${alive[@]}" 2>/dev/null
  fi
  echo "Stopped app process ${pids[*]}"
else
  echo "The app isn't running"
fi

if ! docker info >/dev/null 2>&1; then
  step "Docker"
  echo "Docker isn't running, so there's nothing more to stop"
  exit 0
fi

step "Stopping Postgres"
if [[ -n "$(docker compose ps -q db 2>/dev/null)" ]]; then
  docker compose stop db && echo "Postgres stopped (data kept)"
else
  echo "Postgres isn't running"
fi

(( QUIT_DOCKER )) || { echo; echo "Done. Docker Desktop left running (--keep-docker)."; exit 0; }

step "Quitting Docker Desktop"
others="$(docker ps --format '{{.Names}}')"
if [[ -n "$others" ]]; then
  echo "Leaving Docker Desktop running, because these containers from other projects are still up:"
  echo "$others" | sed 's/^/  /'
  exit 0
fi
if docker desktop stop >/dev/null 2>&1 || osascript -e 'quit app "Docker Desktop"' >/dev/null 2>&1; then
  echo "Docker Desktop stopped"
else
  echo "Couldn't stop Docker Desktop. Quit it from its menu-bar icon."
  exit 1
fi

echo
echo "Done. Everything is stopped. Start again with ./run-local.sh"
