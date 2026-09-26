import { motion } from "motion/react";
import { AGENTS, PIPELINE } from "../engine/constants";
import { useEngine } from "../engine/useEngine";
import { engine } from "../engine/engine";
import { useFocus } from "../engine/focus";
import { ease } from "../lib/format";

// the rail is narrow: the long map label gets a short form here
const LABEL: Record<string, string> = { ...Object.fromEntries(AGENTS.map((a) => [a.id, a.label])), cicd: "CI/CD" };

export default function StageRail() {
  const s = useEngine();
  const [focus, setFocus] = useFocus();
  const reached = PIPELINE.reduce((acc, id, i) => (s.status[id] && s.status[id] !== "skipped" ? i : acc), -1);
  const pct = reached < 0 ? 0 : ((reached + 0.5) / PIPELINE.length) * 100;
  const waiting = PIPELINE.some((id) => s.status[id] === "waiting");

  return (
    <nav aria-label="Pipeline stages" className="relative flex h-[46px] min-w-0 items-stretch gap-1 border-b border-line px-5">
      <div className="absolute inset-x-5 bottom-0 h-[2px] bg-line" />
      <motion.div className="absolute inset-x-5 bottom-0 h-[2px] origin-left" style={{ background: waiting ? "var(--amber)" : "var(--go)" }}
        initial={false} animate={{ scaleX: pct / 100 }} transition={{ duration: 0.7, ease }} />
      {PIPELINE.map((id) => {
        const st = s.status[id];
        const color = st === "waiting" ? "var(--amber)" : st === "failed" || st === "interrupted" ? "var(--red)" : st === "running" || st === "done" ? "var(--go)" : "var(--dim)";
        const active = st === "running" || st === "waiting";
        const dimmed = focus && focus !== id;
        return (
          <button key={id} onMouseEnter={() => setFocus(id, false)} onMouseLeave={() => setFocus(null, false)} onClick={() => { engine.setFollow(false); setFocus(focus === id ? null : id, true); }}
            className="group relative flex min-w-0 flex-1 items-center gap-2 text-left transition-opacity duration-200"
            style={{ opacity: dimmed ? 0.45 : st === "skipped" ? 0.5 : 1 }} aria-pressed={focus === id}>
            <span className="relative grid size-3 shrink-0 place-items-center">
              {active && <span className="ns-ping absolute inset-0 rounded-full" style={{ background: color }} />}
              <span className="relative size-2.5 rounded-full transition-colors duration-300"
                style={{ background: st === "done" ? "transparent" : st ? color : "transparent", boxShadow: `inset 0 0 0 ${st === "done" ? 2 : 1.5}px ${color}` }} />
            </span>
            <span className="min-w-0 truncate text-[12.5px] font-medium min-[1700px]:text-[13.5px] transition-colors duration-200 group-hover:text-ink"
              style={{ color: active ? (st === "waiting" ? "var(--amber-ink)" : "var(--ink)") : st ? "var(--ink-2)" : "var(--dim)", textDecoration: st === "skipped" ? "line-through" : undefined }}>
              {LABEL[id]}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
