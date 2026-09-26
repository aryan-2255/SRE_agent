#!/usr/bin/env bash
# Put the shop back to healthy after a demo: flags off, baseline payment image, payment code reset.
set -euo pipefail
cd "$(dirname "$0")/.."
source .env
SHOP="$SHOP_PATH"
for f in paymentFailure aiRunawayAgent emitRawPii; do
  ./.venv/bin/python scripts/mcp_call.py set_flag "{\"flag\":\"$f\",\"variant\":\"off\"}" >/dev/null || true
done
cd "$SHOP"
# payment's code goes back to what it was before any demo (the demo bug, an agent's fix, or your own change)
BASE=$(git rev-parse -q --verify "demo/payment-bug^" || true)
if [ -n "$BASE" ] && ! git diff --quiet "$BASE" HEAD -- src/payment; then
  git checkout "$BASE" -- src/payment
  git diff --name-only --diff-filter=A "$BASE" HEAD -- src/payment | xargs -r git rm -q --
  git commit -qm "chore(demo): reset payment to its pre-demo code" -- src/payment
  echo "Reset src/payment to its pre-demo code on main (push it with: git push origin main)"
fi
docker tag nightshift/payment:baseline ghcr.io/open-telemetry/demo:latest-payment
docker compose -p astronomy-shop --env-file .env --env-file .env.override -f compose.yaml -f compose.full.yaml \
  -f compose.observability.yaml -f compose.extras.yaml -f compose.agent.yaml up -d --no-deps --force-recreate payment >/dev/null
echo "Shop restored: flags off, payment on its baseline image."
