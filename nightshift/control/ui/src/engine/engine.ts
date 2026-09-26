import { POS, SYSTEMS, USD_INR, systemFor, who } from "./constants";
import type { EvidenceItem, FeedItem, Fx, Incident, Mode, NowLine, NsEvent, Pending, State, WatchData } from "./types";

export type Toast = { tone: "alert" | "human" | "done" | "stop"; title: string; body?: string };

const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** TrueForge wraps deferred tool calls as call_tool({tool_name, input}); show the real tool to the human. */
export function unwrapCall(tool: string, args: any): { tool: string; args: any; server?: string } {
  let a = args;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { /* keep string */ } }
  if (tool === "call_tool" && a && typeof a === "object" && a.tool_name) {
    return { tool: a.tool_name, args: a.input ?? {}, server: a.mcp_server };
  }
  return { tool, args: a };
}

function fresh(): Omit<State, "mode" | "connected" | "watch" | "history" | "incidents"> {
  return {
    inc: null, events: [], status: {}, runs: {}, tools: {}, toolTotal: 0, t0: null, tEnd: null, lastTs: null,
    sats: {}, pending: [], costUsd: 0, feed: [], evidence: [], hubThinking: false, hot: {},
    now: { tone: "idle", text: "The watcher is running. It opens an incident only when a problem is large, real and lasting." },
  };
}

class Engine {
  state: State = { mode: "idle", connected: false, watch: null, history: {}, incidents: [], ...fresh() };
  private listeners = new Set<() => void>();
  private fxListeners = new Set<(f: Fx) => void>();
  private toastListeners = new Set<(t: Toast) => void>();
  private replayTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private started = false;
  speed = 6;
  paused = false;

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.state;
  onFx(fn: (f: Fx) => void) { this.fxListeners.add(fn); return () => { this.fxListeners.delete(fn); }; }
  onToast(fn: (t: Toast) => void) { this.toastListeners.add(fn); return () => { this.toastListeners.delete(fn); }; }

  private commit(next: State) { this.state = next; this.listeners.forEach((l) => l()); }
  private patch(p: Partial<State>) { this.commit({ ...this.state, ...p }); }
  private fx(f: Fx) { if (!reduceMotion) this.fxListeners.forEach((l) => l(f)); }
  private toast(t: Toast) { this.toastListeners.forEach((l) => l(t)); }
  get replaying() { return this.replayTimer !== null; }

  // ---------------- watcher ----------------
  applyWatch(w: WatchData | null) {
    if (!w || !w.services || this.state.mode === "replay") return;
    const history = { ...this.state.history };
    for (const [name, s] of Object.entries(w.services)) {
      const h = [...(history[name] || []), s.error_pct];
      if (h.length > 60) h.shift();
      history[name] = h;
    }
    const hot = { ...this.state.hot };
    if (Object.values(w.services).some((s) => s.over)) hot.watcher = Date.now() + 5200;
    this.patch({ watch: w, history, hot });
  }

