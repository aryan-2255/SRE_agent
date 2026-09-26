#!/usr/bin/env bash
# Break the shop on cue. Usage: chaos/break.sh <scenario> [--no-push]
#   payment-bug   ship the prepared bad payment commit (pushed to the fork so GitHub shows the culprit)
#   payment-flag  paymentFailure 50% (feature flag, no code)
#   ai-runaway    the shop's AI assistant loops on tool calls
#   pii-leak      card numbers leak into telemetry
#   blip          one failed request (the watcher must NOT fire)
set -euo pipefail
cd "$(dirname "$0")/.."
source .env
SHOP="$SHOP_PATH"
flag() { ./.venv/bin/python scripts/mcp_call.py set_flag "{\"flag\":\"$1\",\"variant\":\"$2\"}"; }

case "${1:-}" in
  payment-bug)
    cd "$SHOP"
    git diff --quiet -- . || { echo "The shop folder has uncommitted changes" >&2; exit 1; }
    git cherry-pick -x "$(git rev-parse demo/payment-bug)" >/dev/null
    SHA=$(git rev-parse --short HEAD)
    [ "${2:-}" = "--no-push" ] || git push -q origin main
    docker tag nightshift/payment:bad-payment-bug "nightshift/payment:$SHA"
    docker tag "nightshift/payment:$SHA" ghcr.io/open-telemetry/demo:latest-payment
    python3 - "$SHOP/.nightshift/deploys.json" "$SHA" <<'PY'
import json, sys, datetime, pathlib
p = pathlib.Path(sys.argv[1]); h = json.loads(p.read_text()) if p.exists() else []
h.append({"time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "action": "deploy",
          "service": "payment", "commit": sys.argv[2], "image": f"nightshift/payment:{sys.argv[2]}", "by": "developer"})
p.write_text(json.dumps(h, indent=1))
PY
    docker compose -p astronomy-shop --env-file .env --env-file .env.override -f compose.yaml -f compose.full.yaml \
      -f compose.observability.yaml -f compose.extras.yaml -f compose.agent.yaml up -d --no-deps --force-recreate payment >/dev/null
    echo "Deployed bad commit $SHA to payment. Checkouts with cents in the price now fail."
    ;;
  payment-flag) flag paymentFailure 50% ;;
  ai-runaway)   flag aiRunawayAgent on ;;
  pii-leak)     flag emitRawPii on ;;
  blip)         curl -s -o /dev/null -w "one bad request: HTTP %{http_code}\n" "http://localhost:8080/api/products/NOT-A-PRODUCT" ;;
  *) sed -n 2,8p "$0"; exit 1 ;;
esac
