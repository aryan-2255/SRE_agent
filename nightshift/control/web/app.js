// NightShift board. Every event (live from /api/stream, or stored for a past incident) goes through one reducer,
// apply(), into per-agent state; the strips, the detail pane and the timeline are drawn from that state.

const AGENTS = [
  { stage: "triage", name: "Triage", role: "Is it real? How bad?", bay: "understand" },
  { stage: "diagnosis", name: "Diagnosis", role: "Finds the root cause", bay: "understand" },
  { stage: "validation", name: "Validator", role: "Reproduces it in a sandbox", bay: "understand" },
  { stage: "plan", name: "Planner", role: "Options, risk, evidence", bay: "contain" },
  { stage: "mitigation", name: "Mitigator", role: "Makes one approved change", bay: "contain" },
  { stage: "verify", name: "Verifier", role: "Checks it worked", bay: "contain" },
  { stage: "fix", name: "Coder", role: "Writes the permanent fix", bay: "fix" },
  { stage: "test", name: "Tester", role: "Runs it in a clean sandbox", bay: "fix" },
  { stage: "pr", name: "Pull request", role: "Branch, commit, PR", bay: "fix" },
  { stage: "review", name: "Reviewer", role: "Reads the diff", bay: "fix" },
  { stage: "cicd", name: "Release", role: "Merge, canary, promote", bay: "fix" },
  { stage: "postmortem", name: "Postmortem", role: "Writes down what happened", bay: "learn" },
  { stage: "docs", name: "Docs researcher", role: "Provider documentation", bay: "learn" },
];
const BAYS = [
  ["understand", "Understand", "what broke and why"],
  ["contain", "Stop the damage", "every change waits for you"],
  ["fix", "Fix for good", "sandbox, then a pull request"],
  ["learn", "Learn", "so next time is faster"],
];
const NAME = Object.fromEntries(AGENTS.map((a) => [a.stage, a.name]));
NAME.supervisor = "Supervisor";
const STATUS_WORD = { idle: "Not started", running: "Working", waiting: "Waiting for you", done: "Done", failed: "Failed",
  skipped: "Not needed", interrupted: "Interrupted" };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (usd) => "₹" + (usd * 88).toFixed(usd * 88 < 10 ? 2 : 0);
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };
const parse = (x) => { if (typeof x !== "string") return x; try { return JSON.parse(x); } catch { return x; } };
const short = (s, n = 140) => { s = typeof s === "string" ? s : JSON.stringify(s); return s && s.length > n ? s.slice(0, n) + "…" : s || ""; };

let S;
const view = { follow: true, selected: null, mode: "live", team: {}, me: null, watch: null, replayTimers: [] };

function fresh(id) {
  S = { id, inc: null, start: null, end: null, cost: 0, stages: {}, decisions: [], approvals: {}, feed: [], jira: null, sup: { runs: 0, ai: 0 } };
  for (const a of AGENTS) S.stages[a.stage] = { status: "idle", steps: [], runs: [], output: null, cost: 0, last: "", session: null, attempts: 0 };
}
fresh(null);

// ---------------- reducer ----------------
function st(stage) { return S.stages[stage]; }
function step(stage, item) { const s = st(stage); if (s) { s.steps.push(item); s.last = item.line || s.last; } }
function openRun(s, t) { s.runs.push({ start: t, end: null, status: "running" }); }
function closeRun(s, t, status) { const r = s.runs[s.runs.length - 1]; if (r && !r.end) { r.end = t; r.status = status; } }

