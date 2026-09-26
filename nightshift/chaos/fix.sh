#!/usr/bin/env bash
# Put the shop back to healthy after a demo: flags off, baseline payment image, demo commit reverted.
set -euo pipefail
cd "$(dirname "$0")/.."
source .env
SHOP="$SHOP_PATH"
for f in paymentFailure aiRunawayAgent emitRawPii; do
  ./.venv/bin/python scripts/mcp_call.py set_flag "{\"flag\":\"$f\",\"variant\":\"off\"}" >/dev/null || true
done
cd "$SHOP"
if git log -1 --pretty=%s | grep -q "stricter amount validation"; then
  git revert --no-edit HEAD >/dev/null && echo "Reverted the demo commit on main (push it with: git push origin main)"
fi
docker tag nightshift/payment:baseline ghcr.io/open-telemetry/demo:latest-payment
docker compose -p astronomy-shop --env-file .env --env-file .env.override -f compose.yaml -f compose.full.yaml \
  -f compose.observability.yaml -f compose.extras.yaml -f compose.agent.yaml up -d --no-deps --force-recreate payment >/dev/null
echo "Shop restored: flags off, payment on its baseline image."
