import { useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  X, ArrowSquareOut, Terminal, Wrench, CheckCircle, WarningOctagon, Signature, ChatCircleDots, Hourglass, Play, Compass, Cube,
} from "@phosphor-icons/react";
import { engine, inr, unwrapCall } from "../engine/engine";
import { useEngine } from "../engine/useEngine";
import { useFocus, setFocus } from "../engine/focus";
import { AGENTS, INFO, WHO } from "../engine/constants";
import type { NsEvent } from "../engine/types";
import { Approval } from "./RightColumn";
import { Pill } from "./Header";
import { clock, ease, mmss } from "../lib/format";

const STATE: Record<string, { label: string; tone: string }> = {
  running: { label: "Working", tone: "go" }, waiting: { label: "Needs you", tone: "amber" }, done: { label: "Done", tone: "go" },
  failed: { label: "Failed", tone: "red" }, skipped: { label: "Not needed", tone: "muted" }, interrupted: { label: "Cut off", tone: "red" },
};

const LABELS: Record<string, string> = {
  root_cause: "Root cause", suspect_commit: "Suspect commit", suspect_files: "Suspect files", failing_step: "Failing step",
  reproduced: "Reproduced", runnable: "Can run here", test_file: "Test file", disproved_reason: "Why not reproduced", chosen: "Chosen",
  fix_needed: "Code fix needed", action_taken: "Change made", result: "Result", denied: "Denied", recovered: "Recovered",
  passed: "Tests passed", failing_tests: "Failing tests", pr_url: "Pull request", pr_number: "PR number", branch: "Branch",
  verdict: "Verdict", comments: "Comments", ci_passed: "CI passed", merged: "Merged", canary_ok: "Canary healthy",
  promoted: "Promoted", real_incident: "Real incident", severity: "Severity", service: "Service", category: "Category",
  external: "Outside our system", confidence: "Confidence", unverified_evidence: "Unverified evidence",
};
const LONG: Record<string, string> = {
  run_output: "Test run output", output: "Output", test_output: "Test output", patch: "The change", postmortem_md: "Postmortem",
  test_code: "Reproduction test",
};
const SKIP = new Set(["summary", "evidence", "options", "files", "mitigation", "timeline", "numbers", "before", "after", "new_tool", "sources", "args", ...Object.keys(LONG)]);

function Value({ k, v }: { k: string; v: any }) {
  if (typeof v === "boolean") {
    const good = k === "denied" || k === "external" ? !v : v;
    return <span className="font-semibold" style={{ color: good ? "var(--go-ink)" : "var(--red-ink)" }}>{v ? "Yes" : "No"}</span>;
  }
  if (k === "pr_url") return <a href={v} target="_blank" rel="noopener">{v}</a>;
  if (k === "confidence") return <>{Math.round(Number(v) * 100)}%</>;
  if (Array.isArray(v)) return <>{v.map((x, i) => <div key={i}>{typeof x === "string" ? x : JSON.stringify(x)}</div>)}</>;
  if (v && typeof v === "object") return <code className="font-mono text-[12.5px]">{JSON.stringify(v).slice(0, 300)}</code>;
  return <>{String(v)}</>;
}

