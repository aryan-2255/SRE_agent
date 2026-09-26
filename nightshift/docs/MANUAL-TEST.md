# Test NightShift yourself: break the shop, watch the agents fix it

Two ways to cause the incident: the **ready-made bug** (one command) or **your own bug** (you edit the code). Both go through the same agents.

## 0. Everything running?

From `truforge_hackthon/nightshift`:

```bash
../astronomy-shop/shop.sh status          # ~31 containers; if not: ../astronomy-shop/shop.sh start
docker compose up -d                      # ops-mcp, payment-lb, postgres, redis
./scripts/nightshift.sh start             # TrueForge + NightShift, restarted automatically if they crash
./scripts/nightshift.sh status
```

Check before you start:

| Check | Where | Expect |
|---|---|---|
| Shop works | http://localhost:8080 → buy something | Order placed |
| Dashboard | http://localhost:8090 | Watcher on, every service green |
| Agents loaded | http://localhost:8790 → Agents | 14 `ns-*` agents |
| Ops tools | `./.venv/bin/python scripts/mcp_call.py synthetic_check '{"flow":"checkout"}'` | `"passed": true` |

The shop must be clean (`git -C ../astronomy-shop status` shows no changes) or deploys refuse to run.

**Daytona disk:** the free quota is 30 GiB and each incident makes 4–6 sandboxes. TrueForge now deletes them 30 minutes after they stop, but if an agent reports "Total disk limit exceeded", delete old sandboxes at https://app.daytona.io → Sandboxes.

## 1a. Ready-made bug (fastest)

```bash
./chaos/prebuild.sh             # once: bad commit on branch demo/payment-bug + its image (~1 min)
./chaos/break.sh payment-bug    # puts the commit on the fork's main, pushes it, deploys it
```

The commit "refactor(payment): stricter amount validation" rejects any price with cents, so most checkouts fail with HTTP 422.

## 1b. Your own bug

Pick a small change that breaks real requests, not the build. Example in the payment service:

```bash
cd ../astronomy-shop
# edit src/payment/charge.js line 86, the card-expiry check. Change
#   if ((currentYear * 12 + currentMonth) > (year * 12 + month)) {
# to
#   if (year > currentYear) {
# Now every card that expires in a future year is called "expired", so most checkouts fail.
git commit -am "fix(payment): simplify expiry check"
git push origin main            # the agents read commits from GitHub, so push
cd ../nightshift
./.venv/bin/python scripts/mcp_call.py deploy '{"service":"payment"}'
```

`deploy` builds an image from the current commit, tags it `nightshift/payment:<sha>` and records it in the deploy history, which is how the agents connect the errors to your commit. Building payment takes about a minute.

Other ideas: `src/checkout` (Go) and `src/cart` (C#) also work, but the sandbox has no Go or .NET, so the validator can only reason from code there. Node (payment) and Python (recommendation) get real tests.

## 2. Watch

| What | Where |
|---|---|
| The board: every agent as a strip, the one working pulled out; click a strip to see its answer, evidence and every tool call | http://localhost:8090 |
| Each agent's full conversation and tool calls | http://localhost:8790 → Sessions |
| Ticket, plan, approvals | Jira project SRE: https://aryanmatrixx.atlassian.net/jira/software/projects/SRE/boards |
| Branch and pull request | https://github.com/aryan-2255/opentelemetry-demo/pulls |
| Errors in graphs | http://localhost:8080/grafana/ |
| Failing requests | http://localhost:8080/jaeger/ui/ (service `payment`) |

What should happen. Times are from our test run on 26 Sep (INC-004/005), measured from the moment the bug went live:

| # | Step | Time | You do |
|---|---|---|---|
| 1 | **Detect**: payment errors above 5% for 30 s | ~40 s | — |
| 2 | **Triage → diagnosis**: names the bad commit from deploy history, logs and traces | ~1.5 min | — |
| 3 | **Validation**: clones the fork in a Daytona sandbox, writes a test that fails on the bad commit and passes on its parent | ~1 min | — |
| 4 | **Plan** + Jira ticket (SRE-n) | ~3 min | — |
| 5 | **Mitigation**: rollback to the last good image (~10 s) | | Approve rollback |
| 6 | **Verify**: errors back to 0%, synthetic checkout passes → dashboard shows *mitigated* | ~1 min | — |
| 7 | **Fix**: coder patches the code in a sandbox and adds a regression test | ~1.5 min | — |
| 8 | **Test**: tester runs the service's tests in a fresh sandbox | ~1.5 min | — |
| 9 | **PR**: branch `nightshift/INC-xxx-…`, commit, pull request on the fork | ~1 min | Approve create_branch, push_files, create_pull_request |
| 10 | **Review**: reviewer reads the diff and posts a review on the PR | ~30 s | — |
| 11 | **CI/CD**: merge, build the merged commit, canary at 10%, compare, promote | ~3 min | Approve merge, deploy_canary, promote_canary |
| 12 | **Postmortem** to Jira and the dashboard → *resolved* | ~30 s | — |

About 15–20 minutes end to end and about $3 of model usage. The model API sometimes stalls for 5 minutes; the stage then retries on its own and continues where it stopped.

You can **deny** any approval (dashboard or `/deny <reason>` on Jira). The supervisor then picks another move or escalates to you. Escalation is a normal outcome, not a crash: it happens when something outside the agents' control breaks (a full sandbox quota, a failing build) and it never ships untested code. Its reason is on the dashboard and the Jira ticket, and you take over from there (e.g. `./.venv/bin/python scripts/mcp_call.py promote_canary '{"service":"payment"}'`).

Things worth trying once the happy path works:

- **Deny the rollback** on Jira: the supervisor must find another mitigation or escalate.
- **Deny the merge**: nothing reaches production, the incident stays mitigated by the rollback.
- **Make the bug subtle** (wrong result, no error): only the synthetic checkout catches it.

## 3. Clean up

```bash
./chaos/fix.sh                  # flags off, payment back on its baseline image, payment code reset to pre-demo
git -C ../astronomy-shop push origin main
```

`fix.sh` resets `src/payment` to its pre-demo code whatever happened since (the demo bug, the agents' merged fix, or your own change), so the next `break.sh payment-bug` applies cleanly. It only touches `src/payment`: if you broke another service, revert your commit there yourself.

## If something goes wrong

| Symptom | Cause / fix |
|---|---|
| No incident after 2 min | Check http://localhost:8090 → System: the watcher must be on. Prometheus needs a minute after a Docker restart. |
| Agent stuck on an approval | It waits for you. Approve on the dashboard or `/approve` on Jira. |
| "Outbound URL blocked" in TrueForge | Start it with `scripts/start-trueforge.sh`. |
| Deploy says "uncommitted changes" | Commit or stash in `astronomy-shop/` first. |
| Incident escalated | Read the supervisor's reason in the dashboard timeline: a limit (attempts, steps, or the budget `INCIDENT_BUDGET_USD`, default $5) or something outside the agents' reach. |
| "Total disk limit exceeded" | Daytona quota full: delete old sandboxes at https://app.daytona.io. |
| "Headers Timeout Error" / "429 Too many requests" | Bedrock stalled or rate-limited; the stage retries by itself (the supervisor falls back to rule-based choices). Nothing to do unless it repeats every stage. |
