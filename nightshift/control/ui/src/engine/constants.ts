// The map keeps the geometry of the original dashboard: supervisor at the hub, agents on a ring, systems around it.
export const VIEW = { w: 1200, h: 800 };
export const HUB = { x: 600, y: 400 };
export const RING = 282;
export const NODE_R = 42;
export const HUB_R = 64;

export type AgentId =
  | "triage" | "diagnosis" | "validation" | "plan" | "mitigation" | "verify" | "fix"
  | "test" | "pr" | "review" | "cicd" | "postmortem" | "docs";

export const AGENTS: { id: AgentId; label: string; model: string }[] = [
  { id: "triage", label: "Triage", model: "MiniMax" },
  { id: "diagnosis", label: "Diagnosis", model: "Kimi" },
  { id: "validation", label: "Validation", model: "Kimi" },
  { id: "plan", label: "Planner", model: "Kimi" },
  { id: "mitigation", label: "Mitigation", model: "MiniMax" },
  { id: "verify", label: "Verify", model: "Kimi" },
  { id: "fix", label: "Coder", model: "Kimi" },
  { id: "test", label: "Tester", model: "Kimi" },
  { id: "pr", label: "Pull request", model: "Kimi" },
  { id: "review", label: "Reviewer", model: "Kimi" },
  { id: "cicd", label: "CI/CD · canary", model: "Kimi" },
  { id: "postmortem", label: "Postmortem", model: "MiniMax" },
  { id: "docs", label: "Docs research", model: "Kimi" },
];

/** The pipeline order shown in the stage rail (docs is an on-demand helper, not a step). */
export const PIPELINE: AgentId[] = [
  "triage", "diagnosis", "validation", "plan", "mitigation", "verify", "fix", "test", "pr", "review", "cicd", "postmortem",
];

/** The four kinds of work. Each owns one arc of the ring, next to the systems it works with:
 *  understand by the watcher and live system, stop-the-damage under on-call, fix-for-good by GitHub and the sandbox. */
export const CATEGORIES: { id: string; label: string; hint: string; agents: AgentId[] }[] = [
  { id: "contain", label: "Stop the damage", hint: "every change waits for you", agents: ["plan", "mitigation", "verify"] },
  { id: "fix", label: "Fix for good", hint: "sandbox, then a pull request", agents: ["fix", "test", "pr", "review", "cicd"] },
  { id: "learn", label: "Learn", hint: "so next time is faster", agents: ["postmortem", "docs"] },
  { id: "understand", label: "Understand", hint: "what broke and why", agents: ["triage", "diagnosis", "validation"] },
];
export const CATEGORY_OF: Record<string, string> = Object.fromEntries(CATEGORIES.flatMap((c) => c.agents.map((a) => [a, c.id])));

/** Agents sit on the ring grouped by category, with a gap between categories; one gap is centred at the top,
 *  under on-call, so no agent covers it. Angles in degrees, SVG orientation (0 = right, 90 = down). */
const GAP = 0.5;      // between categories, in agent slots
const TOP_GAP = 1.4;  // the gap under on-call (Understand → Stop the damage), wider so no agent sits below it
const STEP = 360 / (AGENTS.length + GAP * (CATEGORIES.length - 1) + TOP_GAP);
export const ARCS: { id: string; label: string; hint: string; from: number; to: number; agents: AgentId[] }[] = [];
export const POS: Record<string, { x: number; y: number }> = {};
{
  let cursor = 270 + (TOP_GAP * STEP) / 2;
  for (const c of CATEGORIES) {
    const from = cursor;
    for (const id of c.agents) {
      const a = (Math.PI / 180) * (cursor + STEP / 2);
      POS[id] = { x: HUB.x + RING * Math.cos(a), y: HUB.y + RING * Math.sin(a) };
      cursor += STEP;
    }
    ARCS.push({ ...c, from, to: cursor });
    cursor += GAP * STEP;
  }
}
POS.supervisor = HUB;

