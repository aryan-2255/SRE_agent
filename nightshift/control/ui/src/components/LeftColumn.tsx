import { motion, AnimatePresence } from "motion/react";
import { Check, X, Pulse, ShoppingCart, Wrench } from "@phosphor-icons/react";
import { useEngine } from "../engine/useEngine";
import CountUp from "./vendor/CountUp";
import { ease } from "../lib/format";
import type { ServiceTile } from "../engine/types";

export function PanelHead({ icon, title, right, sub }: { icon: React.ReactNode; title: string; right?: React.ReactNode; sub?: string }) {
  return (
    <div className="px-5 pt-4 pb-3">
      <div className="flex items-center gap-2.5">
        <span className="text-muted">{icon}</span>
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
        <div className="ml-auto">{right}</div>
      </div>
      {sub && <p className="m-0 mt-1 text-[12.5px] text-muted [@media(max-height:899px)]:hidden">{sub}</p>}
    </div>
  );
}

function Trace({ values, limit, over }: { values: number[]; limit: number; over: boolean }) {
  const W = 72, H = 28;
  const vals = values.length ? values : [0];
  const top = Math.max(limit * 2, ...vals, 1);
  const pts = vals.map((v, i) => [vals.length === 1 ? W : (i / (vals.length - 1)) * W, H - 2 - (v / top) * (H - 6)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `M0,${H} L${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L")} L${W},${H} Z`;
  const ly = H - 2 - (limit / top) * (H - 6);
  const c = over ? "var(--red)" : "var(--go)";
  const id = `g${Math.round(limit * 10)}${over ? "o" : "n"}`;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" style={{ stopColor: c, stopOpacity: 0.28 }} />
          <stop offset="100%" style={{ stopColor: c, stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      <line x1={0} x2={W} y1={ly} y2={ly} strokeDasharray="2 3" style={{ stroke: "var(--red)", strokeOpacity: 0.45 }} />
      <path d={area} fill={`url(#${id})`} />
      <polyline points={line} fill="none" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: c }} />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.4} style={{ fill: c }} />
    </svg>
  );
}

function ServiceRow({ name, s, history }: { name: string; s: ServiceTile; history: number[] }) {
  const progress = s.over ? Math.min(1, s.over_for_s / Math.max(1, s.fires_after_s)) : 0;
  return (
    <motion.li layout transition={{ duration: 0.35, ease }}
      className="group relative mx-2 flex items-center gap-3 rounded-xl px-3 py-[7px] transition-colors duration-200 hover:bg-panel-3"
      style={s.over ? { background: "var(--red-soft)" } : undefined}
      title={`${name}: ${s.error_pct.toFixed(2)}% errors at ${s.rps.toFixed(2)} req/s (limit ${s.limit_pct}%)`}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-medium">{name}</div>
        <div className="truncate text-[12px]" style={{ color: s.over ? "var(--red-ink)" : "var(--muted)" }}
          title={s.op ? s.op.name : undefined}>
          {s.op ? `${s.op.name.split("/").pop()} fails ${s.op.error_pct}% (${s.op.failed_requests} failed)`
            : s.over ? `over ${s.over_for_s}s · opens at ${s.fires_after_s}s`
            : s.state === "quiet" ? (s.rps ? "too few requests to judge" : "no traffic")
            : `${s.rps.toFixed(2)}/s · limit ${s.limit_pct}%`}
        </div>
      </div>
      <span className="max-[1599px]:hidden"><Trace values={history} limit={s.limit_pct} over={s.over} /></span>
      <div className="w-[66px] text-right font-mono text-[20px] font-medium tracking-tight" style={{ color: s.over ? "var(--red-ink)" : "var(--ink)" }}>
        <CountUp value={s.error_pct} decimals={1} suffix="%" duration={0.6} />
      </div>
      {s.over && (
        <motion.div className="absolute inset-x-3 bottom-1 h-[2px] origin-left rounded-full bg-red" initial={{ scaleX: 0 }}
          animate={{ scaleX: progress }} transition={{ duration: 0.8, ease }} />
      )}
    </motion.li>
  );
}

export function Watcher() {
  const s = useEngine();
  // failing first, then by error rate
  const rows = Object.entries(s.watch?.services || {}).sort((a, b) => Number(b[1].over) - Number(a[1].over) || b[1].error_pct - a[1].error_pct);
  const breach = rows.some(([, r]) => r.over);
  return (
    <section className="panel flex min-h-[200px] flex-1 flex-col overflow-hidden">
      <PanelHead icon={<Pulse size={18} />} title="Watcher" sub="Every 5 s. Opens an incident only when a service stays over its limit."
        right={<span className="whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold uppercase tracking-[0.08em]"
          style={{ background: breach ? "var(--red-soft)" : "var(--go-soft)", color: breach ? "var(--red-ink)" : "var(--go-ink)" }}>{breach ? "Breach" : "Rules · no AI"}</span>} />
      <ul className="scroll m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 pb-2">
        {rows.length ? rows.map(([n, r]) => <ServiceRow key={n} name={n} s={r} history={s.history[n] || []} />)
          : Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="mx-5 my-3 h-9 animate-pulse rounded-lg bg-panel-3" />
          ))}
      </ul>
      <Signals />
      <SyntheticLine />
    </section>
  );
}

