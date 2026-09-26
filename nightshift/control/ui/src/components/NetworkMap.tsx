import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, Storefront, Signature, GithubLogo, Cube, TreeStructure } from "@phosphor-icons/react";
import { AGENTS, ARCS, HUB, HUB_R, NODE_R, POS, RING, SYSTEMS, VIEW, nodePoint, type SystemKey } from "../engine/constants";
import { engine } from "../engine/engine";
import { useEngine } from "../engine/useEngine";
import type { Fx, NodeState } from "../engine/types";
import { useFocus } from "../engine/focus";
import { systemFor } from "../engine/constants";

export type Hover = { id: string; kind: "agent" | "system" | "supervisor"; x: number; y: number } | null;

const SVGNS = "http://www.w3.org/2000/svg";
const SYS_ICON: Record<SystemKey, typeof Eye> = { watcher: Eye, shop: Storefront, human: Signature, github: GithubLogo, sandbox: Cube, harness: TreeStructure };
const GLYPH: Record<NodeState, string> = { running: "working", waiting: "needs you", done: "done", failed: "failed", skipped: "skipped", interrupted: "cut off" };

function edge(from: { x: number; y: number }, to: { x: number; y: number }, r: number) {
  const dx = to.x - from.x, dy = to.y - from.y, d = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / d) * r, y: from.y + (dy / d) * r };
}
function curve(a: { x: number; y: number }, b: { x: number; y: number }, bend = 0.18) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  return { d: `M${a.x},${a.y} Q${mx - (b.y - a.y) * bend},${my + (b.x - a.x) * bend} ${b.x},${b.y}`, q: { x: mx - (b.y - a.y) * bend, y: my + (b.x - a.x) * bend } };
}
const stateColor = (s?: NodeState) =>
  s === "running" ? "var(--go)" : s === "waiting" ? "var(--amber)" : s === "done" ? "var(--go)" : s === "failed" || s === "interrupted" ? "var(--red)" : "var(--line-2)";