function apply(ev) {
  const t = ev.ts, d = ev.data || {}, stage = ev.stage, s = stage && S.stages[stage];
  if (ev.incident_id && S.id && ev.incident_id !== S.id) return;
  if (t && !S.start && ev.incident_id) S.start = t;
  switch (ev.kind) {
    case "incident.opened":
      S.feed.push({ t, kind: "open", text: ev.text });
      break;
    case "stage.started":
      if (s) { s.status = "running"; s.attempts = d.attempt || s.attempts + 1; openRun(s, t);
        step(stage, { t, kind: "mark", what: d.attempt > 1 ? `Started again (attempt ${d.attempt})` : "Started", line: "Starting" }); }
      break;
    case "stage.session":
      if (stage === "supervisor") S.sup.runs++;
      else if (s) s.session = d.url;
      break;
    case "sandbox":
      step(stage, { t, kind: "mark", what: "Sandbox started (Daytona): isolated, no secrets, no access to the live shop", line: "Sandbox started" });
      break;
    case "subagent":
      step(stage, { t, kind: "mark", what: ev.text, line: ev.text });
      break;
    case "tool.call": {
      const args = parse(d.args) || {};
      const isExec = d.tool === "exec";
      const what = isExec ? (args.intent || "Ran a command in the sandbox") : d.tool;
      const line = isExec ? `Sandbox: ${args.intent || "command"}` : `${d.tool} ${short(argText(args), 90)}`;
      step(stage, { t, kind: "call", tool: d.tool, what, args, line });
      break;
    }
    case "tool.result": {
      const list = (st(stage) || { steps: [] }).steps;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === "call" && list[i].tool === d.tool && list[i].result == null) { list[i].result = d.result; break; }
      break;
    }
    case "evidence.unverified":
      step(stage, { t, kind: "bad", what: ev.text, line: ev.text });
      break;
    case "stage.waiting":
      step(stage, { t, kind: "mark", what: ev.text, line: ev.text });
      break;
    case "stage.retry":
      step(stage, { t, kind: "bad", what: ev.text, line: "Retrying after an error" });
      break;
    case "stage.done":
      if (s) { s.status = "done"; s.output = d.output || {}; s.cost += d.cost_usd || 0; closeRun(s, t, "done");
        step(stage, { t, kind: "good", what: "Answered", line: ev.text }); s.last = ev.text; }
      break;
    case "stage.failed":
      if (s) { s.status = "failed"; closeRun(s, t, "failed"); step(stage, { t, kind: "bad", what: ev.text, line: ev.text }); }
      break;
    case "stage.skipped":
      if (s && s.status === "idle") s.status = "skipped";
      break;
    case "supervisor.decision": {
      const dec = d.decision || {};
      if (d.by === "supervisor") S.sup.ai++;
      S.decisions.push({ t, text: ev.text, by: d.by || "supervisor", because: d.asked_because, url: d.url, dec });
      S.feed.push({ t, kind: "decision", by: d.by === "rules" ? "Rules" : "Supervisor", text: ev.text, because: d.asked_because, url: d.url });
      break;
    }
    case "supervisor.overruled":
      S.feed.push({ t, kind: "overruled", by: "Guardrail", text: ev.text });
      break;
    case "agent.question": case "agent.sendback": case "agent.answer":
      step(stage, { t, kind: "talk", what: ev.text, line: ev.text });
      S.feed.push({ t, kind: "talk", by: ev.kind === "agent.answer" ? NAME[stage] : "Supervisor", text: ev.text });
      break;
    case "approval.requested":
      S.approvals[d.approval_id] = { id: d.approval_id, stage, tool: d.tool, args: d.args, context: d.context || {}, undo: d.undo, status: "pending", t };
      if (s) { s.status = "waiting"; const r = s.runs[s.runs.length - 1]; if (r && !r.end) r.status = "waiting"; }
      step(stage, { t, kind: "approval", what: `Asked you: ${d.tool}`, args: d.args, line: `Waiting for you to approve ${d.tool}` });
      break;
    case "approval.decided": {
      const a = S.approvals[d.approval_id];
      if (a) a.status = d.status;
      if (s && s.status === "waiting") { s.status = "running"; const r = s.runs[s.runs.length - 1]; if (r && !r.end) r.status = "running"; }
      step(stage, { t, kind: d.status === "approved" ? "good" : "bad", what: ev.text, line: ev.text });
      S.feed.push({ t, kind: d.via === "policy" ? "info" : "person", by: null, text: ev.text });
      break;
    }
    case "approval.reminder":
      S.feed.push({ t, kind: "person", by: "NightShift", text: ev.text });
      break;
    case "jira":
      S.jira = { key: d.key, url: d.url };
      S.feed.push({ t, kind: "info", by: "Jira", text: ev.text, url: d.url });
      break;
    case "cost":
      S.cost = d.total_usd || S.cost;
      break;
    case "incident.mitigated": case "incident.resolved": case "incident.escalated": case "incident.closed": case "incident.resumed": case "incident.symptom":
      if (ev.kind === "incident.symptom" && S.feed.some((f) => f.text === ev.text)) break;
      S.feed.push({ t, kind: ev.kind === "incident.escalated" ? "person" : "info", by: "NightShift", text: ev.text });
      if (S.inc) S.inc.status = { "incident.mitigated": "mitigated", "incident.resolved": "resolved", "incident.escalated": "escalated", "incident.closed": "false_alarm" }[ev.kind] || S.inc.status;
      if (["incident.resolved", "incident.escalated", "incident.closed"].includes(ev.kind)) { S.end = t;
        for (const x of Object.values(S.stages)) if (x.status === "running" || x.status === "waiting") { x.status = "interrupted"; closeRun(x, t, "interrupted"); } }
      if (d.total_usd) S.cost = d.total_usd;
      break;
  }
}

function argText(a) {
  if (!a || typeof a !== "object") return String(a ?? "");
  return Object.entries(a).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
}

