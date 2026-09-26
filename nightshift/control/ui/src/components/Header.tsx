import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Sun, MoonStars, Play, Pause, Stop, ListDashes, ArrowSquareOut, GitPullRequest } from "@phosphor-icons/react";
import { engine, inr } from "../engine/engine";
import { useEngine } from "../engine/useEngine";
import CountUp from "./vendor/CountUp";
import { IconSwap, IconSwapItem } from "./vendor/IconSwap";
import { mmss, ease } from "../lib/format";

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("ns-theme", theme); } catch { /* private mode */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))] as const;
}

function Elapsed() {
  const s = useEngine();
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i); }, []);
  if (!s.t0) return <span className="text-dim">—</span>;
  const end = s.tEnd || (s.mode === "live" ? Date.now() : s.lastTs || s.t0);
  return <span className="tabular">{mmss(end - s.t0)}</span>;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  open: { label: "Active", tone: "red" },
  mitigated: { label: "Mitigated", tone: "go" },
  resolved: { label: "Resolved", tone: "go" },
  escalated: { label: "Escalated", tone: "red" },
  false_alarm: { label: "False alarm", tone: "muted" },
};

export function Pill({ tone, children, pulse }: { tone: string; children: React.ReactNode; pulse?: boolean }) {
  const c = tone === "muted" ? "var(--muted)" : `var(--${tone})`;
  const ink = tone === "muted" ? "var(--muted)" : `var(--${tone}-ink)`;
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13px] font-semibold"
      style={{ background: `color-mix(in oklab, ${c} 14%, transparent)`, color: ink, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 38%, transparent)` }}>
      {pulse && (
        <span className="relative inline-flex size-2">
          <span className="ns-ping absolute inset-0 rounded-full" style={{ background: c }} />
          <span className="relative size-2 rounded-full" style={{ background: c }} />
        </span>
      )}
      {children}
    </span>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-end leading-none">
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted">{label}</span>
      <span className="mt-1.5 whitespace-nowrap font-mono text-[20px] font-medium tracking-tight text-ink min-[1700px]:text-[24px]">{children}</span>
    </div>
  );
}

const MODE: Record<string, { label: string; color: string }> = {
  live: { label: "Live", color: "var(--go)" },
  replay: { label: "Replay", color: "var(--data)" },
  view: { label: "Finished", color: "var(--muted)" },
  idle: { label: "Watching", color: "var(--go)" },
};

export default function Header({ onMenu }: { onMenu: () => void }) {
  const s = useEngine();
  const [theme, toggle] = useTheme();
  const inc = s.inc;
  const pending = s.pending.length > 0;
  const st = inc ? STATUS[inc.status] || { label: inc.status, tone: "muted" } : null;
  const mode = engine.paused ? { label: "Paused", color: "var(--data)" } : s.connected || s.mode === "replay" ? MODE[s.mode] : { label: "Reconnecting", color: "var(--red)" };

  return (
    <header className="relative z-20 flex h-16 min-w-0 items-center gap-4 border-b border-line bg-panel/80 px-4 backdrop-blur-sm min-[1700px]:gap-5 min-[1700px]:px-5">
      <div className="flex shrink-0 items-center gap-3">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden><path d="M20.7 6.6a10 10 0 1 0 5.9 18.1A10.6 10.6 0 0 1 20.7 6.6z" style={{ fill: "var(--sup)" }} /></svg>
        <span className="text-[19px] font-semibold tracking-[-0.02em]">NightShift</span>
        <span className="rounded-md px-2 py-0.5 font-mono text-[12px] text-muted hairline max-[1599px]:hidden">{inc?.system || "astronomy-shop"}</span>
      </div>
      <div className="h-7 w-px shrink-0 bg-line-2" />

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <AnimatePresence mode="wait" initial={false}>
          {inc ? (
            <motion.div key={inc.id} className="flex min-w-0 items-center gap-3"
              initial={{ opacity: 0, y: -6, filter: "blur(4px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: 6, filter: "blur(4px)" }} transition={{ duration: 0.28, ease }}>
              <span className="shrink-0 whitespace-nowrap font-mono text-[17px] font-semibold tracking-tight">{inc.id}</span>
              {pending ? <Pill tone="amber" pulse>Needs sign-off</Pill> : st && <Pill tone={st.tone} pulse={inc.status === "open"}>{st.label}</Pill>}
              {inc.severity && <span className="max-[1439px]:hidden"><Pill tone="muted">{inc.severity}</Pill></span>}
              <span className="truncate text-[16px] font-medium text-ink-2" title={inc.summary || ""}>{inc.summary || inc.service}</span>
              {inc.jira_url && (
                <a href={inc.jira_url} target="_blank" rel="noopener" className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium no-underline hover:underline">
                  {inc.jira_key}<ArrowSquareOut size={13} />
                </a>
              )}
              {inc.pr_url && (
                <a href={inc.pr_url} target="_blank" rel="noopener" className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium no-underline hover:underline">
                  <GitPullRequest size={14} />Pull request
                </a>
              )}
            </motion.div>
          ) : (
            <motion.span key="none" className="text-[15px] text-muted" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              No active incident. The watcher is on duty.
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="flex shrink-0 items-center gap-4 min-[1700px]:gap-6">
        <Metric label="Elapsed"><Elapsed /></Metric>
        <Metric label={s.me?.budget_usd ? `Cost of ₹${Math.round(inr(s.me.budget_usd))} budget` : "Cost"}>
          <span style={{ color: s.me?.budget_usd && s.costUsd > s.me.budget_usd * 0.8 ? "var(--red-ink)" : undefined }}>
            <CountUp value={inr(s.costUsd)} decimals={2} prefix="₹" />
          </span>
        </Metric>
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.12em]" style={{ color: mode.color }}>
          <span className="relative inline-flex size-2">
            {(s.mode === "live" || s.mode === "idle" || s.mode === "replay") && <span className="ns-ping absolute inset-0 rounded-full" style={{ background: mode.color }} />}
            <span className="relative size-2 rounded-full" style={{ background: mode.color }} />
          </span>
          {mode.label}
        </div>
        {s.me?.name && <span className="text-[13px] text-muted max-[1499px]:hidden" title="Approvals are recorded under this name">{s.me.name}</span>}
        <div className="flex items-center gap-2">
          <button onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            className="grid size-9 place-items-center rounded-lg text-ink-2 transition-colors duration-150 hairline hover:bg-panel-3 active:scale-[0.97]">
            <IconSwap>
              {theme === "dark"
                ? <IconSwapItem key="moon"><MoonStars size={18} /></IconSwapItem>
                : <IconSwapItem key="sun"><Sun size={18} /></IconSwapItem>}
            </IconSwap>
          </button>
          {engine.replaying && (
            <button onClick={() => engine.togglePause()} aria-label={engine.paused ? "Resume replay" : "Pause replay"} title="Space"
              className="grid size-9 place-items-center rounded-lg text-ink-2 transition-colors duration-150 hairline hover:bg-panel-3 active:scale-[0.97]">
              <IconSwap>{engine.paused ? <IconSwapItem key="play"><Play size={16} weight="fill" /></IconSwapItem> : <IconSwapItem key="pause"><Pause size={16} weight="fill" /></IconSwapItem>}</IconSwap>
            </button>
          )}
          <button onClick={() => (engine.replaying ? engine.stopReplay() : engine.replayLatest())}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-ink px-3.5 text-[14px] font-semibold text-bg transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.97]">
            {engine.replaying ? <Stop size={15} weight="fill" /> : <Play size={15} weight="fill" />}
            {engine.replaying ? "Stop" : "Replay"}
          </button>
          <button onClick={onMenu} aria-label="Open incidents, connections and system file"
            className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[14px] font-semibold text-ink-2 transition-colors duration-150 hairline hover:bg-panel-3 active:scale-[0.97]">
            <ListDashes size={17} /><span className="max-[1499px]:hidden">Menu</span>
          </button>
        </div>
      </div>

      <AnimatePresence>
        {pending && (
          <motion.div key="tier" className="absolute inset-x-0 bottom-[-1px] h-[2px] origin-left bg-amber"
            initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.6, ease }} />
        )}
      </AnimatePresence>
    </header>
  );
}