  // ---------------- one event ----------------
  apply(e: NsEvent, animate: boolean) {
    if (e.kind === "watcher.tick") { this.applyWatch(e.data as WatchData); return; }
    const d: State = { ...this.state, events: [...this.state.events, e] };
    const ts = e.ts || new Date().toISOString();
    d.lastTs = Date.parse(ts);
    const st = e.stage || "";
    const x = e.data || {};
    const say = (tone: FeedItem["tone"], whoName: string, msg: string, link?: FeedItem["link"]) => {
      d.feed = [{ key: `f${this.seq++}`, stage: e.stage, tone, who: whoName, msg, ts, link }, ...d.feed].slice(0, 80);
    };
    const now = (n: NowLine) => { d.now = n; };
    const hot = (key: string, ms = 900) => {
      d.hot = { ...d.hot, [key]: Date.now() + ms };
      setTimeout(() => this.patch({ hot: { ...this.state.hot } }), ms + 30);
    };
    const setNode = (id: string, s: State["status"][string]) => { d.status = { ...d.status, [id]: s }; };

    switch (e.kind) {
      case "incident.opened":
        d.t0 = Date.parse(ts);
        if (animate) { hot("watcher", 2000); this.fx({ type: "pulse", from: "watcher", to: "triage", dur: 900 }); }
        say("bad", "watcher", e.text);
        now({ tone: "alert", who: "alert", text: e.text });
        if (animate && d.mode !== "replay") this.toast({ tone: "alert", title: `${e.incident_id} opened`, body: e.text.replace(/^INC-\d+:\s*/, "") });
        break;
      case "stage.started":
        d.runs = { ...d.runs, [st]: (d.runs[st] || 0) + 1 };
        setNode(st, "running");
        if (animate) this.fx({ type: "pulse", from: st === "triage" ? "watcher" : "supervisor", to: st, dur: 700 });
        now({ tone: "agent", who: who(st), text: d.runs[st] > 1 ? `started, run ${d.runs[st]}` : "started" });
        break;
      case "stage.session":
        if (st === "supervisor") d.hubThinking = true;
        break;
      case "supervisor.decision": {
        d.hubThinking = false;
        const dec = x.decision || {};
        if (animate && dec.stage && POS[dec.stage]) this.fx({ type: "pulse", from: "supervisor", to: dec.stage, dur: 650 });
        say("sup", "supervisor", e.text);
        now({ tone: "sup", who: "supervisor", text: e.text });
        break;
      }
      case "supervisor.overruled":
        d.hubThinking = false;
        say("bad", "guardrail", e.text);
        break;
      case "tool.call": {
        const tool = String(x.tool || "tool");
        const real = tool === "call_tool" ? (unwrapCall(tool, safeJson(x.args)).tool) : tool;
        const sys = systemFor(real);
        d.tools = { ...d.tools, [real]: (d.tools[real] || 0) + 1 };
        d.toolTotal = d.toolTotal + 1;
        if (animate && POS[st]) {
          this.fx({ type: "flash", from: st, to: sys });
          this.fx({ type: "pulse", from: st, to: sys, tone: "tool", dur: 600, bend: 0.12 });
          hot(sys);
        }
        now({ tone: "tool", who: who(st), text: `called ${real}`, detail: `on ${SYSTEMS[sys].label}` });
        break;
      }
      case "subagent":
        d.sats = { ...d.sats, [st]: [...(d.sats[st] || []), x.title || "sub-agent"] };
        say("agent", who(st), `started a parallel sub-agent: ${x.title || ""}`);
        if (animate) this.fx({ type: "pulse", from: st, to: "harness", tone: "tool", dur: 700, bend: 0.1 });
        break;
      case "sandbox":
        if (animate && POS[st]) { this.fx({ type: "flash", from: st, to: "sandbox" }); hot("sandbox", 1500); }
        say("sys", "sandbox", `${who(st)} started a Daytona sandbox`);
        break;
      case "stage.done":
        setNode(st, "done");
        say("agent", who(st), e.text);
        if (animate && POS[st]) this.fx({ type: "pulse", from: st, to: "supervisor", dur: 650 });
        break;
      case "stage.failed":
        setNode(st, "failed");
        say("bad", who(st), e.text);
        break;
      case "stage.retry":
        say("bad", who(st), e.text);
        break;
      case "stage.skipped":
        if (!d.status[st]) setNode(st, "skipped");
        break;
      case "approval.requested": {
        setNode(st, "waiting");
        const c = unwrapCall(String(x.tool || ""), x.args);
        d.pending = [...d.pending, { id: x.approval_id, stage: st, tool: c.tool, args: c.args }];
        if (animate) { this.fx({ type: "pulse", from: st, to: "human", tone: "talk", dur: 800, bend: 0.1 }); hot("human", 3000); }
        say("human", `${who(st)} → on-call`, `asks permission to run ${c.tool} ${JSON.stringify(c.args || {})}`);
        now({ tone: "human", who: "waiting", text: `${who(st)} needs your approval to run ${c.tool}`, detail: describeArgs(c.args) });
        if (animate) this.toast({ tone: "human", title: `Approval needed: ${c.tool}`, body: `${who(st)} wants to change production. ${describeArgs(c.args)}` });
        break;
      }
      case "approval.decided":
        d.pending = d.pending.filter((p) => p.id !== x.approval_id);
        if (d.status[st] === "waiting") setNode(st, "running");
        if (animate) this.fx({ type: "pulse", from: "human", to: st, tone: "talk", dur: 700, bend: 0.1 });
        say("human", `on-call · ${x.via || "?"}`, e.text.replace(/^call_tool /, ""));
        break;
      case "agent.question":
      case "agent.sendback":
        if (animate && POS[x.from] && POS[x.to]) this.fx({ type: "talk", from: x.from, to: x.to, text: x.message || "" });
        say(e.kind === "agent.question" ? "ask" : "back", `${x.from} → ${x.to}`, x.message || e.text);
        break;
      case "agent.answer":
        say("agent", `${who(st)} · answer`, (x.answer && x.answer.summary) || e.text);
        break;
      case "evidence":
        d.evidence = [{ key: `e${this.seq++}`, source: x.source, tool: x.tool, stage: e.stage, ts, items: x.items } as EvidenceItem, ...d.evidence].slice(0, 30);
        break;
      case "cost":
        d.costUsd = Number(x.total_usd || 0);
        break;
      case "jira":
        if (d.inc) d.inc = { ...d.inc, jira_key: x.key, jira_url: x.url };
        if (animate) { this.fx({ type: "pulse", from: "plan", to: "human", tone: "talk", dur: 700 }); hot("human", 1500); }
        say("sys", "jira", e.text, x.url ? { href: x.url, label: "Open ticket" } : undefined);
        break;
      case "incident.mitigated":
        if (d.inc) d.inc = { ...d.inc, status: "mitigated" };
        say("agent", "incident", e.text);
        now({ tone: "done", who: "recovered", text: e.text });
        if (animate) this.toast({ tone: "done", title: "Service recovered", body: e.text });
        break;
      case "incident.resolved":
      case "incident.escalated":
      case "incident.closed": {
        d.tEnd = Date.parse(ts);
        d.hubThinking = false;
        const status = ({ "incident.resolved": "resolved", "incident.escalated": "escalated", "incident.closed": "false_alarm" } as const)[e.kind];
        if (d.inc) d.inc = { ...d.inc, status };
        say(e.kind === "incident.resolved" ? "agent" : "bad", "incident", e.text);
        now({ tone: e.kind === "incident.resolved" ? "done" : "stop", who: e.kind === "incident.resolved" ? "resolved" : "stopped", text: e.text });
        if (animate) this.toast({ tone: e.kind === "incident.resolved" ? "done" : "stop", title: e.kind === "incident.resolved" ? `${e.incident_id} resolved` : `${e.incident_id} ${status.replace("_", " ")}`, body: e.text });
        break;
      }
      case "incident.symptom":
        say("sys", "watcher", e.text);
        break;
    }
    this.commit(d);
  }