// ---------------- loading ----------------
async function load(id, { replay = false } = {}) {
  view.replayTimers.forEach(clearTimeout); view.replayTimers = [];
  fresh(id);
  if (!id) { render(); return; }
  const d = await (await fetch(`/api/incidents/${id}`)).json();
  S.inc = d;
  S.cost = Number(d.total_cost_usd) || 0;
  if (d.jira_key) S.jira = { key: d.jira_key, url: d.jira_url };
  S.start = d.opened_at;
  if (!replay) {
    d.events.forEach(apply);
    for (const a of d.approvals || []) if (S.approvals[a.id]) { S.approvals[a.id].status = a.status; if (a.context) S.approvals[a.id].context = a.context; }
    if (["resolved", "escalated", "false_alarm"].includes(d.status)) S.end = d.resolved_at || d.events.at(-1)?.ts;
    S.inc.status = d.status;
    render();
    return;
  }
  // replay: the same events, time compressed (gaps capped at 1.2 s)
  setMode("replay");
  const status = d.status; S.inc.status = "open"; S.cost = 0;
  let at = 0, prev = null;
  for (const ev of d.events) {
    const gap = prev ? Math.min(1200, (new Date(ev.ts) - new Date(prev)) / 8) : 0;
    at += gap; prev = ev.ts;
    view.replayTimers.push(setTimeout(() => { apply(ev); render(); }, at));
  }
  view.replayTimers.push(setTimeout(() => { S.inc.status = status; setMode("view"); render(); }, at + 400));
  render();
}

function setMode(m) {
  view.mode = m;
  const c = $("conn");
  c.className = "conn " + (m === "live" ? "live" : m === "replay" ? "replay" : "");
  c.textContent = m === "live" ? "Live" : m === "replay" ? "Replaying" : "Viewing a past incident";
}

// ---------------- rendering ----------------
let queued = false;
function render() { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); } }

function draw() {
  drawHeader(); drawStrips(); drawDetail(); drawTrack();
}

function drawHeader() {
  const inc = S.inc;
  if (!inc) { $("incident").innerHTML = `<span class="quiet-line">All quiet. The watcher is checking every 5 seconds.</span>`; $("cost").textContent = "₹0"; $("elapsed").textContent = "–"; return; }
  const status = inc.status || "open";
  const word = { open: "Being handled", mitigated: "Users no longer affected", resolved: "Resolved", escalated: "Handed to a person", false_alarm: "False alarm" }[status] || status;
  $("incident").innerHTML = `<span class="inc-id">${esc(inc.id)}</span><span class="inc-sum" title="${esc(inc.summary)}">${esc(inc.summary)}</span>
    <span class="state ${esc(status)}">${word}</span>${inc.severity ? `<span class="state escalated">${esc(inc.severity)}</span>` : ""}`;
  $("cost").textContent = inr(S.cost);
  $("elapsed").textContent = S.start ? dur((S.end ? new Date(S.end) : new Date()) - new Date(S.start)) : "–";
}

function stripHTML(a) {
  const s = S.stages[a.stage], team = Object.values(view.team).find((t) => t.stage === a.stage) || {};
  const calls = s.steps.filter((x) => x.kind === "call").length;
  const took = s.runs.reduce((n, r) => n + ((r.end ? new Date(r.end) : new Date()) - new Date(r.start)), 0);
  const lines = s.steps.filter((x) => x.line).slice(-2).map((x) => x.line);
  const first = s.status === "done" ? (s.output?.summary || s.last) : lines.at(-1);
  const second = s.status === "done" ? "" : lines.length > 1 ? lines[0] : "";
  const idleLine = s.status === "idle" ? (team.sandbox ? "Runs code in a sandbox" : team.asks_before?.length ? `Asks you before ${team.asks_before.join(", ")}` : a.role) : "";
  return `<button class="strip ${s.status} ${view.selected === a.stage ? "selected" : ""}" data-stage="${a.stage}" aria-label="${esc(a.name)}: ${STATUS_WORD[s.status]}">
    <span class="band"></span>
    <span class="who"><b>${esc(a.name)}</b><small>${esc(a.role)}</small></span>
    <span class="doing">${first ? `<span class="line first">${esc(first)}</span>` : `<span class="line">${esc(idleLine)}</span>`}${second ? `<span class="line">${esc(second)}</span>` : ""}</span>
    <span class="meta"><span class="st">${STATUS_WORD[s.status]}</span>${s.runs.length ? `<span>${calls} tool call${calls === 1 ? "" : "s"}, ${dur(took)}</span>` : `<span>${team.model || ""} model</span>`}${s.cost ? `<span>${inr(s.cost)}</span>` : ""}</span>
  </button>`;
}