/** Numbers error rates miss, such as a Kafka consumer falling behind. */
function Signals() {
  const s = useEngine();
  const sig = Object.entries(s.watch?.signals || {});
  if (!sig.length) return null;
  return (
    <ul className="m-0 shrink-0 list-none space-y-1 border-t border-line px-5 py-2.5">
      {sig.map(([name, v]) => (
        <li key={name} className="flex items-baseline gap-2 text-[12.5px]" title={v.explain}>
          <span className="size-1.5 shrink-0 translate-y-[-1px] rounded-full" style={{ background: v.over ? "var(--red)" : "var(--go)" }} />
          <span className="truncate" style={{ color: v.over ? "var(--red-ink)" : "var(--ink-2)" }}>{name}</span>
          <span className="ml-auto shrink-0 font-mono" style={{ color: v.over ? "var(--red-ink)" : "var(--muted)" }}>{v.value}{v.over ? ` / ${v.above}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

/** Across the top when monitoring itself is down: silence must not look like health. */
export function BlindBanner() {
  const s = useEngine();
  const b = s.watch?.blind;
  // the wrapper always renders so the page grid keeps its rows when monitoring is fine
  return (
    <div>
    <AnimatePresence initial={false}>
      {b && (
        <motion.div key="blind" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }}
          role="alert" className="flex items-center gap-2.5 px-4 py-2 text-[14px] font-semibold"
          style={{ background: "var(--red-soft)", color: "var(--red-ink)", boxShadow: "inset 0 -1px 0 color-mix(in oklab, var(--red) 40%, transparent)" }}>
          <Pulse size={17} weight="bold" />Monitoring is blind. {b.reason}
        </motion.div>
      )}
    </AnimatePresence>
    </div>
  );
}

function SyntheticLine() {
  const s = useEngine();
  const syn = s.watch?.synthetic;
  if (!syn) return null;
  const ok = syn.steps.filter((x) => x.ok).length;
  return (
    <div className="hidden shrink-0 items-center gap-2 border-t border-line px-5 py-2.5 text-[12.5px] [@media(max-height:999px)]:flex"
      title={syn.steps.map((x) => `${x.ok ? "ok" : "failed"} · ${x.step} · ${x.ms} ms`).join("\n")}>
      <ShoppingCart size={15} className="shrink-0 text-muted" />
      <span className="truncate text-ink-2">Synthetic customer</span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {syn.steps.map((x) => <span key={x.step} className="size-1.5 rounded-full" style={{ background: x.ok ? "var(--go)" : "var(--red)" }} />)}
      </span>
      <span className="shrink-0 font-semibold" style={{ color: syn.passed ? "var(--go-ink)" : "var(--red-ink)" }}>{ok}/{syn.steps.length}</span>
    </div>
  );
}

export function SyntheticCustomer() {
  const s = useEngine();
  const syn = s.watch?.synthetic;
  const total = (syn?.steps || []).reduce((a, st) => a + (st.ms || 0), 0);
  return (
    <section className="panel shrink-0 px-5 py-3.5 [@media(max-height:999px)]:hidden">
      <div className="flex items-center gap-2.5">
        <ShoppingCart size={18} className="shrink-0 text-muted" />
        <h2 className="m-0 truncate text-[15px] font-semibold tracking-[-0.01em]">Synthetic customer</h2>
        {syn && <span className="ml-auto shrink-0 text-[12.5px] font-semibold" style={{ color: syn.passed ? "var(--go-ink)" : "var(--red-ink)" }}>{syn.passed ? "Passing" : "Failing"}</span>}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {(syn?.steps || []).map((st) => (
          <span key={st.step} title={`${st.step} · ${st.ms} ms${st.detail ? " · " + st.detail : ""}`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-md py-0.5 pr-2 pl-1 text-[12px] transition-colors duration-150 hover:bg-panel-3"
            style={{ background: st.ok ? "var(--go-soft)" : "var(--red-soft)", color: st.ok ? "var(--ink-2)" : "var(--red-ink)" }}>
            <span className="grid size-3.5 shrink-0 place-items-center" style={{ color: st.ok ? "var(--go-ink)" : "var(--red-ink)" }}>
              {st.ok ? <Check size={11} weight="bold" /> : <X size={11} weight="bold" />}
            </span>
            <span className="truncate">{st.step}</span>
          </span>
        ))}
        {!syn && <span className="text-[13px] text-muted">Waiting for the first check…</span>}
      </div>
      {syn && <p className="m-0 mt-2 text-[11.5px] text-dim">Shops like a real customer every 30 s · {total} ms end to end</p>}
    </section>
  );
}

export function ToolTraffic() {
  const s = useEngine();
  const entries = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return (
    <section className="panel shrink-0">
      <PanelHead icon={<Wrench size={18} />} title="Tool traffic"
        right={<span className="font-mono text-[13px] text-muted"><CountUp value={s.toolTotal} /> calls</span>} />
      <ul className="m-0 list-none space-y-2 px-5 pb-3.5">
        <AnimatePresence initial={false}>
          {entries.map(([t, n], idx) => (
            <motion.li key={t} layout className={idx > 2 ? "[@media(max-height:899px)]:hidden" : undefined} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate font-mono text-[12.5px] text-ink-2">{t}</span>
                <span className="font-mono text-[12.5px] text-ink">{n}</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-panel-3">
                <motion.div className="h-full w-full origin-left rounded-full bg-data" initial={false} animate={{ scaleX: n / max }} transition={{ duration: 0.5, ease }} />
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
        {!entries.length && <li className="text-[13px] text-muted">No tool calls yet.</li>}
      </ul>
    </section>
  );
}
