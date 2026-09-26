import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useEngine } from "../engine/useEngine";
import { useFocus } from "../engine/focus";
import { WHO } from "../engine/constants";
import { clock, mmss, ease } from "../lib/format";

type Run = { stage: string; start: number; end: number | null; result: "done" | "failed" | "running"; text?: string };
type Mark = { t: number; lane: string; kind: "tool" | "sup"; text: string };
type Band = { stage: string; start: number; end: number | null; text: string };
type Flag = { t: number; tone: string; text: string };

const STEPS = [5, 10, 15, 30, 60, 120, 300, 600];

export default function Timeline() {
  const s = useEngine();
  const [focus, setFocus] = useFocus();
  const [, tick] = useState(0);
  const [tip, setTip] = useState<{ x: number; y: number; title: string; body: string } | null>(null);
  const wrap = useRef<HTMLElement>(null);
  useEffect(() => {
    if (s.mode !== "live" && s.mode !== "replay") return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [s.mode]);

  const { runs, marks, bands, flags, lanes } = useMemo(() => {
    const runs: Run[] = [], marks: Mark[] = [], bands: Band[] = [], flags: Flag[] = [];
    const order: string[] = [];
    for (const e of s.events) {
      const t = Date.parse(e.ts);
      const st = e.stage || "";
      if (e.kind === "stage.started") { runs.push({ stage: st, start: t, end: null, result: "running" }); if (!order.includes(st)) order.push(st); }
      if (e.kind === "stage.done" || e.kind === "stage.failed") {
        const r = [...runs].reverse().find((x) => x.stage === st && x.end === null);
        if (r) { r.end = t; r.result = e.kind === "stage.done" ? "done" : "failed"; r.text = e.text; }
      }
      if (e.kind === "tool.call") marks.push({ t, lane: st, kind: "tool", text: e.text });
      if (e.kind === "supervisor.decision") marks.push({ t, lane: "supervisor", kind: "sup", text: e.text });
      if (e.kind === "approval.requested") bands.push({ stage: st, start: t, end: null, text: e.text.replace(/call_tool/, "a change") });
      if (e.kind === "approval.decided") { const b = [...bands].reverse().find((x) => x.stage === st && x.end === null); if (b) { b.end = t; b.text += ` · ${e.text}`; } }
      if (e.kind === "incident.opened") flags.push({ t, tone: "var(--red)", text: e.text });
      if (e.kind === "incident.mitigated") flags.push({ t, tone: "var(--go)", text: e.text });
      if (e.kind === "incident.resolved") flags.push({ t, tone: "var(--go)", text: e.text });
      if (e.kind === "incident.escalated") flags.push({ t, tone: "var(--red)", text: e.text });
    }
    const lanes = marks.some((m) => m.kind === "sup") ? ["supervisor", ...order] : order;
    return { runs, marks, bands, flags, lanes };
  }, [s.events]);

  const t0 = s.t0;
  const liveEnd = s.mode === "live" && !s.tEnd ? Date.now() : 0;
  const end = t0 ? Math.max(s.tEnd || 0, s.lastTs || t0, liveEnd, t0 + 10_000) : 0;
  const span = Math.max(1, end - (t0 || 0));
  const x = (t: number) => `${Math.max(0, Math.min(100, ((t - (t0 || 0)) / span) * 100))}%`;
  const w = (a: number, b: number) => `${Math.max(0.35, ((b - a) / span) * 100)}%`;
  const step = (STEPS.find((st) => span / 1000 / st <= 8) || 900) * 1000;
  const ticks = t0 ? Array.from({ length: Math.floor(span / step) + 1 }, (_, i) => i * step) : [];
  const nowT = s.mode === "live" && !s.tEnd ? Date.now() : s.mode === "replay" ? s.lastTs : null;

  const show = (ev: React.MouseEvent, title: string, body: string) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r) return;
    setTip({ x: ev.clientX - r.left, y: ev.clientY - r.top, title, body });
  };

  const LABEL_W = 132;
  const lane = (lane: string) => {
    const dim = focus && focus !== lane && lane !== "supervisor";
    return (
      <div key={lane} className="flex h-[16px] items-center transition-opacity duration-200" style={{ opacity: dim ? 0.3 : 1 }}>
        <button onClick={() => lane !== "supervisor" && setFocus(focus === lane ? null : lane, true)}
          className="shrink-0 truncate pr-3 text-left text-[12px] leading-[16px] transition-colors duration-150 hover:text-ink"
          style={{ width: LABEL_W, color: focus === lane ? "var(--ink)" : "var(--muted)", fontWeight: focus === lane ? 600 : 400 }}>{WHO[lane] || lane}</button>
        <div className="relative h-full min-w-0 flex-1">
          {runs.filter((r) => r.stage === lane).map((r, i) => {
            const e2 = r.end ?? (nowT || s.lastTs || r.start);
            const c = r.result === "failed" ? "var(--red)" : "var(--go)";
            return (
              <motion.div key={i} layout transition={{ duration: 0.5, ease }}
                className="absolute top-0 h-full cursor-default overflow-hidden rounded-[5px]"
                style={{ left: x(r.start), width: w(r.start, e2), background: `color-mix(in oklab, ${c} ${r.result === "running" ? 30 : 20}%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${c} 55%, transparent)` }}
                onMouseMove={(ev) => show(ev, `${WHO[lane] || lane} · ${mmss(e2 - r.start)}`, r.text || "working…")}>
                {r.result === "running" && <div className="absolute inset-0 overflow-hidden"><div className="h-full w-1/2" style={{ background: `linear-gradient(90deg, transparent, color-mix(in oklab, ${c} 35%, transparent), transparent)`, animation: "ns-scan 1.6s linear infinite" }} /></div>}
              </motion.div>
            );
          })}
          {bands.filter((b) => b.stage === lane).map((b, i) => {
            const e2 = b.end ?? (nowT || s.lastTs || b.start);
            return <div key={"b" + i} className="absolute top-0 h-full rounded-[5px]" style={{ left: x(b.start), width: w(b.start, e2), background: "color-mix(in oklab, var(--amber) 38%, transparent)", boxShadow: "inset 0 0 0 1px var(--amber)" }}
              onMouseMove={(ev) => show(ev, `Waiting for a human · ${mmss(e2 - b.start)}`, b.text)} />;
          })}
          {marks.filter((m) => m.lane === lane).map((m, i) => (
            <div key={"m" + i} className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 transition-transform duration-150 hover:scale-150"
              style={{ left: x(m.t), width: m.kind === "sup" ? 4 : 6, height: m.kind === "sup" ? 16 : 6, background: m.kind === "sup" ? "var(--sup)" : "var(--data)", borderRadius: m.kind === "sup" ? 2 : 999 }}
              onMouseMove={(ev) => show(ev, `${m.kind === "sup" ? "Supervisor" : WHO[lane] || lane} · ${clock(m.t)}`, m.text)} />
          ))}
        </div>
      </div>
    );
  };

  return (
    <section ref={wrap} className="panel relative mx-4 mb-4 shrink-0 overflow-hidden px-5 pt-3 pb-3" onMouseLeave={() => setTip(null)}>
      <div className="flex h-5 items-center">
        <div className="flex shrink-0 items-baseline gap-2" style={{ width: LABEL_W }}>
          <h2 className="m-0 text-[14px] font-semibold">Timeline</h2>
          <span className="truncate font-mono text-[11.5px] text-muted">{t0 ? mmss(span) : ""}</span>
        </div>
        <div className="relative h-full min-w-0 flex-1">
          {ticks.map((tt) => (
            <span key={tt} className="absolute top-0.5 -translate-x-1/2 font-mono text-[10.5px] text-dim" style={{ left: x(t0! + tt) }}>{mmss(tt)}</span>
          ))}
        </div>
      </div>
      {!t0 ? (
        <div className="grid h-[104px] place-items-center text-[13.5px] text-muted">Each agent gets a lane here. Block length is the exact time it worked.</div>
      ) : (
        <div className="relative mt-1.5">
          <div className="pointer-events-none absolute top-0 bottom-0 right-0" style={{ left: LABEL_W }}>
            {ticks.map((tt) => <div key={tt} className="absolute top-0 bottom-0 w-px bg-line" style={{ left: x(t0 + tt) }} />)}
            {flags.map((f, i) => <div key={i} className="absolute top-0 bottom-0 w-[2px] rounded-full" style={{ left: x(f.t), background: f.tone, opacity: 0.75 }} />)}
            {nowT && (
              <motion.div className="absolute top-[-26px] bottom-0 w-[2px] rounded-full bg-amber" animate={{ left: x(nowT) }} transition={{ duration: 0.4, ease }}>
                <span className="absolute top-0 right-1.5 text-[10.5px] font-semibold text-amber-ink">now</span>
              </motion.div>
            )}
          </div>
          <div className="scroll max-h-[124px] space-y-[5px] overflow-y-auto [@media(max-height:899px)]:max-h-[82px]">{lanes.map(lane)}</div>
        </div>
      )}
      <AnimatePresence>
        {tip && (
          <motion.div key="tip" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15, ease }}
            className="pointer-events-none absolute z-10 max-w-[360px] rounded-xl bg-panel px-3 py-2 text-[12.5px]"
            style={{ left: Math.min(tip.x + 12, (wrap.current?.clientWidth || 800) - 370), bottom: `calc(100% - ${tip.y - 8}px)`, boxShadow: "var(--shadow-lift)" }}>
            <div className="font-semibold text-ink">{tip.title}</div>
            <div className="mt-0.5 line-clamp-3 text-ink-2">{tip.body}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