function drawStrips() {
  const last = S.decisions.at(-1);
  const supStatus = S.inc && S.inc.status === "open" ? "running" : S.decisions.length ? "done" : "idle";
  let html = `<button class="strip boss ${supStatus} ${view.selected === "supervisor" ? "selected" : ""}" data-stage="supervisor">
    <span class="band"></span>
    <span class="who"><b>Supervisor</b><small>Chooses the next move</small></span>
    <span class="doing"><span class="line first">${esc(last ? last.text : "Waits for triage, then decides who works next.")}</span>${last && last.because ? `<span class="line">Asked because ${esc(last.because)}</span>` : ""}</span>
    <span class="meta"><span class="st">${S.decisions.length} decision${S.decisions.length === 1 ? "" : "s"}</span><span>${S.sup.ai} needed judgement</span></span>
  </button>`;
  for (const [bay, title, hint] of BAYS) {
    html += `<div class="bay"><h3>${title} <span>${hint}</span></h3>${AGENTS.filter((a) => a.bay === bay).map(stripHTML).join("")}</div>`;
  }
  $("strips").innerHTML = html;
}

// ----- detail pane -----
function pendingApproval() { return Object.values(S.approvals).find((a) => a.status === "pending"); }

function decideHTML(a) {
  const c = a.context || {}, live = c.live, opt = c.plan_option;
  const liveTxt = live ? `<span class="live-now ${live.error_pct > (live.limit_pct ?? 5) ? "bad" : "ok"}">${live.error_pct}% errors</span> on ${esc(c.service)} (${live.failed_requests ?? "?"} failed requests in 2 min, limit ${live.limit_pct}%)` : "No live numbers for this service";
  return `<section class="decide" aria-label="Approval needed">
    <h2>${esc(NAME[a.stage] || a.stage)} wants to make a change</h2>
    <div class="change">${esc(a.tool)}(${esc(argText(a.args))})</div>
    <dl class="kv">
      <dt>Right now</dt><dd>${liveTxt}</dd>
      ${c.diagnosis ? `<dt>Why</dt><dd>${esc(c.diagnosis)}</dd>` : ""}
      ${opt ? `<dt>Planner says</dt><dd>Risk ${esc(opt.risk)}, ${opt.reversible ? "reversible" : "not reversible"}${opt.blast_radius ? `; affects ${esc(opt.blast_radius)}` : ""}.
        ${opt.speculative ? `<span class="guess">This option is a guess: no direct evidence.</span>` : opt.evidence ? `Evidence: ${esc(short(opt.evidence, 260))}` : ""}</dd>` : ""}
      ${c.undo || a.undo ? `<dt>To undo</dt><dd>${esc(c.undo || a.undo)}</dd>` : ""}
    </dl>
    <div class="row">
      <button class="btn primary" data-approve="${a.id}">Approve ${esc(a.tool)}</button>
      <input id="deny-reason" placeholder="Reason, if you deny it" aria-label="Reason for denying">
      <button class="btn danger" data-deny="${a.id}">Deny</button>
    </div>
    ${S.jira ? `<p class="alt">Or reply <b>/approve</b> or <b>/deny reason</b> on <a href="${esc(S.jira.url)}" target="_blank" rel="noopener">${esc(S.jira.key)}</a>.</p>` : ""}
  </section>`;
}

const LABELS = { root_cause: "Root cause", suspect_commit: "Suspect commit", suspect_files: "Suspect files", failing_step: "Failing step",
  reproduced: "Reproduced", test_file: "Test file", disproved_reason: "Why not reproduced", chosen: "Chosen", fix_needed: "Code fix needed",
  action_taken: "Change made", result: "Result", denied: "Denied", recovered: "Recovered", passed: "Tests passed", failing_tests: "Failing tests",
  pr_url: "Pull request", branch: "Branch", verdict: "Verdict", comments: "Comments", ci_passed: "CI passed", merged: "Merged",
  canary_ok: "Canary healthy", promoted: "Promoted", real_incident: "Real incident", severity: "Severity", service: "Service",
  category: "Category", external: "Outside our system", confidence: "Confidence", unverified_evidence: "Unverified evidence" };
const LONG = ["run_output", "output", "test_output", "patch", "postmortem_md", "test_code"];

function value(k, v) {
  if (typeof v === "boolean") return `<span class="${v === (k === "denied" || k === "external" ? false : true) ? "yes" : "no"}">${v ? "Yes" : "No"}</span>`;
  if (k === "pr_url") return `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`;
  if (k === "confidence") return `${Math.round(v * 100)}%`;
  if (Array.isArray(v)) return v.map((x) => esc(typeof x === "string" ? x : JSON.stringify(x))).join("<br>");
  if (typeof v === "object" && v) return `<code>${esc(short(JSON.stringify(v), 300))}</code>`;
  return esc(v);
}

