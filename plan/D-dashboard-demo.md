# Workstream D — dashboard, chaos scripts, evals, README, demo

Paste everything below the line into Claude account **D**, started in `truforge_hackthon/nightshift/`.

---

You are building **workstream D of NightShift**, an on-call AI agent team for the TrueFoundry × Polaris "Agents That Act" hackathon. First read `../plan/00-CONTRACTS.md` completely. It is the source of truth for names, ports, schemas and interfaces. The architecture page is https://claude.ai/artifact/DZTegNgebksC8Lov1zRkZU; match its look and wording.

## Your job

Everything the judges see: the live dashboard, the scripts that break and fix the shop on cue, the evals scorecard, the README, and the demo run-sheet. The demo gets about 3 minutes, so speed and clarity matter more than features.

## 1. Dashboard (`control/web/`, served by B's FastAPI at `http://localhost:8090`)

Plain HTML + CSS + vanilla JS (no build step). Reads `GET /api/*` and the SSE stream `GET /api/stream` (contracts section 9). Until B's API is ready, build against a `mock-stream.js` that replays a recorded incident.

Pages:
- **Incidents (home, the demo screen)**
  - Top: live tiles per watched service from `/api/watch` (error %, p95, rps) with a clear red state when over threshold. A "quiet" state that says the watcher is running at ₹0.
  - Current incident: title, severity, service, elapsed time, running cost in ₹ and $.
  - **Pipeline strip**: triage → diagnosis → validation → plan → Jira → mitigation → verify → fix → test → PR → review → CI/CD → canary → postmortem. Each lights up (pending / running / waiting for approval / done / failed / skipped). Loops show as a retry counter on the stage.
  - **Live feed**: plain-language lines from SSE events, newest on top. `evidence` events render as cards showing the **real log lines / trace steps / commit** verbatim with a source badge (OpenSearch, Jaeger, GitHub, Prometheus) and an "Open in Jaeger / GitHub" link. This is how judges see the agent read the logs.
  - **Approval card** when `approval.requested`: tool, arguments, what it changes, how to undo, Jira link, and Approve / Deny buttons (`POST /api/approvals/{id}`).
  - Each stage links to its TrueForge session (`http://localhost:8790` session page; find the URL pattern in the TrueForge UI).
  - "Real users affected": count of failing real-user requests (from `evidence` where `demo.payment.charged=true` or no synthetic baggage).
- **Morning report**: resolved incidents with what happened overnight, what was done automatically, what waits for approval (the "Good morning" story).
- **Connections**: `/api/connections` as a checklist with status dots.
- **Systems**: shows `systems/astronomy-shop.yaml` as readable cards (services, thresholds, autonomy policy).
Style: same palette and fonts as the architecture page; must read well on a projector (large type on the incident screen).

## 2. Chaos scripts (`chaos/`)

Demo speed needs pre-built images so breaking takes seconds.

- `prebuild.sh`: for each scenario, create the bad commit on a branch in `../astronomy-shop` (never on main), build its image, tag it `nightshift/<svc>:bad-<scenario>`, switch back to main. Also tag the current good image `nightshift/<svc>:baseline`.
- `break.sh <scenario>`:
  - `payment-bug`: cherry-pick the prepared bad commit onto `main` of the fork and **push it** (so GitHub shows the culprit), then retag `nightshift/payment:bad-payment-bug` as the compose image and `up -d --no-deps payment`. Must take < 15 s.
  - `cart-bug`: same idea for an add-to-cart bug in `frontend` (TypeScript), e.g. rejects quantity > 1.
  - `ai-runaway`: set flagd `aiRunawayAgent` on.
  - `payment-flag`: set flagd `paymentFailure` to 50%.
  - `pii-leak`: set flagd `emitRawPii` on.
  - `blip`: one single failed request (to show the watcher does **not** fire).
- `fix.sh`: restore baseline images and flags, `git revert` any demo commits on the fork (keeps history honest), confirm with a synthetic check.
- Payment bug to prepare (realistic "refactor"): in `src/payment/charge.js`, a stricter amount validation that throws `Invalid amount` whenever the amount has a fractional part (most prices do), so most but not all checkouts fail. Commit message: `refactor(payment): stricter amount validation`.
- Coordinate with A: the deploy/rollback tag names must match.

## 3. Evals (`evals/`)

`run_evals.py` runs each scenario end to end through `control` (break → wait for incident → let the pipeline run with auto-approve in eval mode → fix) and scores:
correct service, correct category, correct root cause (keyword match on commit / flag), path taken (full vs revert vs escalate), time to mitigation, total cost, and "did not fire" for `blip`. Output `evals/scorecard.md` and a JSON file the dashboard can show.

## 4. README and repo polish

- `README.md` for judges: one-paragraph pitch, the architecture page link and a screenshot, how the three hackathon requirements are met (with where to see each), setup in ≤ 10 commands, the agents table (link to `agents/README.md`), the universal onboarding file, cost story, safety model, evals scorecard, and **AI tools used** (Claude Code on 4 accounts, plus any others). Credits: design inspired by Bhavishya Pandit's SRE-agent talk at a Google event; target system OpenTelemetry Astronomy Shop (Apache-2.0).
- `.gitignore`: `.env`, `.data/`, `*.sqlite`, `__pycache__`, `node_modules`.
- `Makefile`: `up`, `down`, `trueforge`, `setup`, `demo`, `evals`.

## 5. Demo run-sheet (`docs/DEMO.md`)

Three-minute script matching the architecture page's demo section: public QR link → judge adds to cart / checks out → `break.sh payment-bug` 2–3 minutes before judges arrive → dashboard shows evidence + red sandbox test → `/approve` on Jira → recovery → PR → TrueForge Sessions. Include a fallback path if Wi-Fi fails (screen recording) and the exact terminal windows to have open.

## Done when

- The dashboard runs a full recorded incident from the mock stream, then a real one from B's API.
- `break.sh payment-bug` breaks checkout within 15 s and `fix.sh` restores it; both leave the fork history clean and readable.
- `evals/scorecard.md` exists with real numbers.
- README lets a stranger run the project.

Commit small and often. Never commit `.env`, tokens or screenshots that show keys.
