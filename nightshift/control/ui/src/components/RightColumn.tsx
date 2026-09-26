import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Signature, Compass, Robot, UserCircle, WarningOctagon, Info, ChatCircleDots, ArrowBendUpLeft, ChatsCircle, Files,
  MagnifyingGlass, Path, ChartLine, GitCommit, GithubLogo, Storefront, Books, Graph, ArrowSquareOut, XCircle, CheckCircle,
} from "@phosphor-icons/react";
import { engine, describeArgs } from "../engine/engine";
import { useEngine } from "../engine/useEngine";
import { useFocus } from "../engine/focus";
import { UNDO, WHO } from "../engine/constants";
import type { EvidenceItem, FeedItem } from "../engine/types";
import { BorderBeam } from "./vendor/BorderBeam";
import { PanelHead } from "./LeftColumn";
import { clock, ease } from "../lib/format";

// ---------------- approval ----------------
export function Approval() {
  const s = useEngine();
  const a = s.pending[0];
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<null | "approve" | "deny">(null);
  const [error, setError] = useState<string | null>(null);
  const live = s.mode === "live";
  const args = a && a.args && typeof a.args === "object" ? Object.entries(a.args) : [];
  const ctx = a?.context || {};
  const liveNow = ctx.live;
  const over = liveNow ? liveNow.error_pct > (liveNow.limit_pct ?? 5) : false;
  const opt = ctx.plan_option;

  async function decide(d: "approve" | "deny") {
    if (!a) return;
    setBusy(d);
    setError(null);
    try { setError(await engine.decide(a.id, d, d === "deny" ? reason || "Denied from the dashboard" : "")); }
    finally { setBusy(null); if (d === "approve") setReason(""); }
  }

  return (
    <AnimatePresence initial={false}>
      {a && (
        <motion.section key={a.id} layout
          initial={{ opacity: 0, y: -16, scale: 0.97, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -10, scale: 0.98, filter: "blur(4px)", transition: { duration: 0.2 } }}
          transition={{ type: "spring", duration: 0.55, bounce: 0.12 }}
          className="relative flex min-h-[200px] shrink flex-col overflow-hidden rounded-[18px] p-5"
          style={{ background: "color-mix(in oklab, var(--amber) 7%, var(--panel))", boxShadow: "var(--shadow-lift), inset 0 0 0 1px color-mix(in oklab, var(--amber) 42%, transparent)" }}
          aria-live="assertive">
          <BorderBeam size={200} duration={6} colorFrom="var(--amber)" />
          <div className="flex shrink-0 items-center gap-2 text-[13px] font-semibold" style={{ color: "var(--amber-ink)" }}>
            <Signature size={18} weight="fill" />
            Paused before a production change
            <span className="ml-auto rounded-md px-2 py-0.5 text-[12px] font-medium text-ink-2 hairline">{WHO[a.stage] || a.stage}</span>
          </div>
          <h3 className="m-0 mt-3 shrink-0 text-[22px] font-semibold tracking-[-0.02em]">
            Allow <span className="font-mono text-[21px]">{a.tool}</span>?
          </h3>
          {args.length > 0 && (
            <dl className="m-0 mt-3 grid shrink-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl bg-panel px-3.5 py-3 font-mono text-[13.5px] hairline">
              {args.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="m-0 truncate text-ink">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="scroll -mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
          <dl className="m-0 mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13.5px] leading-[1.45]">
            <dt className="text-muted">Right now</dt>
            <dd className="m-0 min-w-0 [overflow-wrap:anywhere] text-ink-2">
              {liveNow ? <>
                <span className="font-semibold" style={{ color: over ? "var(--red-ink)" : "var(--go-ink)" }}>{liveNow.error_pct}% errors</span>
                {" "}on {ctx.service}{liveNow.failed_requests != null && <>, {liveNow.failed_requests} failed requests in 2 min</>} (limit {liveNow.limit_pct ?? 5}%)
              </> : <span className="text-muted">No live numbers for {ctx.service || "this service"}</span>}
            </dd>
            {ctx.diagnosis && <><dt className="text-muted">Why</dt><dd className="m-0 line-clamp-3 min-w-0 [overflow-wrap:anywhere] text-ink-2" title={ctx.diagnosis}>{ctx.diagnosis}</dd></>}
            {opt && <>
              <dt className="text-muted">Planner says</dt>
              <dd className="m-0 min-w-0 [overflow-wrap:anywhere] text-ink-2">
                <span className="line-clamp-3" title={opt.blast_radius || ""}>Risk {opt.risk || "?"}, {opt.reversible ? "reversible" : "not reversible"}{opt.blast_radius ? <>; affects {opt.blast_radius}</> : null}.</span>
                {opt.speculative
                  ? <span className="ml-1 inline-flex items-center rounded-md px-1.5 py-0.5 text-[12px] font-semibold" style={{ background: "var(--red-soft)", color: "var(--red-ink)" }}>Guess, no evidence</span>
                  : opt.evidence ? <span className="line-clamp-3 text-muted" title={opt.evidence}>Evidence: {opt.evidence}</span> : null}
              </dd>
            </>}
            <dt className="text-muted">To undo</dt>
            <dd className="m-0 min-w-0 [overflow-wrap:anywhere] text-ink-2">{ctx.undo || a.undo || UNDO[a.tool] || "Check the arguments before approving."}</dd>
          </dl>
          <p className="m-0 mt-3 text-[13px] text-muted">
            {s.me?.name && <>Your decision is recorded as <span className="font-semibold text-ink-2">{s.me.name}</span>.</>}
            {s.inc?.jira_url && <> Or reply <code className="text-ink-2">/approve</code> on <a href={s.inc.jira_url} target="_blank" rel="noopener">{s.inc.jira_key}</a>.</>}
          </p>
          </div>
          <div className="mt-4 flex shrink-0 gap-2">
            <button disabled={!live || !!busy} onClick={() => decide("approve")}
              className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl text-[15px] font-semibold transition-[transform,opacity,filter] duration-150 enabled:hover:brightness-105 enabled:active:scale-[0.98] disabled:opacity-95"
              style={{ background: "var(--amber)", color: "#1a1204" }}>
              <CheckCircle size={18} weight="bold" />{busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button disabled={!live || !!busy} onClick={() => decide("deny")}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-semibold text-ink transition-[transform,background-color] duration-150 hairline enabled:hover:bg-panel-3 enabled:active:scale-[0.98] disabled:opacity-55">
              <XCircle size={18} />{busy === "deny" ? "Denying…" : "Deny"}
            </button>
          </div>
          <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={!live}
            placeholder={live ? "Reason, sent with a denial" : "Replay: decisions are read-only"}
            className="mt-2 h-10 w-full shrink-0 rounded-xl bg-panel px-3.5 text-[13.5px] text-ink outline-none transition-shadow duration-150 hairline placeholder:text-dim focus:shadow-[inset_0_0_0_1.5px_var(--amber)] disabled:opacity-70" />
          {error && <p className="m-0 mt-2 text-[13px] font-medium" style={{ color: "var(--red-ink)" }}>{error}</p>}
          {!live && <p className="m-0 mt-2 shrink-0 text-[12px] text-dim [@media(max-height:899px)]:hidden">Showing {describeArgs(a.args) || a.tool} as it was requested.</p>}
        </motion.section>
      )}
    </AnimatePresence>
  );
}

// ---------------- conversation ----------------
const TONE: Record<FeedItem["tone"], { icon: typeof Robot; color: string; bg: string }> = {
  sup: { icon: Compass, color: "var(--sup)", bg: "color-mix(in oklab, var(--sup) 12%, transparent)" },
  agent: { icon: Robot, color: "var(--go-ink)", bg: "var(--go-soft)" },
  human: { icon: UserCircle, color: "var(--amber-ink)", bg: "var(--amber-soft)" },
  bad: { icon: WarningOctagon, color: "var(--red-ink)", bg: "var(--red-soft)" },
  sys: { icon: Info, color: "var(--muted)", bg: "var(--panel-3)" },
  ask: { icon: ChatCircleDots, color: "var(--amber-ink)", bg: "var(--amber-soft)" },
  back: { icon: ArrowBendUpLeft, color: "var(--amber-ink)", bg: "var(--amber-soft)" },
};

function FocusChip() {
  const [, setFocus, pinned] = useFocus();
  if (!pinned) return null;
  return (
    <button onClick={() => setFocus(null, true)} className="inline-flex items-center gap-1.5 rounded-md bg-panel-3 px-2 py-0.5 text-[12px] font-medium text-ink-2 transition-colors hover:text-ink">
      {WHO[pinned] || pinned}<XCircle size={13} />
    </button>
  );
}

export function Conversation() {
  const s = useEngine();
  const [focus] = useFocus();
  const items = focus ? s.feed.filter((f) => f.stage === focus || f.who.startsWith(WHO[focus] || focus)) : s.feed;
  return (
    <section className="panel flex min-h-[120px] flex-[1.25] flex-col overflow-hidden">
      <PanelHead icon={<ChatsCircle size={18} />} title="Conversation" sub="Who decided what, and why."
        right={<div className="flex items-center gap-2"><FocusChip /><span className="font-mono text-[12.5px] text-dim">{items.length}</span></div>} />
      <ol className="scroll m-0 min-h-0 flex-1 list-none space-y-1 overflow-y-auto px-3 pb-3">
        <AnimatePresence initial={false}>
          {items.map((f) => {
            const t = TONE[f.tone];
            const Icon = t.icon;
            return (
              <motion.li key={f.key} layout="position"
                initial={{ opacity: 0, y: -10, filter: "blur(5px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0 }} transition={{ duration: 0.35, ease }}
                className="flex gap-3 rounded-xl px-2.5 py-2.5 transition-colors duration-200 hover:bg-panel-3">
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg" style={{ background: t.bg, color: t.color }}>
                  <Icon size={16} weight="bold" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-semibold" style={{ color: t.color }}>{f.who}</span>
                    <span className="ml-auto shrink-0 font-mono text-[11.5px] text-dim">{clock(f.ts)}</span>
                  </div>
                  <p className="m-0 mt-0.5 text-[14px] leading-[1.45] text-ink-2 [text-wrap:pretty]">{f.msg}</p>
                  {f.link && <a href={f.link.href} target="_blank" rel="noopener" className="mt-1 inline-flex items-center gap-1 text-[12.5px] font-medium no-underline hover:underline">{f.link.label}<ArrowSquareOut size={12} /></a>}
                </div>
              </motion.li>
            );
          })}
        </AnimatePresence>
        {!items.length && (
          <li className="px-3 py-8 text-center text-[13.5px] text-muted">
            {focus ? "Nothing from this agent yet." : "When an incident opens, every decision, question and answer lands here with the reason behind it."}
          </li>
        )}
      </ol>
    </section>
  );
}

// ---------------- evidence ----------------
const SRC: Record<string, { icon: typeof Path; label: string }> = {
  opensearch: { icon: MagnifyingGlass, label: "OpenSearch" }, jaeger: { icon: Path, label: "Jaeger" }, prometheus: { icon: ChartLine, label: "Prometheus" },
  git: { icon: GitCommit, label: "Git" }, github: { icon: GithubLogo, label: "GitHub" }, shop: { icon: Storefront, label: "Live shop" },
  knowledge: { icon: Books, label: "Knowledge" }, codegraph: { icon: Graph, label: "Code graph" },
};

function TraceLink({ id, link }: { id?: string; link?: string }) {
  if (!id) return null;
  return <a href={link || `http://localhost:8080/jaeger/ui/trace/${id}`} target="_blank" rel="noopener" className="ml-1 inline-flex items-center gap-0.5 no-underline hover:underline">trace<ArrowSquareOut size={11} /></a>;
}
const Line = ({ bad, children, link }: { bad?: boolean; children: React.ReactNode; link?: React.ReactNode }) => (
  <div className="flex min-w-0 items-baseline gap-1 font-mono text-[12.5px] leading-[1.6]" style={{ color: bad ? "var(--red-ink)" : "var(--ink-2)" }}>
    <span className="min-w-0 flex-1 truncate">{children}</span>{link && <span className="shrink-0">{link}</span>}
  </div>
);

function Items({ d }: { d: EvidenceItem }) {
  const it = d.items;
  if (!it || typeof it === "string") return <Line>{String(it ?? "").slice(0, 400)}</Line>;
  if (it.error) return <Line bad>{it.error}</Line>;
  switch (d.tool) {
    case "query_logs":
      return <>
        <div className="mb-1 text-[12px] text-muted">{it.service} · {it.count} lines · {Object.entries(it.by_level || {}).map(([k, v]) => `${v} ${k}`).join(", ")}</div>
        {(it.lines || []).slice(0, 5).map((l: any, i: number) => (
          <Line key={i} bad={/error|fatal|warn/i.test(l.level || "")} link={<TraceLink id={l.trace_id} />}>{(l.time || "").slice(11, 19)} {l.level} · {l.message}</Line>))}
      </>;
    case "get_traces":
      return <>{(Array.isArray(it) ? it : []).slice(0, 3).map((t: any) => (
        <Line key={t.trace_id} bad={!!t.failing_step} link={<TraceLink id={t.trace_id} link={t.link} />}>{t.root} · {t.duration_ms} ms{t.failing_step ? ` · ${t.failing_step.service}: ${t.failing_step.message || ""}` : ""}</Line>))}
        {!(Array.isArray(it) && it.length) && <Line>No matching traces.</Line>}</>;
    case "get_trace": {
      const bad = (it.steps || []).filter((x: any) => x.error);
      return <>{(bad.length ? bad : it.steps || []).slice(0, 4).map((x: any, i: number) => <Line key={i} bad={x.error}>{x.at_ms} ms · {x.service} {x.operation}{x.message ? `: ${x.message}` : ""}</Line>)}<TraceLink id={it.trace_id} link={it.link} /></>;
    }
    case "get_error_rates": {
      const rows = Object.entries(it).filter(([, v]: any) => v && typeof v === "object").sort((a: any, b: any) => b[1].error_pct - a[1].error_pct).slice(0, 5);
      return <table className="w-full border-collapse font-mono text-[12.5px]"><tbody>
        {rows.map(([k, v]: any) => (
          <tr key={k} className="text-ink-2"><td className="py-0.5 pr-2">{k}</td>
            <td className="py-0.5 text-right" style={{ color: v.over_threshold ? "var(--red-ink)" : undefined }}>{v.error_pct}%</td>
            <td className="py-0.5 text-right text-muted">{v.rps}/s</td><td className="py-0.5 text-right text-dim">p95 {v.p95_ms ?? "–"}</td></tr>))}
      </tbody></table>;
    }
    case "get_recent_deploys":
      return <>{[...(it.deploys || []).slice(-2).map((x: any, i: number) => <Line key={"d" + i}>{x.action} · {x.service} → {x.commit}</Line>),
        ...(it.recent_commits || []).slice(0, 3).map((c: any) => <Line key={c.commit}>{c.commit} · {c.author} · {c.message}</Line>)]}</>;
    case "synthetic_check":
      return <>{(it.steps || []).map((x: any) => <Line key={x.step} bad={!x.ok}>{x.ok ? "ok" : "failed"} · {x.step}{x.status ? ` · ${x.status}` : ""} {x.detail || ""}</Line>)}</>;
    default:
      return <Line>{JSON.stringify(it).slice(0, 300)}</Line>;
  }
}

export function Evidence() {
  const s = useEngine();
  const [focus] = useFocus();
  const items = focus ? s.evidence.filter((e) => e.stage === focus) : s.evidence;
  return (
    <section className={`panel flex min-h-[96px] flex-1 flex-col overflow-hidden ${s.pending.length ? "[@media(max-height:899px)]:hidden" : ""}`}>
      <PanelHead icon={<Files size={18} />} title="Evidence" sub="Exactly what the agents read."
        right={<span className="font-mono text-[12.5px] text-dim">{items.length}</span>} />
      <div className="scroll min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        <AnimatePresence initial={false}>
          {items.map((e) => {
            const src = SRC[e.source] || { icon: Info, label: e.source };
            const Icon = src.icon;
            return (
              <motion.article key={e.key} layout="position" initial={{ opacity: 0, y: -8, scale: 0.99 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0 }} transition={{ duration: 0.35, ease }}
                className="rounded-xl bg-panel-2 px-3.5 py-3 transition-[box-shadow] duration-200 hairline hover:shadow-[inset_0_0_0_1px_var(--line-2)]">
                <header className="mb-1.5 flex min-w-0 items-center gap-2 text-[12.5px]">
                  <Icon size={15} className="shrink-0 text-muted" />
                  <span className="shrink-0 font-semibold text-ink">{src.label}</span>
                  <span className="min-w-0 truncate font-mono text-muted">{e.tool}</span>
                  <span className="ml-auto shrink-0 text-dim max-[1499px]:hidden">{WHO[e.stage || ""] || e.stage} · {clock(e.ts)}</span>
                </header>
                <Items d={e} />
              </motion.article>
            );
          })}
        </AnimatePresence>
        {!items.length && <p className="px-3 py-8 text-center text-[13.5px] text-muted">{focus ? "This agent has not read anything yet." : "Log lines, traces, metrics and commits appear here the moment an agent reads them."}</p>}
      </div>
    </section>
  );
}