function answerHTML(o) {
  let h = `<p class="answer">${esc(o.summary || "")}</p><dl class="kv">`;
  for (const [k, v] of Object.entries(o)) {
    if (["summary", "evidence", "options", "files", "mitigation", "timeline", "numbers", "before", "after", "new_tool", "sources"].includes(k) || LONG.includes(k) || v === "" || v == null) continue;
    h += `<dt>${esc(LABELS[k] || k.replace(/_/g, " "))}</dt><dd>${value(k, v)}</dd>`;
  }
  h += "</dl>";
  if (Array.isArray(o.options) && o.options.length) {
    h += `<div class="section"><h3>Options it considered</h3><table class="options"><tr><th>Action</th><th>Risk</th><th>Undo</th><th>Evidence</th></tr>` +
      o.options.map((x) => `<tr class="${x.action === o.chosen ? "chosen" : ""}"><td>${esc(x.action)}<br><code>${esc(x.tool || "")} ${esc(argText(x.args))}</code></td><td>${esc(x.risk)}</td>
        <td>${x.reversible ? "Reversible" : "Not reversible"}</td><td>${x.speculative ? `<span class="guess">Guess, no evidence</span>` : esc(short(x.evidence || "", 200))}</td></tr>`).join("") + `</table></div>`;
  }
  if (Array.isArray(o.evidence) && o.evidence.length) {
    h += `<div class="section"><h3>Evidence</h3><ul class="evidence">` + o.evidence.map((e) => {
      const txt = typeof e === "object" ? e.text || e.detail || JSON.stringify(e) : e;
      const src = [esc(e.source || ""), e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener">open the trace</a>` : "",
        e.verified === false ? `<em>not found in any tool output</em>` : e.verified ? "checked against the tool output" : ""].filter(Boolean).join(", ");
      return `<li class="${e.verified === false ? "unverified" : ""}">${esc(txt)}<div class="src">${src}</div></li>`;
    }).join("") + `</ul></div>`;
  }
  for (const k of LONG) if (o[k]) h += `<div class="section"><h3>${esc({ run_output: "Test run output", output: "Output", test_output: "Test output", patch: "The change", postmortem_md: "Postmortem", test_code: "Reproduction test" }[k])}</h3><pre class="out">${esc(o[k])}</pre></div>`;
  return h;
}

function resultText(r) {
  const p = parse(r);
  if (p && typeof p === "object" && p.response && "result" in p.response) return `exit code ${p.response.exitCode}\n${p.response.result}`;
  return typeof p === "string" ? p : JSON.stringify(p, null, 1);
}

function stepsHTML(steps) {
  if (!steps.length) return `<p class="note">Nothing yet.</p>`;
  return `<ol class="steps">` + steps.map((x) => {
    let body = "";
    if (x.kind === "call") {
      const cmd = x.tool === "exec" ? x.args?.command : argText(x.args);
      body = `${cmd ? `<code class="args">${esc(short(cmd, 600))}</code>` : ""}${x.result != null ? `<details><summary>What it got back</summary><pre class="out">${esc(resultText(x.result))}</pre></details>` : ""}`;
    } else if (x.kind === "approval") body = `<code class="args">${esc(argText(x.args))}</code>`;
    return `<li class="${x.kind}"><span class="t">${clock(x.t)}</span><span class="what">${esc(x.what)}</span>${body}</li>`;
  }).join("") + `</ol>`;
}

function agentHTML(stage) {
  if (stage === "supervisor") {
    return `<h2>Supervisor</h2><p class="sub">After every step it reads each agent's latest answer and picks the next move: run an agent, ask one a question, send work back, hand over to a person, or finish. Code checks every choice against the guardrails. When there is only one sensible move, the rules decide and the supervisor is not called.</p>
      <div class="facts"><span><b>${S.decisions.length}</b> decisions</span><span><b>${S.sup.ai}</b> needed judgement</span><span><b>${S.decisions.length - S.sup.ai}</b> clear next steps</span></div>
      <div class="section"><h3>Its decisions</h3><ul class="feed">${S.decisions.map((x) => `<li><span class="t">${clock(x.t)}</span><span class="by">${x.by === "rules" ? "Rules" : "Supervisor"}:</span> ${esc(x.text)}
        ${x.because ? `<div class="because">Asked because ${esc(x.because)}.${x.url ? ` <a href="${esc(x.url)}" target="_blank" rel="noopener">Its reasoning in TrueForge</a>` : ""}</div>` : ""}</li>`).join("") || `<li class="note">No decisions yet.</li>`}</ul></div>`;
  }
  const a = AGENTS.find((x) => x.stage === stage), s = S.stages[stage];
  const team = Object.values(view.team).find((t) => t.stage === stage) || {};
  const tools = Object.entries(team.tools || {}).map(([srv, ts]) => `${srv}: ${ts.join(", ")}`).join("; ");
  const took = s.runs.reduce((n, r) => n + ((r.end ? new Date(r.end) : new Date()) - new Date(r.start)), 0);
  return `<h2>${esc(a.name)}</h2><p class="sub">${esc(team.job || a.role)}</p>
    <div class="facts"><span><b>${STATUS_WORD[s.status]}</b></span>${team.model ? `<span>${esc(team.model)} model</span>` : ""}
      ${s.runs.length ? `<span>${s.runs.length} run${s.runs.length > 1 ? "s" : ""}, ${dur(took)}</span>` : ""}${s.cost ? `<span>${inr(s.cost)}</span>` : ""}
      ${team.sandbox ? `<span>Runs code in a sandbox</span>` : ""}${team.asks_before?.length ? `<span>Asks you before ${esc(team.asks_before.join(", "))}</span>` : ""}
      ${s.session ? `<a href="${esc(s.session)}" target="_blank" rel="noopener">Full session in TrueForge</a>` : ""}</div>
    ${s.output ? `<div class="section"><h3>Its answer</h3>${answerHTML(s.output)}</div>` : ""}
    <div class="section"><h3>What it did</h3>${stepsHTML(s.steps)}</div>
    ${tools ? `<div class="section"><h3>Tools it may use</h3><p class="note">${esc(tools)}</p></div>` : ""}`;
}

