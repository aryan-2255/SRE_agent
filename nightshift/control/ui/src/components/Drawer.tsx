import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Play, Eye } from "@phosphor-icons/react";
import { engine, inr } from "../engine/engine";
import { useEngine } from "../engine/useEngine";
import { Pill } from "./Header";
import { ease } from "../lib/format";

type View = "incidents" | "connections" | "system";
const TONE: Record<string, string> = { open: "red", mitigated: "go", resolved: "go", escalated: "red", false_alarm: "muted" };

function Incidents({ close }: { close: () => void }) {
  const s = useEngine();
  useEffect(() => { engine.refreshIncidents(); }, []);
  if (!s.incidents.length) return <p className="text-[14px] text-muted">No incidents yet. The watcher opens one when a service stays over its limit.</p>;
  return (
    <ul className="m-0 list-none space-y-2 p-0">
      {s.incidents.map((i, idx) => (
        <motion.li key={i.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(idx, 8) * 0.03, duration: 0.3, ease }}
          className="group rounded-2xl bg-panel-2 p-4 transition-shadow duration-200 hairline hover:shadow-[inset_0_0_0_1px_var(--line-2)]">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[15px] font-semibold">{i.id}</span>
            <Pill tone={TONE[i.status] || "muted"}>{i.status.replace("_", " ")}</Pill>
            <span className="text-[13px] text-muted">{i.service}</span>
            <span className="ml-auto font-mono text-[13px] text-ink-2">₹{inr(Number(i.total_cost_usd || 0)).toFixed(2)}</span>
          </div>
          <p className="m-0 mt-2 line-clamp-2 text-[13.5px] text-ink-2">{i.summary}</p>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-[12px] text-dim">{new Date(i.opened_at).toLocaleString()}</span>
            <button onClick={() => { close(); engine.goLive(i.id); }}
              className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold text-ink-2 transition-colors hairline hover:bg-panel-3 hover:text-ink">
              <Eye size={14} />View
            </button>
            <button onClick={() => { close(); engine.replay(i.id); }}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 active:scale-[0.97]">
              <Play size={13} weight="fill" />Replay
            </button>
          </div>
        </motion.li>
      ))}
    </ul>
  );
}

function Connections() {
  const [c, setC] = useState<any>(null);
  useEffect(() => { fetch("/api/connections").then((r) => r.json()).then(setC).catch(() => setC({ error: true })); }, []);
  if (!c) return <div className="grid grid-cols-2 gap-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[74px] animate-pulse rounded-2xl bg-panel-3" />)}</div>;
  const tf = c.trueforge || {};
  const rows: [string, boolean, string, boolean?][] = [
    ["TrueForge", !!tf.ok, `v${tf.detail || "?"} · ${tf.model_providers ?? 0} model provider · ${(tf.agents || []).length} agents`],
    ...Object.entries(tf.mcp_servers || {}).map(([n, st]) => [`MCP · ${n}`, st === "authenticated" || st === "not_required", String(st), st === "auth_required"] as [string, boolean, string, boolean]),
    ["Ops server (live)", !!c.ops_mcp?.ok, c.ops_mcp?.detail || ""],
    ["Prometheus", !!c.prometheus?.ok, c.prometheus?.ok ? "ready" : c.prometheus?.detail || "down"],
    ["Jira approvals", !!c.jira?.ok, String(c.jira?.detail ?? ""), !c.jira?.ok],
    ["Slack", !!c.slack?.ok, c.slack?.detail || "", !c.slack?.ok],
  ];
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {rows.map(([n, ok, d, warn]) => {
          const col = ok ? "var(--go)" : warn ? "var(--amber)" : "var(--red)";
          return (
            <div key={n} className="rounded-2xl bg-panel-2 p-3.5 hairline">
              <div className="flex items-center gap-2 text-[14px] font-semibold"><span className="size-2 rounded-full" style={{ background: col }} />{n}</div>
              <div className="mt-1 truncate text-[12.5px] text-muted" title={d}>{d}</div>
            </div>
          );
        })}
      </div>
      {tf.agents && <p className="mt-4 text-[12.5px] text-muted">Agents: {(tf.agents as string[]).join(", ")}</p>}
    </>
  );
}

function SystemFile() {
  const [sys, setSys] = useState<any>(null);
  useEffect(() => { fetch("/api/system").then((r) => r.json()).then(setSys).catch(() => {}); }, []);
  return (
    <>
      <p className="m-0 text-[13.5px] text-ink-2">Everything NightShift knows about this system comes from one onboarding file, <code className="text-ink">systems/{sys?.name || "…"}.yaml</code>. Another system needs another file, not new agent code.</p>
      <pre className="scroll mt-3 max-h-[70vh] overflow-auto rounded-2xl bg-panel-2 p-4 font-mono text-[12.5px] leading-[1.6] text-ink-2 hairline">{sys ? JSON.stringify(sys, null, 2) : "Loading…"}</pre>
    </>
  );
}

export default function Drawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [view, setView] = useState<View>("incidents");
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const tabs: [View, string][] = [["incidents", "Incidents"], ["connections", "Connections"], ["system", "System file"]];
  return (
    <AnimatePresence>
      {open && (
        <motion.div key="drawer" className="fixed inset-0 z-40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          <div className="absolute inset-0 bg-black/40" onClick={onClose} />
          <motion.aside role="dialog" aria-label="Incidents, connections and system file"
            className="absolute top-0 right-0 bottom-0 flex w-[560px] max-w-[92vw] flex-col bg-panel"
            style={{ boxShadow: "var(--shadow-lift)" }}
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", duration: 0.45, bounce: 0 }}>
            <div className="flex items-center gap-1 border-b border-line px-4 pt-3">
              {tabs.map(([v, l]) => (
                <button key={v} onClick={() => setView(v)} className="relative px-3 pt-1.5 pb-3 text-[14px] font-semibold transition-colors"
                  style={{ color: view === v ? "var(--ink)" : "var(--muted)" }}>
                  {l}
                  {view === v && <motion.span layoutId="drawer-tab" className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-ink" transition={{ duration: 0.3, ease }} />}
                </button>
              ))}
              <button onClick={onClose} aria-label="Close" className="ml-auto mb-2 grid size-9 place-items-center rounded-lg text-muted transition-colors hover:bg-panel-3 hover:text-ink">
                <X size={18} />
              </button>
            </div>
            <div className="scroll min-h-0 flex-1 overflow-y-auto p-5">
              <AnimatePresence mode="wait">
                <motion.div key={view} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.2, ease }}>
                  {view === "incidents" && <Incidents close={onClose} />}
                  {view === "connections" && <Connections />}
                  {view === "system" && <SystemFile />}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
