#!/usr/bin/env bash
# One-time setup on a new machine. Safe to run again.
#   ./scripts/bootstrap.sh
# The team repo holds nightshift/ and, as a submodule, astronomy-shop/ (the shop's own repo). Run from nightshift/.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
SHOP=$(cd .. && pwd)/astronomy-shop   # the shop's own repo, next to nightshift/

step() { printf "\n\033[1m== %s\033[0m\n" "$1"; }

step "Shop fork"
if [ ! -f "$SHOP/shop.sh" ]; then
  # the shop is its own repo (the fork), linked into the team repo as a submodule
  (cd "$SHOP/.." && git submodule update --init astronomy-shop)
  git -C "$SHOP" checkout -q main 2>/dev/null || true
fi
echo "shop at $SHOP"

step ".env"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example"
fi
set_env() {  # set KEY only if it is empty
  local key=$1 val=$2
  if grep -qE "^$key=\s*(#.*)?$" .env; then
    python3 - "$key" "$val" <<'PY'
import re, sys
k, v = sys.argv[1], sys.argv[2]
s = open(".env").read()
s = re.sub(rf"^{k}=.*$", f"{k}={v}", s, count=1, flags=re.M)
open(".env", "w").write(s)
PY
    echo "  $key set"
  fi
}
# a .env copied from another machine points at that machine's folder: fix it
CUR=$(grep -E '^SHOP_PATH=' .env | cut -d= -f2- | sed 's/ *#.*//')
if [ -n "$CUR" ] && [ ! -d "$CUR" ]; then
  python3 - "$SHOP" <<'PY'
import re, sys
s = open(".env").read()
s = re.sub(r"^SHOP_PATH=.*$", f"SHOP_PATH={sys.argv[1]}", s, count=1, flags=re.M)
open(".env", "w").write(s)
PY
  echo "  SHOP_PATH fixed for this machine"
fi
set_env SHOP_PATH "$SHOP"
grep -q '^REPO_ROOT=' .env || echo "REPO_ROOT=" >> .env
CUR_ROOT=$(grep -E '^REPO_ROOT=' .env | cut -d= -f2-)
if [ -n "$CUR_ROOT" ] && [ ! -d "$CUR_ROOT" ]; then sed -i.bak "s#^REPO_ROOT=.*#REPO_ROOT=#" .env && rm -f .env.bak; fi
set_env REPO_ROOT "$(cd "$SHOP/.." && pwd)"
set_env OPS_MCP_TOKEN "$(openssl rand -hex 24)"
set_env SHOP_DB_ADMIN_PASSWORD "$(grep -E '^POSTGRES_PASSWORD=' "$SHOP/.env" | cut -d= -f2)"

step "Python environment"
PY=$(command -v python3.12 || command -v python3.13 || command -v python3)
# a .venv copied from another machine does not work here: rebuild it
if [ -d .venv ] && ! ./.venv/bin/python -c "import fastapi, trueforge_sdk" >/dev/null 2>&1; then
  echo "  existing .venv is not usable on this machine, rebuilding"
  rm -rf .venv
fi
[ -d .venv ] || "$PY" -m venv .venv
./.venv/bin/pip install -q -r requirements.txt
echo "venv ready ($(./.venv/bin/python -V))"

step "Shop settings NightShift needs"
mkdir -p "$SHOP/.nightshift/payment-lb"
[ -f "$SHOP/.nightshift/payment-lb/upstream.conf" ] || \
  printf 'upstream payment_backends {\n    server payment:50051 weight=100;\n}\n' > "$SHOP/.nightshift/payment-lb/upstream.conf"
grep -q "^PAYMENT_ADDR=payment-lb" "$SHOP/.env.override" || \
  printf '\n# NightShift: checkout reaches payment through payment-lb (canary traffic split).\nPAYMENT_ADDR=payment-lb:50051\n' >> "$SHOP/.env.override"

step "Start the shop (31 containers)"
"$SHOP/shop.sh" start >/dev/null
echo "shop running at http://localhost:8080"

step "Start NightShift services (ops-mcp, payment-lb, postgres, redis)"
docker compose up -d --build

cat <<'MSG'

== Done. Next:
  1. ./scripts/start-trueforge.sh                (keep it running; open http://localhost:8790)
     In TrueForge Settings add: a model provider, Daytona sandbox, GitHub connector, Jira connector.
  2. ./.venv/bin/python scripts/setup_trueforge.py   (registers the ops server and all 13 agents)
  3. ./.venv/bin/uvicorn control.app:app --port 8090 (dashboard at http://localhost:8090)
  Details: SETUP.md
MSG