function overviewHTML() {
  if (!S.inc) {
    return `<h2>Nothing needs you</h2><p class="sub">When a service keeps failing, the watcher opens an incident and the agents start work here. Click any agent on the left to see what it does.</p>
      <div class="section"><h3>Recent incidents</h3><div id="recent"><p class="note">Loading…</p></div></div>`;
  }
  const inc = S.inc;
  return `<h2>What is happening</h2><p class="sub">${esc(inc.summary)}</p>
    <div class="facts">${S.jira ? `<a href="${esc(S.jira.url)}" target="_blank" rel="noopener">Jira ${esc(S.jira.key)}</a>` : ""}${inc.pr_url ? `<a href="${esc(inc.pr_url)}" target="_blank" rel="noopener">Pull request</a>` : ""}
      <span>Opened ${clock(inc.opened_at || S.start)}</span></div>
    <div class="section"><h3>Decisions and conversation</h3><ul class="feed">${S.feed.slice().reverse().map((f) => `<li class="${f.kind === "person" ? "person" : ""}"><span class="t">${clock(f.t)}</span>${f.by ? `<span class="by">${esc(f.by)}:</span> ` : ""}${esc(f.text)}
      ${f.because ? `<div class="because">Supervisor asked because ${esc(f.because)}.</div>` : ""}${f.url && f.kind === "info" ? ` <a href="${esc(f.url)}" target="_blank" rel="noopener">open</a>` : ""}</li>`).join("") || `<li class="note">Starting…</li>`}</ul></div>`;
}

function drawDetail() {
  const p = pendingApproval();
  let sel = view.selected;
  if (view.follow) {
    const running = AGENTS.find((a) => ["waiting", "running"].includes(S.stages[a.stage].status));
    sel = running ? running.stage : null;
  }
  const body = sel ? agentHTML(sel) : overviewHTML();
  const openDetails = [...$("detail").querySelectorAll("details[open]")].map((d) => d.dataset.k);
  const reason = $("deny-reason")?.value || "";
  $("detail").innerHTML = (p ? decideHTML(p) : "") + body + (sel ? `<p style="margin-top:22px"><button class="btn small" id="back">Back to the overview</button></p>` : "");
  if ($("deny-reason")) $("deny-reason").value = reason;
  $("detail").querySelectorAll("details").forEach((d, i) => { d.dataset.k = i; if (openDetails.includes(String(i))) d.open = true; });
  if (!S.inc && $("recent")) loadRecent();
}

async function loadRecent() {
  const rows = await (await fetch("/api/incidents?limit=6")).json();
  const el = $("recent"); if (!el) return;
  el.innerHTML = rows.length ? `<table class="table">${rows.map((r) => `<tr class="link" data-open="${r.id}"><td>${esc(r.id)}</td><td>${esc(short(r.summary, 90))}</td><td><span class="state ${esc(r.status)}">${esc(r.status.replace("_", " "))}</span></td></tr>`).join("")}</table>` : `<p class="note">No incidents yet.</p>`;
}

// ----- timeline -----
function drawTrack() {
  if (!S.start) { $("track").innerHTML = `<div class="empty">The timeline of an incident appears here.</div>`; $("axis").innerHTML = ""; return; }
  const t0 = new Date(S.start).getTime(), t1 = S.end ? new Date(S.end).getTime() : Date.now(), span = Math.max(t1 - t0, 30000);
  const x = (t) => ((new Date(t).getTime() - t0) / span) * 100;
  let h = "";
  for (const a of AGENTS) for (const r of S.stages[a.stage].runs) {
    const l = x(r.start), w = Math.max(0.6, x(r.end || t1) - l);
    h += `<button class="seg ${r.status}" style="left:${l}%;width:${w}%" data-stage="${a.stage}" title="${esc(a.name)}: ${dur(new Date(r.end || t1) - new Date(r.start))}">${w > 5 ? esc(a.name) : ""}</button>`;
  }
  for (const ap of Object.values(S.approvals)) h += `<span class="pin" style="left:${x(ap.t)}%" title="Asked you: ${esc(ap.tool)}"></span>`;
  $("track").innerHTML = h;
  let ax = "";
  for (let i = 0; i <= 4; i++) ax += `<span style="left:${i * 25}%">${dur((span * i) / 4)}</span>`;
  $("axis").innerHTML = ax;
}

