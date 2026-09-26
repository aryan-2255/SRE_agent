import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Play } from "@phosphor-icons/react";
import NetworkMap, { type Hover } from "./NetworkMap";
import { engine } from "../engine/engine";
import { useEngine } from "../engine/useEngine";
import { AGENTS, INFO, SYSTEMS, WHO, systemFor, type SystemKey } from "../engine/constants";
import { mmss, ease } from "../lib/format";

function Legend() {
  const Dot = ({ c, ring }: { c: string; ring?: boolean }) => (
    <span className="inline-block size-2.5 rounded-full" style={ring ? { boxShadow: `inset 0 0 0 2px ${c}` } : { background: c }} />
  );
  const Bar = ({ c }: { c: string }) => <span className="inline-block h-[3px] w-4 rounded-full" style={{ background: c }} />;
  const items: [React.ReactNode, string][] = [
    [<Dot c="var(--go)" />, "working"], [<Dot c="var(--amber)" />, "needs a human"], [<Dot c="var(--go)" ring />, "done"],
    [<Dot c="var(--red)" />, "failed"], [<Bar c="var(--sup)" />, "supervisor routing"], [<Bar c="var(--data)" />, "tool call"],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12.5px] text-muted">
      {items.map(([i, l]) => <span key={l} className="inline-flex items-center gap-2">{i}{l}</span>)}
    </div>
  );
}

/** Pins whichever agent is working, so its panel follows the incident. */
function FollowToggle() {
  const s = useEngine();
  return (
    <button onClick={() => engine.setFollow(!s.follow)} aria-pressed={s.follow}
      className="ml-auto inline-flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-semibold transition-colors duration-150 hairline hover:bg-panel-3"
      style={{ color: s.follow ? "var(--go-ink)" : "var(--ink-2)", background: s.follow ? "var(--go-soft)" : undefined }}>
      <span className="size-2 rounded-full" style={{ background: s.follow ? "var(--go)" : "var(--dim)" }} />
      Follow the live agent
    </button>
  );
}

function HoverCard({ h }: { h: NonNullable<Hover> }) {
  const s = useEngine();
  const stats = useMemo(() => {
    let tools = 0, spent = 0, last = "", decisions = 0, lastDecision = "";
    const byTool: Record<string, number> = {};
    const agentsHere = new Set<string>();
    let callsHere = 0;
    const starts: Record<string, number> = {};
    for (const e of s.events) {
      const t = Date.parse(e.ts);
      if (e.kind === "stage.started" && e.stage === h.id) starts[h.id] = t;
      if ((e.kind === "stage.done" || e.kind === "stage.failed") && e.stage === h.id) { if (starts[h.id]) spent += t - starts[h.id]; last = e.text; delete starts[h.id]; }
      if (e.kind === "tool.call") {
        const tool = String(e.data?.tool || "");
        if (e.stage === h.id) { tools++; byTool[tool] = (byTool[tool] || 0) + 1; }
        if (systemFor(tool) === h.id) { callsHere++; if (e.stage) agentsHere.add(e.stage); }
      }
      if (e.kind === "supervisor.decision") { decisions++; lastDecision = e.text; }
    }
    if (starts[h.id]) spent += (s.lastTs || Date.now()) - starts[h.id];
    const top = Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { tools, spent, last, top, agentsHere: [...agentsHere], callsHere, decisions, lastDecision };
  }, [s.events, s.lastTs, h.id]);

  const agent = AGENTS.find((a) => a.id === h.id);
  const sys = SYSTEMS[h.id as SystemKey];
  const st = s.status[h.id];
  const title = agent?.label || sys?.label || "Supervisor";
  const sub = agent?.model || (h.kind === "supervisor" ? "Kimi K3" : "system");
  const W = 320;
  const left = Math.min(h.x + 18, window.innerWidth - W - 16);
  const top = Math.min(h.y + 18, window.innerHeight - 250);
  const stateLabel = st ? ({ running: "working", waiting: "needs you", done: "done", failed: "failed", skipped: "skipped", interrupted: "cut off" } as const)[st] : h.kind === "agent" ? "idle" : "";

  return (
    <motion.div initial={{ opacity: 0, scale: 0.96, y: 4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", duration: 0.28, bounce: 0 }}
      className="pointer-events-none fixed z-50 rounded-2xl bg-panel p-4" style={{ left, top, width: W, boxShadow: "var(--shadow-lift)", transformOrigin: "top left" }}>
      <div className="flex items-baseline gap-2">
        <span className="text-[16px] font-semibold">{title}</span>
        <span className="text-[12.5px] text-muted">{sub}</span>
        {stateLabel && <span className="ml-auto text-[12px] font-semibold"
          style={{ color: st === "waiting" ? "var(--amber-ink)" : st === "failed" ? "var(--red-ink)" : st ? "var(--go-ink)" : "var(--dim)" }}>{stateLabel}</span>}
      </div>
      <p className="m-0 mt-1.5 text-[13px] leading-[1.45] text-ink-2">{INFO[h.id]}</p>
      {h.kind === "agent" && (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[["runs", String(s.runs[h.id] || 0)], ["tool calls", String(stats.tools)], ["time", stats.spent ? mmss(stats.spent) : "—"]].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-panel-2 px-2.5 py-2 hairline">
                <div className="font-mono text-[16px] font-medium">{v}</div>
                <div className="text-[11px] text-muted">{k}</div>
              </div>
            ))}
          </div>
          {stats.top.length > 0 && <div className="mt-2.5 flex flex-wrap gap-1.5">{stats.top.map(([t, n]) => (
            <span key={t} className="rounded-md bg-panel-3 px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2">{t} ×{n}</span>))}</div>}
          {stats.last && <p className="m-0 mt-2.5 line-clamp-3 text-[12.5px] leading-[1.45] text-muted">“{stats.last}”</p>}
        </>
      )}
      {h.kind === "system" && (
        <p className="m-0 mt-2.5 text-[12.5px] text-muted">
          {stats.callsHere ? <>{stats.callsHere} tool calls from {stats.agentsHere.map((a) => WHO[a] || a).join(", ")}</> : "No agent has touched it in this incident."}
        </p>
      )}
      {h.kind === "supervisor" && (
        <p className="m-0 mt-2.5 line-clamp-3 text-[12.5px] text-muted">
          {stats.decisions ? <>{stats.decisions} decisions. Latest: {stats.lastDecision}</> : "No decisions yet in this incident."}
        </p>
      )}
      <p className="m-0 mt-2 text-[11px] text-dim">{h.kind === "system" ? "Click to pin the conversation and evidence to it." : "Click to open everything it did."}</p>
    </motion.div>
  );
}

