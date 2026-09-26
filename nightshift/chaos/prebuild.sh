#!/usr/bin/env bash
# Prepare demo scenarios ahead of time so breaking the shop on stage takes seconds.
# Creates the bad commit on a local branch (never on main) and builds its image.
set -euo pipefail
cd "$(dirname "$0")/.."
source .env
SHOP="$SHOP_PATH"
IMG=ghcr.io/open-telemetry/demo:latest-payment

cd "$SHOP"
git diff --quiet || { echo "Shop repo has uncommitted changes; commit them first." >&2; exit 1; }

# remember the healthy image once
docker image inspect nightshift/payment:baseline >/dev/null 2>&1 || docker tag "$IMG" nightshift/payment:baseline

# the bad commit lives on its own branch
git branch -f demo/payment-bug main
git worktree add -f /tmp/ns-payment-bug demo/payment-bug >/dev/null
python3 "$OLDPWD/chaos/patches/payment-bug.py" /tmp/ns-payment-bug
git -C /tmp/ns-payment-bug commit -qam "refactor(payment): stricter amount validation"
BAD_SHA=$(git -C /tmp/ns-payment-bug rev-parse --short HEAD)
docker build -q -t "nightshift/payment:bad-payment-bug" -f /tmp/ns-payment-bug/src/payment/Dockerfile /tmp/ns-payment-bug >/dev/null
git worktree remove --force /tmp/ns-payment-bug
echo "payment-bug ready: commit $BAD_SHA on branch demo/payment-bug, image nightshift/payment:bad-payment-bug"