export type SystemKey = "watcher" | "shop" | "human" | "github" | "sandbox" | "harness";
export const SYSTEMS: Record<SystemKey, { x: number; y: number; w: number; h: number; label: string; sub: string }> = {
  watcher: { x: 24, y: 110, w: 204, h: 64, label: "Watcher", sub: "always on · no AI · ₹0" },
  shop: { x: 24, y: 368, w: 204, h: 64, label: "Live system", sub: "logs · metrics · traces · docker" },
  human: { x: 498, y: 14, w: 204, h: 64, label: "On-call · Jira", sub: "approves every change" },
  github: { x: 972, y: 210, w: 204, h: 64, label: "GitHub", sub: "commits · branches · PRs" },
  sandbox: { x: 972, y: 500, w: 204, h: 64, label: "Daytona sandbox", sub: "runs the agents’ code" },
  harness: { x: 972, y: 716, w: 204, h: 64, label: "TrueForge harness", sub: "sub-agents · tool search" },
};

export function nodePoint(id: string): { x: number; y: number } {
  const s = SYSTEMS[id as SystemKey];
  if (s) return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
  return POS[id] || HUB;
}

const OPS_TOOLS = new Set([
  "list_services", "get_error_rates", "get_metrics", "query_logs", "get_traces", "get_trace", "get_recent_deploys", "get_flags",
  "run_sql_readonly", "synthetic_check", "rollback", "deploy", "deploy_canary", "promote_canary", "abort_canary",
  "restart_service", "scale_service", "set_flag",
]);
export function systemFor(tool: string | undefined): SystemKey {
  const t = String(tool || "");
  if (OPS_TOOLS.has(t)) return "shop";
  if (t === "notify" || /jira|confluence|atlassian/i.test(t)) return "human";
  if (/pull_request|commit|branch|file_contents|push_files|repository|search_code|merge|issue|release|tag/.test(t)) return "github";
  if (/sandbox|exec|shell|bash|command|write_file|read_file|run_code|python|terminal/i.test(t)) return "sandbox";
  return "harness";
}

export const WHO: Record<string, string> = {
  triage: "triage", diagnosis: "diagnosis", validation: "validation", plan: "planner", mitigation: "mitigation", verify: "verify",
  fix: "coder", test: "tester", pr: "pull request", review: "reviewer", cicd: "ci/cd", postmortem: "postmortem", docs: "docs",
};
export const who = (st?: string | null) => (st && WHO[st]) || st || "system";

export const UNDO: Record<string, string> = {
  rollback: "Undo by deploying again, or roll back to another commit.",
  deploy: "Undo with rollback: the previous image is back in seconds.",
  deploy_canary: "Undo with abort_canary: all traffic goes back to the main version.",
  promote_canary: "Undo with rollback.",
  set_flag: "Undo by setting the flag back to its old value.",
  restart_service: "A restart changes no code or data.",
  scale_service: "Undo by scaling back to 1.",
  create_pull_request: "Undo by closing the pull request.",
  merge_pull_request: "Undo by reverting the merge, then rolling back.",
  notify: "Messages cannot be unsent.",
};

export const USD_INR = 88;

export const INFO: Record<string, string> = {
  supervisor: "Reads every agent's latest answer and picks the next move. Code guardrails can overrule it.",
  triage: "Confirms the alert is real, sets severity and category, and picks the path.",
  diagnosis: "Finds the root cause with parallel sub-agents over logs, traces, commits and past incidents.",
  validation: "Tries to disprove the cause by reproducing the bug with a failing test in a sandbox.",
  plan: "Proposes fixes with risk and blast radius, then picks the safest one.",
  mitigation: "Stops the damage with the most reversible action. Every change waits for a person.",
  verify: "Checks that the live system really recovered after a change.",
  fix: "Writes the smallest code fix and runs the tests in a sandbox.",
  test: "Runs the fix and its tests again in a clean sandbox.",
  pr: "Opens the pull request with the fix. Waits for approval.",
  review: "Reviews the fix like a senior engineer and comments on the pull request.",
  cicd: "Merges after CI, ships a 10% canary, compares it, then promotes or aborts.",
  postmortem: "Writes the blameless postmortem and notifies the team.",
  docs: "Finds official docs for a third-party provider and saves them for the others.",
  watcher: "Plain rules on Prometheus metrics every 5 seconds. No AI, so it costs nothing while quiet.",
  shop: "The live Astronomy Shop: 31 containers. Agents read logs, metrics and traces and change it only through the ops server.",
  human: "The on-call engineer. Approves or denies every change here or with /approve on Jira.",
  github: "The shop's repository: commits to blame, branches and pull requests for fixes.",
  sandbox: "Daytona sandboxes where agents clone the repo and run the tests they write.",
  harness: "TrueForge runs every agent: sessions, sub-agents, tool search and the approval pause.",
};