  // ---------------- incidents ----------------
  private reset(mode: Mode, inc: Incident | null) {
    this.commit({ ...this.state, ...fresh(), mode, inc, t0: inc ? Date.parse(inc.opened_at) : null });
  }

  async refreshIncidents() {
    try { this.patch({ incidents: await getJson<Incident[]>("/api/incidents") }); } catch { /* offline */ }
    return this.state.incidents;
  }

  async goLive(id: string) {
    this.stopReplay();
    const inc = await getJson<Incident>(`/api/incidents/${id}`).catch(() => null);
    if (!inc) return;
    const active = ["open", "mitigated"].includes(inc.status);
    this.reset(active ? "live" : "view", inc);
    for (const e of inc.events || []) this.apply(e, false);
    const pending: Pending[] = (inc.approvals || []).filter((a) => a.status === "pending").map((a) => {
      const c = unwrapCall(a.tool, a.args);
      return { id: a.id, stage: a.stage, tool: c.tool, args: c.args };
    });
    const tEnd = inc.resolved_at ? Date.parse(inc.resolved_at) : !active ? this.state.lastTs : null;
    this.patch({ pending, costUsd: Number(inc.total_cost_usd || 0), tEnd, inc: { ...inc, events: undefined } });
  }

  async replay(id: string) {
    this.stopReplay();
    const inc = await getJson<Incident>(`/api/incidents/${id}`).catch(() => null);
    if (!inc) return;
    const evs = (inc.events || []).filter((e) => e.kind !== "watcher.tick");
    this.reset("replay", { ...inc, events: undefined, status: "open", jira_key: null, jira_url: null, pr_url: null });
    let i = 0;
    const next = () => {
      if (this.paused) { this.replayTimer = setTimeout(next, 120); return; }
      if (i >= evs.length) { this.replayTimer = null; this.patch({ mode: "view" }); return; }
      const e = evs[i++];
      this.apply(e, true);
      const gap = i < evs.length ? Date.parse(evs[i].ts) - Date.parse(e.ts) : 0;
      // the human sign-off is the moment worth reading: hold it on screen
      const hold = e.kind === "approval.requested" ? 4200 : 0;
      this.replayTimer = setTimeout(next, Math.max(90, hold, Math.min(1400, gap / this.speed)));
    };
    this.replayTimer = setTimeout(next, 250);
    this.patch({});
  }

