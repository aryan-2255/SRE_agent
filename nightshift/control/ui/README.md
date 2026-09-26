# NightShift dashboard (React)

> Integrating this with the strip board in `control/web`? Start with [INTEGRATION.md](INTEGRATION.md).

The operations room for NightShift: the agent network around the supervisor, the watcher, the approval card, the conversation, the evidence and the timeline. React 19 + Vite + Tailwind v4 + Motion. Built files in `dist/` are served by the control service at `/`; without a build, `control/web` (the static page) is served instead.

```bash
cd nightshift/control/ui
npm ci
npm run dev        # http://localhost:5173, proxies /api to the control service on :8090
npm run build      # writes dist/, which FastAPI serves at http://localhost:8090
```

`scripts/bootstrap.sh` runs `npm ci && npm run build` when npm is installed.

## Layout of the code

| Path | What it is |
|---|---|
| `src/engine/engine.ts` | The event engine: one `apply(event)` per server-sent event, live / replay / view / idle modes, replay timing, approvals, toasts. The single source of truth for what the screen shows. |
| `src/engine/constants.ts` | Agents, the map geometry (hub, ring, systems), tool-to-system mapping, agent descriptions, undo hints. |
| `src/engine/types.ts` | Types for incidents, events, watcher data, feed and evidence items. |
| `src/engine/focus.ts` | Hover previews and click pins the focused agent or system; shared by the map, stage rail, feeds and timeline. |
| `src/components/NetworkMap.tsx` | The agent network (SVG). State rings, spokes, the approval link to on-call, and an imperative effects layer for pulses, flashes and talk lines. |
| `src/components/CenterStage.tsx` | Map panel, legend, hover card, the "now" line. |
| `src/components/Header.tsx` | Incident, status, elapsed, cost, mode, theme, replay (Space pauses), menu. |
| `src/components/StageRail.tsx` | The 12 pipeline stages and progress. |
| `src/components/LeftColumn.tsx` | Watcher services, synthetic customer, tool traffic. |
| `src/components/RightColumn.tsx` | Approval card, conversation, evidence. |
| `src/components/Timeline.tsx` | One lane per agent; block length is the exact time it worked. |
| `src/components/Drawer.tsx` | Incidents, the team (from `/api/agents`), connections, system file. |
| `src/components/AgentPanel.tsx` | Click an agent, its stage or lane, or the supervisor hub: status, model, tools, what it asks you before, cost and time, its answer (options, evidence checked or not), and every tool call with its output. The supervisor's panel lists each decision and whether the rules or the AI made it. |
| `src/components/vendor/` | Adapted open-source pieces: CountUp (React Bits), BorderBeam (VengeanceUI), IconSwap (Amicro). MIT, credited in each file. |
| `src/index.css` | Design tokens for the dark and light themes, and the motion keyframes. |

## Rules that keep it consistent

- **One meaning per color:** green `--go` working or healthy, amber `--amber` a human is needed (nothing else is amber), red `--red` failing, blue `--data` tool calls and data, `--sup` the supervisor. Text on colored meaning uses the `-ink` variant (readable on light).
- **Style only through tokens** (`bg-panel`, `text-ink-2`, `var(--line)` …), so both themes stay correct. Themes: `?theme=light|dark`, or the header toggle.
- **Motion explains state** (routing, tool calls, a new message, the approval). Animate `transform` and `opacity` only; ease-out `cubic-bezier(0.23,1,0.32,1)`; every loop has a `prefers-reduced-motion` fallback in `index.css`.
- **The map geometry is fixed** (`HUB`, `RING`, `SYSTEMS`, agent order). Change styling, not positions.
- **Check three sizes in both themes** before merging: 1280×800, 1440×900, 1920×1080. Use height media queries (`[@media(max-height:899px)]:…`) for short screens; `max-[…]` is a width breakpoint.

## Demo helpers

- `/#replay-INC-001` replays an incident; `/#view-INC-001` opens it finished; `/#INC-001/diagnosis` opens it with that agent's panel.
- "Follow the live agent" (map header) keeps the panel on whichever agent is working.
- `?speed=3` slows a replay (default 6× faster than real time); Space pauses and resumes.
- A replay holds about four seconds on every approval request.