function Answer({ o }: { o: Record<string, any> }) {
  const rows = Object.entries(o).filter(([k, v]) => !SKIP.has(k) && v !== "" && v != null);
  return (
    <>
      <p className="m-0 text-[16px] leading-[1.5] font-medium text-ink [text-wrap:pretty]">{o.summary}</p>
      {rows.length > 0 && (
        <dl className="m-0 mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13.5px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{LABELS[k] || k.replace(/_/g, " ")}</dt>
              <dd className="m-0 min-w-0 break-words text-ink-2"><Value k={k} v={v} /></dd>
            </div>
          ))}
        </dl>
      )}
      {Array.isArray(o.options) && o.options.length > 0 && (
        <div className="mt-4">
          <h4 className="m-0 mb-1.5 text-[13px] font-semibold text-ink-2">Options it considered</h4>
          <div className="overflow-hidden rounded-xl hairline">
            {o.options.map((x: any, i: number) => {
              const chosen = x.action === o.chosen || i === 0;
              return (
                <div key={i} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 px-3 py-2.5 text-[13px] [&+&]:border-t [&+&]:border-line"
                  style={chosen ? { background: "var(--panel-2)" } : undefined}>
                  <div className="font-semibold text-ink">{x.action}</div>
                  <div className="text-right text-muted">risk {x.risk} · {x.reversible ? "reversible" : "not reversible"}</div>
                  {x.tool && <code className="col-span-2 font-mono text-[12px] text-ink-2">{x.tool}({Object.entries(x.args || {}).map(([k, v]) => `${k}=${v}`).join(", ")})</code>}
                  <div className="col-span-2 text-[12.5px]">
                    {x.speculative
                      ? <span className="rounded-md px-1.5 py-0.5 font-semibold" style={{ background: "var(--red-soft)", color: "var(--red-ink)" }}>Guess, no evidence</span>
                      : <span className="text-muted">{x.evidence}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {Array.isArray(o.evidence) && o.evidence.length > 0 && (
        <div className="mt-4">
          <h4 className="m-0 mb-1.5 text-[13px] font-semibold text-ink-2">Evidence</h4>
          <ul className="m-0 list-none space-y-2 p-0">
            {o.evidence.map((e: any, i: number) => {
              const text = typeof e === "object" ? e.text || e.detail || JSON.stringify(e) : String(e);
              const unverified = e?.verified === false;
              return (
                <li key={i} className="rounded-lg py-1 pl-3 text-[13px] text-ink-2"
                  style={{ boxShadow: `inset 2px 0 0 ${unverified ? "var(--red)" : "var(--go)"}` }}>
                  <div className="break-words">{text}</div>
                  <div className="mt-0.5 text-[12px] text-muted">
                    {e?.source}{e?.link && <> · <a href={e.link} target="_blank" rel="noopener">open</a></>}
                    {unverified ? <span className="ml-1 font-semibold" style={{ color: "var(--red-ink)" }}>not found in any tool output</span>
                      : e?.verified ? " · checked against the tool output" : ""}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {Object.entries(LONG).map(([k, title]) => o[k] ? (
        <div key={k} className="mt-4">
          <h4 className="m-0 mb-1.5 text-[13px] font-semibold text-ink-2">{title}</h4>
          <pre className="scroll m-0 max-h-[260px] overflow-auto rounded-xl bg-panel-2 p-3 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap break-words text-ink-2 hairline">{String(o[k])}</pre>
        </div>
      ) : null)}
    </>
  );
}

type Step = { key: string; t: string; icon: typeof Wrench; tone: string; title: string; code?: string; result?: string };

function resultText(r: any): string {
  let p = r;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { return p; } }
  if (p && typeof p === "object" && p.response && "result" in p.response) return `exit code ${p.response.exitCode}\n${p.response.result}`;
  return typeof p === "string" ? p : JSON.stringify(p, null, 1);
}

function stepsFor(events: NsEvent[], stage: string): Step[] {
  const out: Step[] = [];
  events.forEach((e, i) => {
    if (e.stage !== stage) return;
    const x = e.data || {};
    const add = (s: Omit<Step, "key" | "t">) => out.push({ key: `${i}`, t: e.ts, ...s });
    switch (e.kind) {
      case "stage.started": add({ icon: Play, tone: "var(--muted)", title: x.attempt > 1 ? `Started again (attempt ${x.attempt})` : "Started" }); break;
      case "tool.call": {
        const c = unwrapCall(String(x.tool || ""), x.args);
        const exec = c.tool === "exec";
        add({ icon: exec ? Terminal : Wrench, tone: "var(--data)", title: exec ? (c.args?.intent || "Ran a command in the sandbox") : c.tool,
          code: exec ? c.args?.command : Object.entries(c.args || {}).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("  ") });
        break;
      }
      case "tool.result": {
        const real = unwrapCall(String(x.tool || ""), x.args).tool;
        for (let j = out.length - 1; j >= 0; j--) {
          const s = out[j];
          if (s.result === undefined && (s.title === real || (real === "exec" && s.icon === Terminal))) { s.result = resultText(x.result); break; }
        }
        break;
      }
      case "sandbox": add({ icon: Cube, tone: "var(--data)", title: "Started a Daytona sandbox: isolated, no secrets, no access to the live shop" }); break;
      case "subagent": add({ icon: Compass, tone: "var(--muted)", title: e.text }); break;
      case "evidence.unverified": add({ icon: WarningOctagon, tone: "var(--red)", title: e.text }); break;
      case "stage.waiting": add({ icon: Hourglass, tone: "var(--muted)", title: e.text }); break;
      case "stage.retry": case "stage.failed": add({ icon: WarningOctagon, tone: "var(--red)", title: e.text }); break;
      case "approval.requested": {
        const c = unwrapCall(String(x.tool || ""), x.args);
        add({ icon: Signature, tone: "var(--amber)", title: `Asked you before running ${c.tool}`, code: JSON.stringify(c.args) });
        break;
      }
      case "approval.decided": add({ icon: Signature, tone: x.status === "approved" ? "var(--go)" : "var(--red)", title: e.text }); break;
      case "agent.question": case "agent.sendback": add({ icon: ChatCircleDots, tone: "var(--sup)", title: e.text }); break;
      case "stage.done": add({ icon: CheckCircle, tone: "var(--go)", title: "Answered" }); break;
    }
  });
  return out;
}

function AgentDetail({ id }: { id: string }) {
  const s = useEngine();
  const agent = AGENTS.find((a) => a.id === id);
  const team = s.team.find((t) => t.stage === id);
  const st = s.status[id];
  const info = useMemo(() => {
    let output: any = null, session = "", cost = 0, spent = 0, start = 0, calls = 0;
    for (const e of s.events) {
      if (e.stage !== id) continue;
      const t = Date.parse(e.ts);
      if (e.kind === "stage.started") start = t;
      if (e.kind === "stage.session") session = e.data?.url || session;
      if (e.kind === "tool.call") calls++;
      if (e.kind === "stage.done" || e.kind === "stage.failed") {
        if (start) { spent += t - start; start = 0; }
        if (e.kind === "stage.done") { output = e.data?.output; cost += Number(e.data?.cost_usd || 0); }
      }
    }
    if (start) spent += (s.tEnd || s.lastTs || start) - start;
    return { output, session, cost, spent, calls };
  }, [s.events, s.lastTs, s.tEnd, id]);
  const steps = useMemo(() => stepsFor(s.events, id), [s.events, id]);
  const state = st ? STATE[st] : { label: "Not started", tone: "muted" };

  return (
    <>
      <div className="flex items-center gap-3">
        <h2 className="m-0 text-[21px] font-semibold tracking-[-0.02em]">{agent?.label || id}</h2>
        <Pill tone={state.tone} pulse={st === "running" || st === "waiting"}>{state.label}</Pill>
      </div>
      <p className="m-0 mt-1.5 text-[14px] leading-[1.5] text-ink-2">{team?.job || INFO[id]}</p>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {[["runs", String(s.runs[id] || 0)], ["time", info.spent ? mmss(info.spent) : "—"], ["tool calls", String(info.calls)], ["cost", `₹${inr(info.cost).toFixed(2)}`]].map(([k, v]) => (
          <div key={k} className="rounded-xl bg-panel-2 px-3 py-2 hairline">
            <div className="font-mono text-[16px] font-medium">{v}</div>
            <div className="text-[11.5px] text-muted">{k}</div>
          </div>
        ))}
      </div>
      <dl className="m-0 mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-muted">Model</dt><dd className="m-0 text-ink-2">{agent?.model} ({team?.model || "?"} tier), reasoning high</dd>
        <dt className="text-muted">Runs code</dt><dd className="m-0 text-ink-2">{team?.sandbox ? "Yes, in a Daytona sandbox" : "No"}</dd>
        <dt className="text-muted">Asks you before</dt><dd className="m-0 text-ink-2">{team?.asks_before?.length ? team.asks_before.join(", ") : "Nothing: it only reads"}</dd>
        <dt className="text-muted">Tools</dt>
        <dd className="m-0 text-ink-2">{Object.entries(team?.tools || {}).map(([srv, ts]) => <div key={srv}><span className="text-muted">{srv}:</span> {ts.join(", ")}</div>)}</dd>
      </dl>
      {s.unverified[id] ? <p className="m-0 mt-3 rounded-lg px-3 py-2 text-[13px] font-medium" style={{ background: "var(--red-soft)", color: "var(--red-ink)" }}>
        {s.unverified[id]} evidence item(s) were not found in any tool output.</p> : null}
      {info.session && <a href={info.session} target="_blank" rel="noopener" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium">Full session in TrueForge<ArrowSquareOut size={12} /></a>}

      {info.output && (
        <section className="mt-5">
          <h3 className="m-0 mb-2 text-[15px] font-semibold">Its answer</h3>
          <Answer o={info.output} />
        </section>
      )}

      <section className="mt-5">
        <h3 className="m-0 mb-2 text-[15px] font-semibold">What it did</h3>
        {!steps.length && <p className="m-0 text-[13.5px] text-muted">Nothing yet in this incident.</p>}
        <ol className="m-0 list-none space-y-1 p-0">
          {steps.map((x) => {
            const Icon = x.icon;
            return (
              <li key={x.key} className="flex gap-3 rounded-lg px-1 py-1.5">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-panel-2 hairline" style={{ color: x.tone }}><Icon size={14} weight="bold" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13.5px] font-medium text-ink [overflow-wrap:anywhere]">{x.title}</span>
                    <span className="ml-auto shrink-0 font-mono text-[11.5px] text-dim">{clock(x.t)}</span>
                  </div>
                  {x.code && <code className="mt-0.5 block font-mono text-[12px] leading-[1.5] break-all text-ink-2">{x.code.slice(0, 600)}</code>}
                  {x.result !== undefined && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[12.5px] font-medium" style={{ color: "var(--data-ink)" }}>What it got back</summary>
                      <pre className="scroll m-0 mt-1 max-h-[240px] overflow-auto rounded-lg bg-panel-2 p-2.5 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap break-words text-ink-2 hairline">{x.result.slice(0, 6000)}</pre>
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}

function SupervisorDetail() {
  const s = useEngine();
  const decisions = useMemo(() => s.events.filter((e) => e.kind === "supervisor.decision" || e.kind === "supervisor.overruled"), [s.events]);
  const ai = decisions.filter((e) => e.data?.by === "supervisor").length;
  const rules = decisions.filter((e) => e.kind === "supervisor.decision").length - ai;
  return (
    <>
      <h2 className="m-0 text-[21px] font-semibold tracking-[-0.02em]">Supervisor</h2>
      <p className="m-0 mt-1.5 text-[14px] leading-[1.5] text-ink-2">
        After every step it reads each agent's latest answer and picks the next move: run an agent, ask one a question, send work
        back, hand over to a person, or finish. Code checks every choice against the guardrails. When there is only one sensible
        move, the rules decide and the AI is not called, which saves time and money.
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {[["decisions", decisions.length], ["needed judgement", ai], ["clear next steps", rules]].map(([k, v]) => (
          <div key={k} className="rounded-xl bg-panel-2 px-3 py-2 hairline">
            <div className="font-mono text-[16px] font-medium">{v}</div>
            <div className="text-[11.5px] text-muted">{k}</div>
          </div>
        ))}
      </div>
      <section className="mt-5">
        <h3 className="m-0 mb-2 text-[15px] font-semibold">Its decisions</h3>
        {!decisions.length && <p className="m-0 text-[13.5px] text-muted">No decisions yet in this incident.</p>}
        <ol className="m-0 list-none space-y-2 p-0">
          {decisions.map((e, i) => {
            const byAi = e.data?.by === "supervisor";
            const over = e.kind === "supervisor.overruled";
            return (
              <li key={i} className="rounded-xl px-3 py-2.5 hairline" style={byAi ? { background: "color-mix(in oklab, var(--sup) 8%, var(--panel-2))" } : undefined}>
                <div className="flex items-baseline gap-2 text-[12.5px]">
                  <span className="font-semibold" style={{ color: over ? "var(--red-ink)" : byAi ? "var(--sup)" : "var(--muted)" }}>
                    {over ? "Guardrail overruled it" : byAi ? "Supervisor (AI)" : "Rules"}
                  </span>
                  <span className="ml-auto font-mono text-[11.5px] text-dim">{clock(e.ts)}</span>
                </div>
                <p className="m-0 mt-1 text-[13.5px] text-ink [text-wrap:pretty]">{e.text}</p>
                {e.data?.asked_because && <p className="m-0 mt-1 text-[12.5px] text-muted">Asked because {e.data.asked_because}.</p>}
                {e.data?.url && <a href={e.data.url} target="_blank" rel="noopener" className="mt-1 inline-flex items-center gap-1 text-[12.5px] font-medium">Its reasoning in TrueForge<ArrowSquareOut size={11} /></a>}
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}

/** Slide-over for the pinned agent or the supervisor. The approval card stays on top while a change waits. */
export default function AgentPanel() {
  const [, , pinned] = useFocus();
  const s = useEngine();
  const open = !!pinned && (pinned === "supervisor" || AGENTS.some((a) => a.id === pinned));
  const close = () => { engine.setFollow(false); setFocus(null, true); };
  return (
    <AnimatePresence>
      {open && (
        <motion.aside key="agent-panel" role="dialog" aria-label={`${WHO[pinned!] || pinned} details`}
          className="fixed top-[112px] right-3 bottom-3 z-30 flex w-[min(560px,40vw)] min-w-[420px] flex-col rounded-[18px] bg-panel"
          style={{ boxShadow: "var(--shadow-lift)" }}
          initial={{ x: "105%" }} animate={{ x: 0 }} exit={{ x: "105%" }} transition={{ type: "spring", duration: 0.45, bounce: 0 }}>
          <div className="flex items-center gap-2 border-b border-line px-5 py-3">
            <span className="text-[13px] text-muted">{s.inc ? s.inc.id : ""}</span>
            {/* the panel covers the map's toggle, so it has its own */}
            <button onClick={() => engine.setFollow(!s.follow)} aria-pressed={s.follow}
              className="ml-auto inline-flex h-8 items-center gap-2 rounded-lg px-3 text-[13px] font-semibold transition-colors duration-150 hairline hover:bg-panel-3"
              style={{ color: s.follow ? "var(--go-ink)" : "var(--ink-2)", background: s.follow ? "var(--go-soft)" : undefined }}>
              <span className="size-2 rounded-full" style={{ background: s.follow ? "var(--go)" : "var(--dim)" }} />Follow the live agent
            </button>
            <button onClick={close} aria-label="Close" className="grid size-9 place-items-center rounded-lg text-muted transition-colors hover:bg-panel-3 hover:text-ink">
              <X size={18} />
            </button>
          </div>
          <div className="scroll min-h-0 flex-1 overflow-y-auto p-5">
            <div className="mb-4 empty:hidden"><Approval /></div>
            <AnimatePresence mode="wait">
              <motion.div key={pinned} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.2, ease }}>
                {pinned === "supervisor" ? <SupervisorDetail /> : <AgentDetail id={pinned!} />}
              </motion.div>
            </AnimatePresence>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
