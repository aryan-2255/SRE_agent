# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

NightShift control service: Python FastAPI serving a static dashboard from `nightshift/control/web` (today vanilla HTML, CSS and an SVG-drawing JavaScript file, fed by `/api/*` and a server-sent event stream at `/api/stream`). Decided on 2026-09-26: the dashboard moves to React (Vite build served by FastAPI) so React Bits, Amicro and VengeanceUI components can be used.

## Users

- The on-call engineer who watches an incident and approves or denies every production change (dashboard buttons or `/approve` on Jira).
- Hackathon judges and viewers of the demo video who must understand, in seconds, what the agents are doing and why.

## Product Purpose

NightShift is an on-call team of AI agents on TrueForge. A rules-only watcher opens an incident; a supervisor agent routes work between 13 specialist agents (triage, diagnosis, validation, planner, mitigation, verify, coder, tester, pull request, reviewer, CI/CD canary, postmortem, docs); every production change pauses for a human. The dashboard is the operations room: it shows the live system, the agents working, the conversation, the evidence they read, the approval requests, cost and time.

## Positioning

Built for the TrueFoundry x Polaris "Agents That Act" hackathon (Bengaluru, 26 September 2026). The dashboard is the main thing shown in the demo video.

## Operating Context

- Primary use for this redesign: a screen recording for the demo video (resolution to confirm; assumption until then: 1920x1080), plus live use on a laptop.
- Incidents last minutes; the screen changes every few seconds while agents work, and sits idle otherwise.

## Capabilities and Constraints

- Must keep the central agent network (supervisor hub, ring of agents, the systems they reach: watcher, live system, on-call/Jira, GitHub, Daytona sandbox, TrueForge harness) and its animations, with the same information. Only its styling may change.
- Must keep all information currently shown: watcher services with error %, rps and limit; synthetic customer steps; tool traffic; incident id, status, severity, summary, Jira and PR links; cost in rupees; elapsed time; mode (watching, live, replay); replay; conversation (who decided what and why); evidence (logs, traces, metrics, commits); approval request with approve, deny and reason; timeline; drawer with incidents, connections and the system file.
- Figma account is Starter plan with a View seat (about 20 MCP calls a month): Figma work must be batched.

## Brand Commitments

- Name: NightShift. The crescent-moon mark exists today. (Assumption: no other brand assets exist.)
- Money is shown in rupees (INR) first.

## Evidence on Hand

Real incident data in the local database (INC-001: payment flag incident resolved with a human approval; supervisor decisions, tool calls and evidence recorded). Screenshots of the current dashboard.

## Product Principles

- Show what the agents actually did: real tool output and evidence, never decoration standing in for data.
- A human approves every change; the approval moment must be impossible to miss.
- Readable from across a room and in a compressed video.

## Accessibility & Inclusion

WCAG AA contrast for text; `prefers-reduced-motion` path for every animation; keyboard access to approve, deny, replay and the drawer.
