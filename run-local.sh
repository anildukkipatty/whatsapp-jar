#!/usr/bin/env bash
# Starts whatsapp-jar locally: Postgres in Docker, then the app on http://localhost:4000.
# Needs Node 22+ and Docker Desktop, which it starts if it isn't running.
# Runs in the foreground; press Ctrl+C to stop the app. Postgres keeps running:
# ./stop-local.sh stops the app, Postgres and Docker Desktop.
#
# Usage: ./run-local.sh            build, then start
#        ./run-local.sh --no-build start the last build
#        PORT=4001 ./run-local.sh  use another port
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-4000}"
BUILD=1
[[ "${1:-}" == "--no-build" ]] && BUILD=0

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

step "Checking Node and Docker"
command -v node >/dev/null || fail "Node is not installed. Install Node 22 or newer."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 22 )) || fail "Node $(node -v) is too old. Node 22 or newer is needed."
command -v docker >/dev/null || fail "Docker is not installed. Install Docker Desktop."
if ! docker info >/dev/null 2>&1; then
  echo "Docker isn't running. Starting Docker Desktop..."
  docker desktop start >/dev/null 2>&1 || open -a Docker 2>/dev/null || true
  for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || fail "Docker Desktop didn't start within 3 minutes. Open it yourself, wait until it's running, then try again."
fi
echo "Node $(node -v), Docker $(docker info --format '{{.ServerVersion}}')"

step "Checking port $PORT"
if holder="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2)" && [[ -n "$holder" ]]; then
  echo "$holder"
  fail "Port $PORT is already in use by the process above. Stop it, or run with PORT=<other port>."
fi
echo "Port $PORT is free"

step "Checking .env"
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  secret="$(openssl rand -hex 32)"
  sed -i.bak "s/^SESSION_SECRET=.*/SESSION_SECRET=$secret/" .env && rm -f .env.bak
  echo "Created .env with a new SESSION_SECRET."
fi
grep -q '^SESSION_SECRET=.\+' .env || fail "SESSION_SECRET is empty in .env. Set it with: openssl rand -hex 32"
if ! grep -q '^ANTHROPIC_API_KEY=.\+' .env; then
  echo "Warning: ANTHROPIC_API_KEY is empty in .env. The app runs, but the agent can't reply until you set it."
fi
echo ".env is ready"

step "Installing packages if needed"
if [[ ! -d node_modules || package-lock.json -nt node_modules/.package-lock.json ]]; then
  npm ci
else
  echo "Packages are up to date"
fi

step "Starting Postgres"
npm run --silent db:up

step "Applying database migrations"
npm run --silent db:migrate

step "Adding demo users (skipped if they already exist)"
npm run --silent db:seed

if (( BUILD )); then
  step "Building the app"
  npm run --silent build
elif [[ ! -f .next/BUILD_ID ]]; then
  fail "There is no build yet. Run without --no-build."
fi

step "Starting the app on http://localhost:$PORT (Ctrl+C to stop)"
exec ./node_modules/.bin/next start -H 127.0.0.1 -p "$PORT"