const TONE_COLOR: Record<string, string> = { idle: "var(--go)", alert: "var(--red)", agent: "var(--go)", sup: "var(--sup)", tool: "var(--data)", human: "var(--amber)", done: "var(--go)", stop: "var(--red)" };

function NowBar() {
  const s = useEngine();
  const n = s.now;
  const c = TONE_COLOR[n.tone];
  const latest = s.incidents.find((i) => i.status === "resolved") || s.incidents[0];
  return (
    <div className="flex h-16 shrink-0 items-center gap-3 border-t border-line px-5">
      <span className="relative inline-flex size-2.5 shrink-0">
        {n.tone !== "idle" && <span className="ns-ping absolute inset-0 rounded-full" style={{ background: c }} />}
        <span className="relative size-2.5 rounded-full" style={{ background: c }} />
      </span>
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.p key={n.text + (n.who || "")} className="m-0 flex min-w-0 items-baseline gap-2 text-[16px]"
            initial={{ opacity: 0, y: 12, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -12, filter: "blur(6px)" }} transition={{ duration: 0.3, ease }}>
            {n.who && <span className="shrink-0 font-semibold" style={{ color: n.tone === "human" ? "var(--amber-ink)" : n.tone === "alert" || n.tone === "stop" ? "var(--red-ink)" : "var(--ink)" }}>{n.who}</span>}
            <span className="truncate text-ink-2">{n.text}</span>
            {n.detail && <span className="shrink-0 text-[14px] text-muted">{n.detail}</span>}
          </motion.p>
        </AnimatePresence>
      </div>
      {s.mode === "idle" && !s.inc && latest && (
        <button onClick={() => engine.replay(latest.id)}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3.5 text-[13.5px] font-semibold text-ink transition-colors duration-150 hairline hover:bg-panel-3 active:scale-[0.97]">
          <Play size={14} weight="fill" />Replay {latest.id}
        </button>
      )}
    </div>
  );
}

export default function CenterStage() {
  const [hover, setHover] = useState<Hover>(null);
  return (
    <section className="panel flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-4 px-5 pt-4">
        <h2 className="m-0 shrink-0 whitespace-nowrap text-[15px] font-semibold">Agent network</h2>
        <Legend />
        <FollowToggle />
      </div>
      <div className="relative min-h-0 flex-1 px-2">
        <NetworkMap onHover={setHover} />
      </div>
      <NowBar />
      <AnimatePresence>{hover && <HoverCard key={hover.id} h={hover} />}</AnimatePresence>
    </section>
  );
}