// ----- the shop -----
function drawSystem(w) {
  if (!w) return;
  view.watch = w;
  const b = $("blind");
  if (w.blind) { b.hidden = false; b.textContent = w.blind.reason; } else b.hidden = true;
  const services = Object.entries(w.services || {}).sort((a, b) => (b[1].over - a[1].over) || (b[1].error_pct - a[1].error_pct));
  $("services").innerHTML = services.map(([n, v]) => {
    const pct = Math.min(100, v.error_pct), lim = Math.min(100, v.limit_pct || 5);
    const why = v.op ? `${v.op.name.split("/").pop()} fails ${v.op.error_pct}% (${v.op.failed_requests} failed), for ${v.over_for_s}s`
      : v.state === "over" ? `Over its ${v.limit_pct}% limit for ${v.over_for_s}s (opens at ${v.fires_after_s}s)`
      : v.state === "quiet" ? (v.rps ? "Too few requests to judge; waiting" : "No traffic") : `${v.rps} requests a second`;
    return `<li class="${v.state}"><span class="svc">${esc(n)}</span><span class="pct">${v.error_pct}%</span>
      <span class="meter"><i style="width:${Math.max(pct, 0.5)}%"></i><b style="left:${lim}%"></b></span><span class="why">${esc(why)}</span></li>`;
  }).join("");
  $("signals").innerHTML = Object.entries(w.signals || {}).map(([n, v]) => `<li class="${v.over ? "over" : ""}">${esc(n)}: ${v.value} ${v.over ? `(limit ${v.above})` : ""}<br><span class="note">${esc(v.explain)}</span></li>`).join("") || `<li class="note">None configured.</li>`;
  const p = w.synthetic;
  if (p) {
    $("probe").innerHTML = `<p class="verdict ${p.passed ? "ok" : "bad"}">${p.passed ? "Passed" : "Failed"}: ${p.flow === "checkout" ? "bought something" : "filled a cart"}</p>
      <ol>${p.steps.map((s) => `<li class="${s.ok ? "" : "bad"}">${esc(s.step)}${s.ok ? "" : `: ${esc(short(s.detail, 90))}`}</li>`).join("")}</ol>`;
  }
}

