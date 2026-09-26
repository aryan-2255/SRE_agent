# Instructions for the coding agent: make this dashboard primary, then port the missing features into it

You are integrating the React dashboard in `nightshift/control/ui` into NightShift. Two dashboards exist:

- **This one** (`control/ui`, React): the agent network around the supervisor, with the interaction and motion the team wants for the demo. **It is the primary dashboard.** Keep its design.
- **The strip board** (`control/web`, vanilla JS, commit `4c55e4c`): added in parallel. It has functionality this one lacks. **Port that functionality into this dashboard, in this dashboard's design.** Do not copy the strip board's look (its palette, Atkinson font, strips layout).

Keep `control/web` in the repo as the fallback until every item in the checklist below is done; then ask the team before deleting it.

## 1. Build and run

```bash
cd nightshift/control/ui && npm ci && npm run build      # writes dist/
cd ../.. && ./.venv/bin/uvicorn control.app:app --port 8090
```

`control/app.py` already serves `control/ui/dist` at `/` when it exists (otherwise `control/web`). For work, `npm run dev` gives hot reload on http://localhost:5173 with `/api` proxied to :8090.

Read `control/ui/README.md` first: code layout, color meanings, motion rules, demo helpers.

## 2. How this dashboard works (what to extend, not rewrite)

- `src/engine/engine.ts` is the only place events turn into screen state. `apply(event, animate)` handles one event from `/api/stream`; `goLive`, `replay`, `stopReplay`, `togglePause` handle modes. Add new event kinds here, in the same style: build the next state `d`, call `say()` for the conversation, `now()` for the "now" line, `this.fx()` for map animation, `this.toast()` for toasts.
- `src/engine/types.ts` holds the state shape; add fields there first.
- `src/engine/focus.ts`: hovering previews an agent or system, clicking pins it. The map, stage rail, conversation, evidence and timeline all read it. Use it to open the agent detail panel (item 3).
- Components read state with `useEngine()` and style only with tokens (`bg-panel`, `text-ink-2`, `var(--amber)` …) so dark and light both work.

## 3. Functionality to port (from `control/web/app.js` at `4c55e4c`)

Each item names the data source. Build it in this dashboard's components and tokens.

1. **Sign-in for approvals.** `POST /api/approvals/{id}`, `/api/demo/*` and `/api/test-incident` now decide *who* on the server: a token from `DASHBOARD_USERS`, or localhost only. `GET /api/me` returns `{name, mode}`. On a 401, ask for the token, store it (`localStorage.ns_token` and cookie `ns_token`), and send `Authorization: Bearer <token>` on those POSTs (`engine.decide`). Show the signed-in name in the header. Drop the `by` field from the approval body (the server ignores it now).
2. **Approval context in the sign-off card** (`RightColumn.tsx` → `Approval`). `approval.requested` carries `data.context`: `service`, `live {error_pct, limit_pct, failed_requests}`, `diagnosis`, `plan_option {risk, reversible, blast_radius, speculative, evidence}`, `undo`, plus `data.undo`. Add rows: *Right now* (live error rate, red when over the limit), *Why* (diagnosis), *Planner says* (risk, reversible, blast radius; a clear "guess, no evidence" tag when `speculative`), *To undo*. Store `context` on the `Pending` item in `engine.ts`. A deny keeps its reason.
3. **Agent detail panel.** Clicking an agent on the map (or its lane or stage) pins it; open a slide-over panel like `Drawer.tsx` with: status, model tier and tools and "asks you before" (from `GET /api/agents`), runs and total time, cost per agent (`stage.done` `data.cost_usd`), sandbox yes or no, the TrueForge session link (`stage.session` `data.url`), **its answer** (`stage.done` `data.output`: summary, key fields with readable labels, and the planner's options table with the chosen row and speculative tags), and **what it did**: every tool call with its arguments and its output (`tool.result` `data.result`, matched to the latest open call of the same tool), sandbox commands (`tool.call` with `tool === "exec"`, show `args.intent`), `evidence.unverified` warnings, `stage.waiting` notes, approvals asked and decided.
4. **Supervisor panel.** Clicking the hub shows its decisions: `supervisor.decision` `data.by` is `"rules"` or `"supervisor"`, `data.asked_because` says why the AI was consulted, `data.url` links to its reasoning. Show counts (decisions, needed judgement, clear next steps).
5. **New events in `engine.ts`:** `tool.result`, `evidence.unverified` (conversation line in red, and a marker on that agent), `stage.waiting`, `approval.reminder` (toast plus a conversation line), `incident.resumed`. On `incident.resolved/escalated/closed`, mark any running or waiting agent as interrupted.
6. **Watcher upgrades** (`LeftColumn.tsx`). The watch data now has `blind {reason}` (show a red "monitoring is blind" banner across the top when present), per service `state` (`over`, `quiet`, ok), `op {name, error_pct, failed_requests}` (the endpoint that is failing; show it under the service), and `signals {name: {value, over, above, explain}}` (queue signals; add a compact list). Sort services by over first, then error %.
7. **Team tab** in the drawer, from `GET /api/agents`: job, model tier, asks you before, runs code in a sandbox.
8. **Deep links and following.** Support `#INC-008` and `#INC-008/diagnosis` (open the incident and pin that agent) next to the existing `#replay-…` and `#view-…`. Add a "follow the live agent" toggle that pins whichever agent is running.
9. `GET /api/incidents?limit=40` for the incident list.

## 4. Keep

- The map geometry (`HUB`, `RING`, `SYSTEMS`, agent order in `constants.ts`) and its animations. Style may change; positions and information stay.
- One meaning per color: green working, **amber only for a human**, red failing, blue data, `--sup` the supervisor. No new accent colors.
- Motion: `transform` and `opacity` only, ease-out `cubic-bezier(0.23, 1, 0.32, 1)`, a `prefers-reduced-motion` fallback for every loop.
- Replay helpers used for the demo video: `#replay-INC-001`, `?speed=N`, Space to pause, the hold on approvals.

## 5. Check before you finish

- `npx tsc -b && npm run build` with no errors.
- Open http://localhost:8090 at **1280×800, 1440×900 and 1920×1080**, in `?theme=dark` and `?theme=light`: nothing cut off, no console errors. Short screens use height media queries (`[@media(max-height:899px)]:…`); `max-[…]` is a width breakpoint.
- Replay an incident with an approval (`/#replay-INC-001`) and pause on the sign-off card: every context row from item 2 is there.
- Approve a real approval from the dashboard with and without `DASHBOARD_USERS` set.
- Optional: `impeccable detect --json src` (the Impeccable design detector) reports nothing.

## 6. Notes

- Tested against backend `4c55e4c` with incident replays; not yet tested with `DASHBOARD_USERS` set.
- The Figma file (https://www.figma.com/design/pI6oIjN06MJzB4M10DWMv0) was only a first sketch. The React code is the source of truth.
- `PRODUCT.md` at the repo root holds product facts for design tools.