export default function NetworkMap({ onHover }: { onHover?: (h: Hover) => void }) {
  const s = useEngine();
  const [focus, setFocus] = useFocus();
  // which systems each agent touched, from its real tool calls
  const touched = useMemo(() => {
    const m: Record<string, Set<string>> = {};
    for (const e of s.events) if (e.kind === "tool.call" && e.stage) (m[e.stage] ||= new Set()).add(systemFor(String(e.data?.tool || "")));
    return m;
  }, [s.events]);
  const related = (id: string) => {
    if (!focus) return true;
    if (focus === id || id === "supervisor") return true;
    if (touched[focus]?.has(id)) return true;
    if (touched[id]?.has(focus)) return true;
    return false;
  };
  const hov = (id: string, kind: "agent" | "system" | "supervisor") => ({
    onMouseEnter: (e: React.MouseEvent) => { setFocus(id === "supervisor" ? null : id, false); onHover?.({ id, kind, x: e.clientX, y: e.clientY }); },
    onMouseMove: (e: React.MouseEvent) => onHover?.({ id, kind, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => { setFocus(null, false); onHover?.(null); },
    // a click pins the agent (or the supervisor) and opens its panel; following the live agent stops
    onClick: () => { if (kind !== "system") engine.setFollow(false); setFocus(focus === id ? null : id, true); },
    style: { cursor: "pointer" } as React.CSSProperties,
  });
  const fxRef = useRef<SVGGElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [fk, setFk] = useState(1);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const scale = Math.min(r.width / VIEW.w, r.height / VIEW.h);
      setFk(Math.max(1, Math.min(1.35, 0.82 / Math.max(scale, 0.01))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // imperative effects layer: pulses, flashes and talk lines are short-lived and never re-render React
  useEffect(() => engine.onFx((f: Fx) => {
    const layer = fxRef.current;
    if (!layer) return;
    const mk = (tag: string, attrs: Record<string, string | number>, parent: Element = layer) => {
      const n = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      parent.appendChild(n);
      return n as SVGGraphicsElement;
    };
    if (f.type === "pulse") {
      const a = nodePoint(f.from), b = nodePoint(f.to);
      const path = mk("path", { d: curve(a, b, f.bend ?? 0).d, fill: "none", stroke: "none" }) as SVGPathElement;
      const color = f.tone === "tool" ? "var(--data)" : f.tone === "talk" ? "var(--amber)" : "var(--sup)";
      const dots = [5.5, 3.8, 2.6].map((r, i) => {
        const c = mk("circle", { r });
        c.style.fill = color;
        c.style.opacity = String(1 - i * 0.3);
        return c;
      });
      const len = path.getTotalLength();
      const dur = f.dur ?? 650, start = performance.now();
      const step = (t0: number) => {
        const t = Math.min(1, (t0 - start) / dur);
        dots.forEach((dot, i) => {
          const tt = Math.max(0, t - i * 0.06);
          const p = path.getPointAtLength(len * (1 - Math.pow(1 - tt, 2)));
          dot.setAttribute("cx", String(p.x));
          dot.setAttribute("cy", String(p.y));
        });
        if (t < 1) requestAnimationFrame(step);
        else { dots.forEach((d) => d.remove()); path.remove(); }
      };
      requestAnimationFrame(step);
    }
    if (f.type === "flash") {
      const p = mk("path", { d: curve(nodePoint(f.from), nodePoint(f.to), 0.12).d, fill: "none", "stroke-width": 1.8, "stroke-linecap": "round" });
      p.style.stroke = "var(--data)";
      p.style.opacity = "0.85";
      p.style.transition = "opacity 1100ms cubic-bezier(0.23, 1, 0.32, 1)";
      requestAnimationFrame(() => requestAnimationFrame(() => { p.style.opacity = "0"; }));
      setTimeout(() => p.remove(), 1200);
    }
    if (f.type === "talk") {
      const a = POS[f.from], b = POS[f.to];
      const g = mk("g", {});
      const { d, q } = curve(a, b, 0.35);
      const path = mk("path", { d, fill: "none", "stroke-width": 2, "stroke-dasharray": "6 5" }, g);
      path.style.stroke = "var(--amber)";
      const mx = (a.x + 2 * q.x + b.x) / 4, my = (a.y + 2 * q.y + b.y) / 4;
      const short = f.text.length > 34 ? f.text.slice(0, 33) + "…" : f.text;
      const w = Math.max(60, short.length * 7.6 + 20);
      const r = mk("rect", { x: mx - w / 2, y: my - 13, width: w, height: 26, rx: 8 }, g);
      r.style.fill = "var(--panel)"; r.style.stroke = "var(--amber)";
      const tx = mk("text", { x: mx, y: my + 4.5, "text-anchor": "middle", "font-size": 13, "font-weight": 600 }, g);
      tx.style.fill = "var(--amber-ink)";
      tx.textContent = short;
      g.style.transition = "opacity 1.2s";
      setTimeout(() => { g.style.opacity = "0.25"; }, 6000);
      setTimeout(() => g.remove(), 20000);
    }
  }), []);

  const nowMs = Date.now();
  const isHot = (k: string) => (s.hot[k] || 0) > nowMs;
  const pending = s.pending[0];
  const waitPos = pending && POS[pending.stage];

  return (
    <svg ref={svgRef} viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full select-none" role="img"
      aria-label="Live network of NightShift agents around the supervisor, with the systems they reach">
      <defs>
        <pattern id="ns-dots" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" style={{ fill: "var(--line-2)" }} />
        </pattern>
        <radialGradient id="ns-fade" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stopColor="white" stopOpacity="1" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <mask id="ns-fade-mask"><rect width={VIEW.w} height={VIEW.h} fill="url(#ns-fade)" /></mask>
        <radialGradient id="ns-hub-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" style={{ stopColor: "var(--sup)", stopOpacity: 0.16 }} />
          <stop offset="100%" style={{ stopColor: "var(--sup)", stopOpacity: 0 }} />
        </radialGradient>
      </defs>

      <rect width={VIEW.w} height={VIEW.h} fill="url(#ns-dots)" mask="url(#ns-fade-mask)" opacity={0.55} />
      <circle cx={HUB.x} cy={HUB.y} r={RING} fill="none" strokeDasharray="2 8" style={{ stroke: "var(--line-2)" }} />
      <circle cx={HUB.x} cy={HUB.y} r={170} fill="url(#ns-hub-glow)" />

      {/* the four kinds of work, each an arc of the ring; it lights up while one of its agents works or waits */}
      {ARCS.map((c) => {
        const R = RING - 74;
        const pad = ((c.to - c.from) / c.agents.length) * 0.14;
        const from = c.from + pad, to = c.to - pad, mid = (from + to) / 2;
        const pt = (r: number, deg: number) => ({ x: HUB.x + r * Math.cos((deg * Math.PI) / 180), y: HUB.y + r * Math.sin((deg * Math.PI) / 180) });
        const arc = (r: number, a: number, b: number, sweep: 0 | 1) => {
          const p = pt(r, a), q = pt(r, b);
          return `M${p.x.toFixed(1)},${p.y.toFixed(1)} A${r},${r} 0 ${Math.abs(b - a) > 180 ? 1 : 0} ${sweep} ${q.x.toFixed(1)},${q.y.toFixed(1)}`;
        };
        const tag = pt(RING - 120, mid);
        const tw = c.label.length * 11 + 30;
        const sts = c.agents.map((a) => s.status[a]);
        const tone = sts.includes("waiting") ? "var(--amber)" : sts.includes("running") ? "var(--go)" : null;
        const dim = focus && !c.agents.includes(focus as never);
        return (
          <g key={c.id} opacity={dim ? 0.35 : 1} style={{ transition: "opacity 250ms" }}>
            <title>{`${c.label}: ${c.hint}`}</title>
            <path d={arc(R, from, to, 1)} fill="none" strokeWidth={tone ? 3 : 2} strokeLinecap="round"
              style={{ stroke: tone || "var(--line-2)", transition: "stroke 300ms" }} />
            <rect x={tag.x - tw / 2} y={tag.y - 18} width={tw} height={36} rx={18}
              style={{ fill: "var(--panel)", stroke: tone || "var(--line-2)", strokeWidth: 1, transition: "stroke 300ms" }} />
            <text x={tag.x} y={tag.y + 6.5} textAnchor="middle" fontSize={19} fontWeight={650}
              style={{ fill: tone ? (tone === "var(--amber)" ? "var(--amber-ink)" : "var(--go-ink)") : "var(--ink-2)", transition: "fill 300ms" }}>{c.label}</text>
          </g>
        );
      })}

      {/* spokes */}
      {AGENTS.map(({ id }) => {
        const st = s.status[id];
        const a = edge(HUB, POS[id], HUB_R + 4), b = edge(POS[id], HUB, NODE_R + (st === "waiting" ? 12 : 7));
        const hot = st === "running" || st === "waiting";
        const f = focus === id;
        return (
          <line key={id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeLinecap="round"
            style={{ stroke: f && !hot ? "var(--ink-2)" : hot ? stateColor(st) : st === "done" ? "var(--go)" : "var(--line-2)",
              opacity: f ? 1 : focus && !related(id) ? 0.15 : hot ? 0.9 : st === "done" ? 0.32 : 1, strokeWidth: f ? 2.6 : hot ? 2.2 : 1.3, transition: "stroke 300ms, opacity 250ms" }} />
        );
      })}

      {/* the approval request: waiting agent -> on-call */}
      {waitPos && (() => {
        const H = SYSTEMS.human;
        const hb = waitPos.x >= H.x + H.w / 2 ? { x: H.x + H.w, y: H.y + H.h / 2 } : { x: H.x, y: H.y + H.h / 2 };
        const a = edge(waitPos, hb, NODE_R + 12);
        const { d } = curve(a, hb, hb.x > waitPos.x ? 0.28 : -0.28);
        const right = hb.x >= H.x + H.w;
        const mx = right ? H.x + H.w + 14 : H.x - 20 - (34 + (pending.tool.length + 23) * 7.2), my = H.y + 14;
        return (
          <g>
            <path d={d} fill="none" strokeWidth={2.2} strokeDasharray="7 4" strokeLinecap="round" className="ns-march" style={{ stroke: "var(--amber)" }} />
            <g transform={`translate(${mx}, ${my})`}>
              <rect x={0} y={-14} width={34 + (pending.tool.length + 23) * 7.2} height={28} rx={9} style={{ fill: "var(--panel)", stroke: "var(--amber)" }} />
              <circle cx={14} cy={0} r={4} className="ns-breathe" style={{ fill: "var(--amber)" }} />
              <text x={26} y={4.5} fontSize={13.5} fontWeight={600} style={{ fill: "var(--amber-ink)" }}>{pending.tool} · needs your signature</text>
            </g>
          </g>
        );
      })()}

      {/* systems */}
      {(Object.keys(SYSTEMS) as SystemKey[]).map((k) => {
        const sy = SYSTEMS[k];
        const hot = isHot(k) || (k === "human" && !!pending) || focus === k;
        const tone = k === "human" ? "var(--amber)" : k === "watcher" ? "var(--go)" : "var(--data)";
        const Icon = SYS_ICON[k];
        return (
          <g key={k} className="ns-node" {...hov(k, "system")} opacity={related(k) ? 1 : 0.3}>
            <rect x={sy.x} y={sy.y} width={sy.w} height={sy.h} rx={14}
              style={{ fill: hot ? `color-mix(in oklab, ${tone} 12%, var(--panel-2))` : "var(--panel-2)",
                stroke: hot ? tone : k === "watcher" ? "color-mix(in oklab, var(--go) 45%, transparent)" : "var(--line-2)",
                strokeWidth: hot ? 1.6 : 1, transition: "fill 300ms, stroke 300ms" }} />
            <g transform={`translate(${sy.x + 16}, ${sy.y + 20})`} style={{ color: hot ? tone : "var(--muted)" }}>
              <Icon size={24} weight={hot ? "fill" : "regular"} />
            </g>
            <text x={sy.x + 50} y={sy.y + 28} fontSize={16 * Math.min(fk, 1.2)} fontWeight={600} style={{ fill: "var(--ink)" }}>{sy.label}</text>
            <text x={sy.x + 50} y={sy.y + 47} fontSize={12.5 * Math.min(fk, 1.15)} style={{ fill: "var(--muted)" }}>{sy.sub}</text>
          </g>
        );
      })}

      {/* supervisor */}
      <g className="ns-node" {...hov("supervisor", "supervisor")}>
        {s.hubThinking && <circle cx={HUB.x} cy={HUB.y} r={HUB_R + 4} fill="none" strokeWidth={1.5} className="ns-halo" style={{ stroke: "var(--sup)" }} />}
        <circle cx={HUB.x} cy={HUB.y} r={HUB_R} style={{ fill: "var(--sup-fill)", stroke: "var(--sup)", strokeWidth: s.hubThinking ? 3 : 2 }} />
        <text x={HUB.x} y={HUB.y - 2} textAnchor="middle" fontSize={22} fontWeight={650} style={{ fill: "var(--sup)" }}>Supervisor</text>
        <text x={HUB.x} y={HUB.y + 21} textAnchor="middle" fontSize={14} style={{ fill: "var(--muted)" }}>{s.hubThinking ? "deciding…" : "Kimi K3"}</text>
      </g>

      {/* agents */}
      {AGENTS.map(({ id, label, model }) => {
        const p = POS[id], st = s.status[id], runs = s.runs[id] || 0;
        const col = stateColor(st);
        const skipped = st === "skipped";
        const sats = s.sats[id] || [];
        return (
          <g key={id} className="ns-node" {...hov(id, "agent")} opacity={!related(id) ? 0.22 : skipped ? 0.38 : 1}>
            <circle cx={p.x} cy={p.y} r={NODE_R + 26} fill="transparent" />
            {focus === id && <circle cx={p.x} cy={p.y} r={NODE_R + 5} fill="none" strokeWidth={1.2} style={{ stroke: "var(--ink-2)", opacity: 0.6 }} />}
            {st === "waiting" && <circle cx={p.x} cy={p.y} r={NODE_R + 9} fill="none" strokeWidth={1.6} className="ns-attention" style={{ stroke: "var(--amber)" }} />}
            {st === "running" && <circle cx={p.x} cy={p.y} r={NODE_R + 6} fill="none" strokeWidth={2.6} strokeDasharray="30 250" strokeLinecap="round" className="ns-spin" style={{ stroke: "var(--go)" }} />}
            <circle cx={p.x} cy={p.y} r={NODE_R}
              style={{ fill: st === "running" ? "color-mix(in oklab, var(--go) 13%, var(--panel))" : st === "waiting" ? "color-mix(in oklab, var(--amber) 16%, var(--panel))" : st === "failed" ? "color-mix(in oklab, var(--red) 14%, var(--panel))" : "var(--panel)",
                stroke: col, strokeWidth: st && !skipped ? 2 : 1.4, transition: "fill 300ms, stroke 300ms" }} />
            <text x={p.x} y={p.y + 5} textAnchor="middle" fontSize={(st === "waiting" ? 14.5 : 14) * Math.min(fk, 1.15)} fontWeight={600}
              style={{ fill: st && !skipped ? (st === "done" ? "var(--go-ink)" : st === "waiting" ? "var(--amber-ink)" : st === "failed" ? "var(--red-ink)" : "var(--go-ink)") : "var(--dim)" }}>
              {st ? GLYPH[st] : "idle"}
            </text>
            {(() => {
              const ang = Math.atan2(p.y - HUB.y, p.x - HUB.x), cx = Math.cos(ang), sy = Math.sin(ang);
              const off = NODE_R + (st === "waiting" ? 16 : 12);
              const lx = p.x + cx * off, ly = p.y + sy * off;
              const anchor = cx > 0.2 ? "start" : cx < -0.2 ? "end" : "middle";
              // name then model, stacked away from the ring
              const nameY = sy > 0.35 ? ly + 16 * fk : sy < -0.35 ? ly - 17 * fk : ly - 1;
              const modelY = sy < -0.35 ? ly - 1 : nameY + 17 * fk;
              return (
                <>
                  <text x={lx} y={nameY} textAnchor={anchor} fontSize={18 * fk} fontWeight={600} style={{ fill: "var(--ink)" }}>{label}</text>
                  <text x={lx} y={modelY} textAnchor={anchor} fontSize={13 * fk} style={{ fill: "var(--muted)" }}>{model}</text>
                </>
              );
            })()}
            {runs > 1 && (
              <g>
                <circle cx={p.x + NODE_R * 0.76} cy={p.y - NODE_R * 0.76} r={11} style={{ fill: "var(--sup)" }} />
                <text x={p.x + NODE_R * 0.76} y={p.y - NODE_R * 0.76 + 4} textAnchor="middle" fontSize={12} fontWeight={700} style={{ fill: "var(--sup-fill)" }}>{runs}</text>
              </g>
            )}
            {s.unverified[id] ? (
              <g>
                <title>{`${s.unverified[id]} evidence item(s) not found in any tool output`}</title>
                <circle cx={p.x + NODE_R * 0.76} cy={p.y + NODE_R * 0.76} r={10} style={{ fill: "var(--red)" }} />
                <text x={p.x + NODE_R * 0.76} y={p.y + NODE_R * 0.76 + 4.5} textAnchor="middle" fontSize={13} fontWeight={800} style={{ fill: "var(--panel)" }}>!</text>
              </g>
            ) : null}
            {sats.map((t, i) => {
              const a = -Math.PI / 2 + i * 0.75, r = NODE_R + 20;
              const cx = p.x + r * Math.cos(a), cy = p.y + r * Math.sin(a);
              return (
                <g key={i}>
                  <circle cx={cx} cy={cy} r={5} style={{ fill: "var(--go)" }} />
                  <text x={p.x + (r + 11) * Math.cos(a)} y={p.y + (r + 11) * Math.sin(a) + 4} fontSize={11} textAnchor={Math.cos(a) < 0 ? "end" : "start"} style={{ fill: "var(--muted)" }}>
                    <title>{t}</title>{t.length > 12 ? t.slice(0, 11) + "…" : t}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}

      <g ref={fxRef} />
    </svg>
  );
}