  togglePause() {
    if (!this.replaying) return;
    this.paused = !this.paused;
    this.patch({});
  }

  stopReplay() {
    this.paused = false;
    if (this.replayTimer) clearTimeout(this.replayTimer);
    const was = this.replayTimer !== null;
    this.replayTimer = null;
    if (was) this.patch({ mode: "idle" });
  }

  async replayLatest() {
    const rows = await this.refreshIncidents();
    const target = rows.find((i) => i.status === "resolved") || rows.find((i) => i.status === "escalated") || rows[0];
    if (target) await this.replay(target.id);
    else this.patch({ now: { tone: "idle", text: "No incidents to replay yet." } });
  }

  async decide(id: number, decision: "approve" | "deny", reason = "") {
    await fetch(`/api/approvals/${id}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, reason, by: "dashboard" }),
    });
  }

  // ---------------- stream ----------------
  start() {
    if (this.started) return;
    this.started = true;
    const q = new URLSearchParams(location.search);
    const sp = Number(q.get("speed"));
    if (sp > 0) this.speed = sp;
    this.connect();
    getJson<WatchData>("/api/watch").then((w) => this.applyWatch(w)).catch(() => {});
    this.refreshIncidents().then((rows) => {
      const h = location.hash;
      if (h.startsWith("#replay")) {
        const id = h.slice(8);
        if (id) this.replay(id); else this.replayLatest();
        return;
      }
      if (h.startsWith("#view-")) { this.goLive(h.slice(6)); return; }
      const active = rows.find((i) => ["open", "mitigated"].includes(i.status));
      if (active) this.goLive(active.id);
    });
  }

  private connect() {
    const es = new EventSource("/api/stream");
    es.addEventListener("hello", (m) => { this.patch({ connected: true }); this.applyWatch(JSON.parse((m as MessageEvent).data).watch); });
    es.addEventListener("message", async (m) => {
      const e: NsEvent = JSON.parse((m as MessageEvent).data);
      if (e.kind === "watcher.tick") { this.applyWatch(e.data as WatchData); return; }
      const s = this.state;
      if (e.kind === "incident.opened" && e.incident_id !== s.inc?.id && s.mode !== "replay") {
        await this.goLive(e.incident_id!);
        this.toast({ tone: "alert", title: `${e.incident_id} opened`, body: e.text.replace(/^INC-\d+:\s*/, "") });
        this.refreshIncidents();
        return;
      }
      if ((s.mode === "live" || s.mode === "view") && e.incident_id === s.inc?.id) {
        this.apply(e, true);
        if (["stage.done", "jira", "incident.resolved", "incident.escalated"].includes(e.kind)) {
          const inc = await getJson<Incident>(`/api/incidents/${e.incident_id}`).catch(() => null);
          if (inc && this.state.inc?.id === inc.id) {
            this.patch({ inc: { ...this.state.inc, status: inc.status, severity: inc.severity, category: inc.category, jira_key: inc.jira_key, jira_url: inc.jira_url, pr_url: inc.pr_url, summary: inc.summary } });
          }
          this.refreshIncidents();
        }
      }
    });
    es.onerror = () => this.patch({ connected: false });
    es.onopen = () => this.patch({ connected: true });
  }
}

export function describeArgs(args: any): string {
  if (!args || typeof args !== "object") return args ? String(args) : "";
  return Object.entries(args).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ");
}
function safeJson(v: any) { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } }
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export const inr = (usd: number) => usd * USD_INR;
export const engine = new Engine();
