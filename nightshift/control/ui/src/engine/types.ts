export type Mode = "idle" | "live" | "replay" | "view";
export type NodeState = "running" | "waiting" | "done" | "failed" | "skipped";

export interface NsEvent {
  id?: number;
  incident_id: string | null;
  ts: string;
  stage: string | null;
  kind: string;
  text: string;
  data: Record<string, any>;
}

export interface Incident {
  id: string;
  system: string;
  service: string;
  severity: string | null;
  category: string | null;
  status: string;
  stage: string | null;
  opened_at: string;
  resolved_at: string | null;
  jira_key: string | null;
  jira_url?: string | null;
  pr_url: string | null;
  total_cost_usd: string | number;
  summary: string | null;
  trigger?: Record<string, any> | null;
  events?: NsEvent[];
  approvals?: Approval[];
  stages?: any[];
}

export interface Approval {
  id: number;
  stage: string;
  tool: string;
  args: any;
  status: string;
}

export interface ServiceTile {
  rps: number;
  error_pct: number;
  limit_pct: number;
  over: boolean;
  over_for_s: number;
  fires_after_s: number;
}

export interface Synthetic {
  flow: string;
  passed: boolean;
  failed_step: { step: string; detail?: string } | null;
  steps: { step: string; ok: boolean; status: number | null; ms: number; detail: string }[];
}

export interface WatchData {
  services: Record<string, ServiceTile>;
  synthetic: Synthetic | null;
  ts?: number | null;
}

export interface FeedItem {
  key: string;
  stage: string | null;
  tone: "bad" | "sup" | "agent" | "human" | "sys" | "ask" | "back";
  who: string;
  msg: string;
  ts: string;
  link?: { href: string; label: string };
}

export interface EvidenceItem {
  key: string;
  source: string;
  tool: string;
  stage: string | null;
  ts: string;
  items: any;
}

export interface NowLine {
  tone: "idle" | "alert" | "agent" | "sup" | "tool" | "human" | "done" | "stop";
  who?: string;
  text: string;
  detail?: string;
}

export interface Pending {
  id: number;
  stage: string;
  tool: string;
  args: any;
}

export interface State {
  mode: Mode;
  connected: boolean;
  watch: WatchData | null;
  history: Record<string, number[]>;
  inc: Incident | null;
  events: NsEvent[];
  status: Record<string, NodeState | undefined>;
  runs: Record<string, number>;
  tools: Record<string, number>;
  toolTotal: number;
  t0: number | null;
  tEnd: number | null;
  lastTs: number | null;
  sats: Record<string, string[]>;
  pending: Pending[];
  costUsd: number;
  now: NowLine;
  feed: FeedItem[];
  evidence: EvidenceItem[];
  hubThinking: boolean;
  hot: Record<string, number>;
  incidents: Incident[];
}

export type Fx =
  | { type: "pulse"; from: string; to: string; tone?: "route" | "tool" | "talk"; dur?: number; bend?: number }
  | { type: "flash"; from: string; to: string }
  | { type: "talk"; from: string; to: string; text: string };