// ---------------- sheet: incidents, team, connections, system ----------------
async function sheet(tab = "incidents") {
  document.querySelectorAll("#sheet-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  const body = $("sheet-body");
  body.innerHTML = `<p class="note">Loading…</p>`;
  if (tab === "incidents") {
    const rows = await (await fetch("/api/incidents?limit=40")).json();
    body.innerHTML = `<table class="table"><tr><th>Incident</th><th>What happened</th><th>Outcome</th><th>Cost</th><th></th></tr>${rows.map((r) => `<tr class="link" data-open="${r.id}">
      <td><b>${esc(r.id)}</b><br><span class="note">${new Date(r.opened_at).toLocaleString()}</span></td><td>${esc(short(r.summary, 140))}</td>
      <td><span class="state ${esc(r.status)}">${esc(r.status.replace("_", " "))}</span></td><td>${inr(Number(r.total_cost_usd))}</td>
      <td><button class="btn small" data-replay="${r.id}">Replay</button></td></tr>`).join("")}</table>`;
  } else if (tab === "team") {
    const team = Object.values(view.team);
    body.innerHTML = `<table class="table"><tr><th>Agent</th><th>Job</th><th>Model</th><th>Asks you before</th><th>Runs code</th></tr>${team.map((t) => `<tr>
      <td><b>${esc(NAME[t.stage] || t.name)}</b><br><span class="note">${esc(t.name)}</span></td><td>${esc(t.job)}</td><td>${esc(t.model)}</td>
      <td>${esc((t.asks_before || []).join(", ") || "Nothing, read-only")}</td><td>${t.sandbox ? "In a sandbox" : "No"}</td></tr>`).join("")}</table>`;
  } else if (tab === "connections") {
    const c = await (await fetch("/api/connections")).json();
    const name = { trueforge: "TrueForge (agents)", prometheus: "Prometheus (metrics)", ops_mcp: "Ops server (the agents' door to the shop)", jira: "Jira (tickets and approvals)", slack: "Slack (notifications)" };
    body.innerHTML = `<table class="table">${Object.entries(c).map(([k, v]) => `<tr><td><span class="${v.ok ? "ok-dot" : "bad-dot"}"></span><b>${esc(name[k] || k)}</b></td>
      <td>${esc(typeof v.detail === "object" ? JSON.stringify(v.detail) : v.detail ?? "")}${v.mcp_servers ? `<br><span class="note">MCP servers: ${esc(Object.entries(v.mcp_servers).map(([n, s]) => `${n} (${s || "ok"})`).join(", "))}</span>` : ""}</td></tr>`).join("")}</table>`;
  } else {
    const s = await (await fetch("/api/system")).json();
    body.innerHTML = `<p class="note">systems/${esc(s.name)}.yaml: everything NightShift knows about the system it watches. Another system needs only another file like this.</p><pre class="out" style="max-height:none">${esc(JSON.stringify(s, null, 2))}</pre>`;
  }
}

// ---------------- events from the page ----------------
document.addEventListener("click", async (e) => {
  const strip = e.target.closest("[data-stage]");
  if (strip && !e.target.closest("a")) {
    view.selected = strip.dataset.stage; view.follow = false; syncFollow(); render(); return;
  }
  if (e.target.id === "back") { view.selected = null; view.follow = false; syncFollow(); render(); return; }
  const ap = e.target.dataset.approve || e.target.dataset.deny;
  if (ap) {
    const deny = !!e.target.dataset.deny;
    e.target.disabled = true;
    const r = await fetch(`/api/approvals/${ap}`, { method: "POST", headers: { "content-type": "application/json", ...auth() },
      body: JSON.stringify({ decision: deny ? "deny" : "approve", reason: deny ? ($("deny-reason")?.value || "denied from the dashboard") : "" }) });
    if (r.status === 401) { signIn(); e.target.disabled = false; return; }
    if (!r.ok) { alert((await r.json()).detail || "Could not record the decision"); e.target.disabled = false; }
    return;
  }
  const replay = e.target.dataset.replay;
  if (replay) { $("sheet").close(); view.follow = true; syncFollow(); location.hash = replay; await load(replay, { replay: true }); return; }
  const open = e.target.closest("[data-open]");
  if (open) { $("sheet").close(); location.hash = open.dataset.open; return; }
  const tab = e.target.dataset.tab;
  if (tab) sheet(tab);
});
$("menu-btn").onclick = () => { $("sheet").showModal(); sheet("incidents"); };
$("follow").onclick = () => { view.follow = !view.follow; if (view.follow) view.selected = null; syncFollow(); render(); };
function syncFollow() { $("follow").setAttribute("aria-pressed", view.follow); $("follow").textContent = view.follow ? "Following the live agent" : "Follow the live agent"; }

function auth() { const t = localStorage.getItem("ns_token"); return t ? { authorization: `Bearer ${t}` } : {}; }
function signIn() {
  const t = prompt("Approvals need your NightShift sign-in token (from DASHBOARD_USERS in .env):");
  if (t) { localStorage.setItem("ns_token", t.trim()); document.cookie = `ns_token=${encodeURIComponent(t.trim())}; path=/; SameSite=Strict`; }
}

// ---------------- live stream ----------------
function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("hello", (m) => { if (view.mode !== "replay") setMode(location.hash ? "view" : "live"); drawSystem(JSON.parse(m.data).watch); });
  es.onmessage = async (m) => {
    const ev = JSON.parse(m.data);
    if (ev.kind === "watcher.tick") { drawSystem(ev.data); return; }
    if (view.mode === "replay") return;
    if (ev.kind === "incident.opened" && view.mode === "live") { await load(ev.incident_id); return; }
    if (ev.incident_id && ev.incident_id === S.id) { apply(ev); render(); }
  };
  es.onerror = () => { $("conn").className = "conn"; $("conn").textContent = "Reconnecting"; };
}

async function route() {
  const [id, agent] = location.hash.replace("#", "").split("/");
  if (agent) { view.selected = agent; view.follow = false; syncFollow(); }
  if (id) { setMode("view"); await load(id); return; }
  setMode("live");
  const rows = await (await fetch("/api/incidents?limit=5")).json();
  const active = rows.find((r) => r.status === "open" || r.status === "mitigated");
  await load(active ? active.id : null);
}
window.addEventListener("hashchange", route);

(async function start() {
  const team = await (await fetch("/api/agents")).json();
  for (const t of team) view.team[t.name] = t;
  fetch("/api/system").then((r) => r.json()).then((s) => { $("sys").textContent = s.name; });
  fetch("/api/watch").then((r) => r.json()).then(drawSystem);
  await route();
  connect();
  setInterval(() => { if (S.inc && !S.end) { drawHeader(); drawTrack(); } }, 1000);
})();
