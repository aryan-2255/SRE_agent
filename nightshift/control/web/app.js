// NightShift operations room: a live network of agents driven by /api/stream (server-sent events).
"use strict";

const SVGNS = "http://www.w3.org/2000/svg";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour12: false });
const USD_INR = 88;

// ---------------- the map ----------------
const HUB = { x: 600, y: 400 };
const RING = 262;
const AGENTS = [
  ["triage", "Triage", "MiniMax"], ["diagnosis", "Diagnosis", "Kimi"], ["validation", "Validation", "Kimi"],
  ["plan", "Planner", "Kimi"], ["mitigation", "Mitigation", "MiniMax"], ["verify", "Verify", "MiniMax"],
  ["fix", "Coder", "Kimi"], ["test", "Tester", "MiniMax"], ["pr", "Pull request", "MiniMax"],
  ["review", "Reviewer", "Kimi"], ["cicd", "CI/CD · canary", "MiniMax"], ["postmortem", "Postmortem", "MiniMax"],
  ["docs", "Docs research", "Kimi"],
];
const POS = {};
AGENTS.forEach(([id], i) => {
  const a = (Math.PI / 180) * (180 + (i * 360) / AGENTS.length);
  POS[id] = { x: HUB.x + RING * Math.cos(a), y: HUB.y + RING * Math.sin(a) };
});
POS.supervisor = HUB;
const SYSTEMS = {
  watcher: { x: 30, y: 118, w: 186, label: "Watcher", sub: "always on · no AI · ₹0", cls: "watcher" },
  shop: { x: 30, y: 372, w: 186, label: "Live system", sub: "logs · metrics · traces · docker" },
  human: { x: 507, y: 22, w: 186, label: "On-call · Jira", sub: "approves every change", cls: "human" },
  github: { x: 994, y: 238, w: 186, label: "GitHub", sub: "commits · branches · PRs" },
  sandbox: { x: 994, y: 506, w: 186, label: "Daytona sandbox", sub: "runs the agents' code" },
  harness: { x: 994, y: 724, w: 186, label: "TrueForge harness", sub: "sub-agents · tool search" },
};
for (const s of Object.values(SYSTEMS)) { s.h = 58; s.cx = s.x + s.w / 2; s.cy = s.y + s.h / 2; }

const OPS_TOOLS = new Set(["list_services", "get_error_rates", "get_metrics", "query_logs", "get_traces", "get_trace",
  "get_recent_deploys", "get_flags", "run_sql_readonly", "synthetic_check", "rollback", "deploy", "deploy_canary",
  "promote_canary", "abort_canary", "restart_service", "scale_service", "set_flag"]);
function systemFor(tool) {
  const t = String(tool || "");
  if (OPS_TOOLS.has(t)) return "shop";
  if (t === "notify" || /jira|confluence|atlassian/i.test(t)) return "human";
  if (/pull_request|commit|branch|file_contents|push_files|repository|search_code|merge|issue|release|tag/.test(t)) return "github";
  if (/sandbox|exec|shell|bash|command|write_file|read_file|run_code|python|terminal/i.test(t)) return "sandbox";
  return "harness";
}

// ---------------- state ----------------
let S = freshState();
function freshState() {
  return { id: null, inc: null, events: [], runs: {}, status: {}, tools: {}, toolTotal: 0, t0: null, tEnd: null, lastTs: null, sats: {}, pending: [] };
}
let mode = "idle";          // idle | live | replay
let replayTimer = null;
const history = {};         // service -> recent error %

// ---------------- svg helpers ----------------
const net = $("#net");
function el(tag, attrs = {}, parent = net) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent.appendChild(e);
  return e;
}
function edgePoint(from, to, r) {
  const dx = to.x - from.x, dy = to.y - from.y, d = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / d) * r, y: from.y + (dy / d) * r };
}
function curve(a, b, bend = 0.18) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const nx = -(b.y - a.y) * bend, ny = (b.x - a.x) * bend;
  return `M${a.x},${a.y} Q${mx + nx},${my + ny} ${b.x},${b.y}`;
}
function nodePoint(id) {
  if (SYSTEMS[id]) return { x: SYSTEMS[id].cx, y: SYSTEMS[id].cy };
  return POS[id] || HUB;
}

let layerEdges, layerFx, layerNodes;
function drawMap() {
  net.innerHTML = "";
  layerEdges = el("g"); layerFx = el("g"); layerNodes = el("g");
  el("circle", { cx: HUB.x, cy: HUB.y, r: RING, class: "ring-guide" }, layerEdges);
  for (const [id] of AGENTS) {
    const a = edgePoint(HUB, POS[id], 56), b = edgePoint(POS[id], HUB, 40);
    el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "spoke", id: `spoke-${id}` }, layerEdges);
  }
  for (const [key, s] of Object.entries(SYSTEMS)) {
    const g = el("g", { class: `sys-node ${s.cls || ""}`, id: `sys-${key}` }, layerNodes);
    el("rect", { x: s.x, y: s.y, width: s.w, height: s.h, rx: 10 }, g);
    el("text", { x: s.x + 14, y: s.y + 25, class: "label" }, g).textContent = s.label;
    el("text", { x: s.x + 14, y: s.y + 44, class: "sub" }, g).textContent = s.sub;
  }
  const hub = el("g", { class: "node hub", id: "node-supervisor" }, layerNodes);
  el("circle", { cx: HUB.x, cy: HUB.y, r: 54, class: "halo" }, hub);
  el("circle", { cx: HUB.x, cy: HUB.y, r: 54, class: "body" }, hub);
  el("text", { x: HUB.x, y: HUB.y - 1, class: "label" }, hub).textContent = "Supervisor";
  el("text", { x: HUB.x, y: HUB.y + 18, class: "sub" }, hub).textContent = "Kimi K3";
  for (const [id, label, model] of AGENTS) {
    const p = POS[id];
    const g = el("g", { class: "node", id: `node-${id}` }, layerNodes);
    el("circle", { cx: p.x, cy: p.y, r: 37, class: "body" }, g);
    el("circle", { cx: p.x, cy: p.y, r: 43, class: "spin" }, g);
    el("text", { x: p.x, y: p.y + 5, class: "glyph", id: `glyph-${id}` }, g).textContent = "idle";
    el("text", { x: p.x, y: p.y + 58, class: "label" }, g).textContent = label;
    el("text", { x: p.x, y: p.y + 74, class: "sub" }, g).textContent = model;
    const badge = el("g", { id: `badge-${id}`, visibility: "hidden" }, g);
    el("circle", { cx: p.x + 29, cy: p.y - 29, r: 11, class: "count-bg" }, badge);
    el("text", { x: p.x + 29, y: p.y - 25, class: "count", id: `count-${id}` }, badge).textContent = "1";
  }
}

const GLYPH = { running: "working", waiting: "needs you", done: "done", failed: "failed", skipped: "skipped" };
function setNode(id, state) {
  S.status[id] = state;
  const g = document.getElementById(`node-${id}`);
  if (!g) return;
  g.classList.remove("running", "waiting", "done", "failed", "skipped");
  if (state) g.classList.add(state);
  const gl = document.getElementById(`glyph-${id}`);
  if (gl) gl.textContent = GLYPH[state] || "idle";
  const sp = document.getElementById(`spoke-${id}`);
  if (sp) sp.classList.toggle("hot", state === "running" || state === "waiting");
}
function setRuns(id) {
  const n = S.runs[id] || 0, b = document.getElementById(`badge-${id}`);
  if (!b) return;
  b.setAttribute("visibility", n > 1 ? "visible" : "hidden");
  document.getElementById(`count-${id}`).textContent = n;
}
function hubThinking(on) { document.getElementById("node-supervisor")?.classList.toggle("thinking", on); }
function sysHot(key, ms = 900) {
  const g = document.getElementById(`sys-${key}`);
  if (!g) return;
  g.classList.add("hot");
  clearTimeout(g._t);
  g._t = setTimeout(() => g.classList.remove("hot"), ms);
}

// ---------------- motion ----------------
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function pulse(from, to, cls = "", dur = 650, bend = 0) {
  if (!layerFx || reduceMotion) return;
  const a = nodePoint(from), b = nodePoint(to);
  const path = el("path", { d: curve(a, b, bend), fill: "none", stroke: "none" }, layerFx);
  const dot = el("circle", { r: 5, class: `pulse ${cls}` }, layerFx);
  const len = path.getTotalLength();
  const start = performance.now();
  (function step(now) {
    const t = Math.min(1, (now - start) / dur), p = path.getPointAtLength(len * (1 - Math.pow(1 - t, 2)));
    dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y);
    if (t < 1) requestAnimationFrame(step); else { dot.remove(); path.remove(); }
  })(start);
}
function flash(from, to, cls = "flash", ms = 1100) {
  if (!layerFx) return;
  const a = nodePoint(from), b = nodePoint(to);
  const p = el("path", { d: curve(a, b, 0.12), class: cls }, layerFx);
  p.style.transition = `opacity ${ms}ms ease-in`;
  requestAnimationFrame(() => requestAnimationFrame(() => { p.style.opacity = "0"; }));
  setTimeout(() => p.remove(), ms + 80);
}
function talkLine(from, to, text) {
  if (!layerFx || !POS[from] || !POS[to]) return;
  const a = POS[from], b = POS[to], bend = 0.35;
  const g = el("g", {}, layerFx);
  el("path", { d: curve(a, b, bend), class: "talkline" }, g);
  const qx = (a.x + b.x) / 2 - (b.y - a.y) * bend, qy = (a.y + b.y) / 2 + (b.x - a.x) * bend;
  const mx = (a.x + 2 * qx + b.x) / 4, my = (a.y + 2 * qy + b.y) / 4;   // midpoint of the curve
  const label = el("g", { class: "talklabel" }, g);
  const short = text.length > 34 ? text.slice(0, 33) + "…" : text;
  const w = Math.max(60, short.length * 8 + 16);
  el("rect", { x: mx - w / 2, y: my - 11, width: w, height: 22, rx: 6 }, label);
  el("text", { x: mx, y: my + 4, "text-anchor": "middle" }, label).textContent = short;
  g.style.transition = "opacity 1.2s";
  setTimeout(() => { g.style.opacity = ".25"; }, 6000);
  pulse(from, to, "talk", 900, bend);
}
function satellite(stage, title) {
  const p = POS[stage];
  if (!p || !layerFx) return;
  const list = (S.sats[stage] ||= []);
  const i = list.length;
  list.push(title);
  const a = -Math.PI / 2 + i * 0.75, r = 56;
  const g = el("g", { class: "sat" }, layerFx);
  el("circle", { cx: p.x + r * Math.cos(a), cy: p.y + r * Math.sin(a), r: 5 }, g);
  el("text", { x: p.x + (r + 10) * Math.cos(a), y: p.y + (r + 10) * Math.sin(a) + 3,
    "text-anchor": Math.cos(a) < 0 ? "end" : "start" }, g).textContent = title;
}

// ---------------- panels ----------------
function setNow(html) { $("#now").innerHTML = html; }
function say(cls, who, msg, ts, extra = "") {
  const ol = $("#talk");
  ol.querySelector(".empty")?.remove();
  const li = document.createElement("li");
  li.className = cls;
  li.innerHTML = `<div class="meta"><span class="who">${esc(who)}</span><span>${clock(ts)}</span></div><div class="msg">${esc(msg)}${extra}</div>`;
  ol.prepend(li);
  while (ol.children.length > 80) ol.lastChild.remove();
}
function setCost(usd) { $("#cost").textContent = "₹" + (usd * USD_INR).toFixed(2); }
function renderTitle() {
  const i = S.inc;
  if (!i) { $("#inc-title").innerHTML = `<span class="muted">No active incident</span>`; return; }
  $("#inc-title").innerHTML = `<span class="id">${esc(i.id)}</span>
    <span class="pill ${esc(i.status)}">${esc((i.status || "").replace("_", " "))}</span>
    ${i.severity ? `<span class="pill sev">${esc(i.severity)}</span>` : ""}
    <span class="t">${esc(i.summary || i.service)}</span>
    ${i.jira_url ? `<a class="small" href="${esc(i.jira_url)}" target="_blank" rel="noopener">${esc(i.jira_key)}</a>` : ""}
    ${i.pr_url ? `<a class="small" href="${esc(i.pr_url)}" target="_blank" rel="noopener">pull request</a>` : ""}`;
}
function tickElapsed() {
  if (!S.t0) { $("#elapsed").textContent = "—"; return; }
  const end = S.tEnd || (mode === "live" ? Date.now() : S.lastTs || S.t0);
  const s = Math.max(0, Math.round((end - S.t0) / 1000));
  $("#elapsed").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
setInterval(tickElapsed, 1000);

function renderTraffic() {
  const entries = Object.entries(S.tools).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  $("#tool-total").textContent = `${S.toolTotal} calls`;
  $("#traffic").innerHTML = entries.map(([t, n]) => `<li><span>${esc(t)}</span><span>${n}</span>
    <span class="bar2"><i style="width:${(n / max) * 100}%"></i></span></li>`).join("") || `<li class="empty">No tool calls yet.</li>`;
}

function renderWatch(w) {
  if (!w || !w.services) return;
  const rows = Object.entries(w.services);
  $("#svc").innerHTML = rows.map(([name, s]) => {
    const h = (history[name] ||= []);
    h.push(s.error_pct); if (h.length > 60) h.shift();
    const top = Math.max(s.limit_pct * 2, ...h, 1);
    const pts = h.map((v, i) => `${(i / 59) * 100},${22 - (v / top) * 20}`).join(" ");
    const lim = 22 - (s.limit_pct / top) * 20;
    const state = s.over ? `over limit for ${s.over_for_s}s · fires at ${s.fires_after_s}s` : `${s.rps.toFixed(2)} req/s · limit ${s.limit_pct}%`;
    return `<li class="${s.over ? "over" : ""}"><span class="n">${esc(name)}</span><span class="e">${s.error_pct.toFixed(1)}%</span>
      <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2="100" y1="${lim}" y2="${lim}" stroke="#FF6B5E" stroke-opacity=".35" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/>
        <polyline points="${pts}" fill="none" stroke="${s.over ? "#FF6B5E" : "#3FD69B"}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>
      <span class="s">${esc(state)}</span></li>`;
  }).join("");
  const syn = w.synthetic;
  if (syn) {
    $("#synth").innerHTML = (syn.steps || []).map((s) => `<span class="${s.ok ? "ok" : "bad"}">${s.ok ? "✓" : "✗"} ${esc(s.step)}</span>`).join("")
      || `<span class="${syn.passed ? "ok" : "bad"}">${syn.passed ? "passing" : "failing"}</span>`;
  }
  const anyOver = rows.some(([, s]) => s.over);
  $("#watch-state").textContent = anyOver ? "breach" : "rules · no AI";
  $("#watch-state").className = "tag " + (anyOver ? "" : "ok");
  document.getElementById("sys-watcher")?.classList.toggle("hot", anyOver);
}

const UNDO = {
  rollback: "Undo: deploy again, or roll back to another commit.", deploy: "Undo: rollback returns to the previous image in seconds.",
  deploy_canary: "Undo: abort_canary sends all traffic back.", promote_canary: "Undo: rollback.", set_flag: "Undo: set the flag back.",
  restart_service: "A restart changes no code or data.", scale_service: "Undo: scale back to 1.",
  create_pull_request: "Undo: close the pull request.", merge_pull_request: "Undo: revert the merge, then roll back.",
};
function renderApproval() {
  const a = S.pending[0];
  const box = $("#approval");
  if (!a) { box.innerHTML = ""; return; }
  const args = typeof a.args === "string" ? a.args : JSON.stringify(a.args, null, 2);
  const live = mode === "live";
  box.innerHTML = `<div class="approval">
    <div class="h">Paused by TrueForge · ${esc(a.stage)} wants to change production</div>
    <div class="q">Allow <code>${esc(a.tool)}</code>?</div>
    <pre>${esc(args)}</pre>
    <div class="undo">${esc(UNDO[a.tool] || "")}${S.inc?.jira_url ? ` Or reply <code>/approve</code> on <a href="${esc(S.inc.jira_url)}" target="_blank" rel="noopener">${esc(S.inc.jira_key)}</a>.` : ""}</div>
    <div class="row"><button class="btn yes" id="ap-yes" ${live ? "" : "disabled"}>Approve</button>
      <button class="btn no" id="ap-no" ${live ? "" : "disabled"}>Deny</button>
      <input id="ap-reason" placeholder="reason (for deny)" ${live ? "" : "disabled"}></div></div>`;
  if (live) {
    $("#ap-yes").onclick = () => decide(a.id, "approve");
    $("#ap-no").onclick = () => decide(a.id, "deny", $("#ap-reason").value || "Denied from the dashboard");
  }
}
async function decide(id, decision, reason = "") {
  document.querySelectorAll(".approval .btn").forEach((b) => (b.disabled = true));
  await fetch(`/api/approvals/${id}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, reason, by: "dashboard" }) });
}

// ---------------- evidence ----------------
function traceLink(id, link) {
  return id ? ` <a href="${esc(link || "http://localhost:8080/jaeger/ui/trace/" + id)}" target="_blank" rel="noopener">trace ↗</a>` : "";
}
function renderItems(d) {
  const it = d.items;
  if (!it || typeof it === "string") return `<pre>${esc(String(it ?? "").slice(0, 1400))}</pre>`;
  if (it.error) return `<div class="line err">${esc(it.error)}</div>`;
  switch (d.tool) {
    case "query_logs":
      return `<div class="ev-h"><span>${esc(it.service)} · ${it.count} lines</span><span>${esc(JSON.stringify(it.by_level || {}))}</span></div>` +
        (it.lines || []).slice(0, 7).map((l) => `<div class="line ${/error|fatal/i.test(l.level || "") ? "err" : ""}">${esc((l.time || "").slice(11, 19))} ${esc(l.level || "")} · ${esc(l.message)}${traceLink(l.trace_id)}</div>`).join("");
    case "get_traces":
      return (Array.isArray(it) ? it : []).slice(0, 4).map((t) => `<div class="line ${t.failing_step ? "err" : ""}">${esc(t.root)} · ${t.duration_ms} ms · ${t.steps} steps${t.real_user ? " · real user" : ""}${t.failing_step ? `<br>✗ ${esc(t.failing_step.service)} ${esc(t.failing_step.operation)}: ${esc(t.failing_step.message || "")}` : ""}${traceLink(t.trace_id, t.link)}</div>`).join("") || `<div class="line">no matching traces</div>`;
    case "get_trace": {
      const bad = (it.steps || []).filter((s) => s.error);
      return (bad.length ? bad : it.steps || []).slice(0, 6).map((s) => `<div class="line ${s.error ? "err" : ""}">${s.at_ms} ms · ${esc(s.service)} ${esc(s.operation)}${s.message ? ": " + esc(s.message) : ""}</div>`).join("") + traceLink(it.trace_id, it.link);
    }
    case "get_error_rates":
      return `<table>${Object.entries(it).filter(([, v]) => v && typeof v === "object").map(([k, v]) =>
        `<tr><td>${esc(k)}</td><td class="${v.over_threshold ? "bad" : ""}">${v.error_pct}%</td><td>${v.rps}/s</td><td>p95 ${v.p95_ms ?? "–"}</td></tr>`).join("")}</table>`;
    case "get_recent_deploys":
      return [...(it.deploys || []).slice(-3).map((x) => `<div class="line">${esc(x.action)} · ${esc(x.service)} → ${esc(x.commit)}</div>`),
        ...(it.recent_commits || []).slice(0, 4).map((c) => `<div class="line">${esc(c.commit)} · ${esc(c.author)} · ${esc(c.message)}</div>`)].join("") || `<div class="line">no recent deploys</div>`;
    case "synthetic_check":
      return (it.steps || []).map((s) => `<div class="line ${s.ok ? "" : "err"}">${s.ok ? "✓" : "✗"} ${esc(s.step)} ${s.status ? "· " + s.status : ""} ${esc(s.detail || "")}</div>`).join("");
    default:
      return `<pre>${esc(JSON.stringify(it, null, 1).slice(0, 1400))}</pre>`;
  }
}
function addEvidence(e) {
  const d = e.data || {};
  const box = $("#evidence");
  box.querySelector(".empty")?.remove();
  const div = document.createElement("div");
  div.className = "ev";
  div.innerHTML = `<div class="ev-h"><span><span class="src ${esc(d.source)}">${esc(d.source)}</span> ${esc(d.tool)}</span><span>${esc(e.stage || "")} · ${clock(e.ts)}</span></div>${renderItems(d)}`;
  box.prepend(div);
  while (box.children.length > 30) box.lastChild.remove();
}

// ---------------- timeline ----------------
const TL_CLASS = { "stage.started": "stage", "stage.done": "stage", "supervisor.decision": "sup", "tool.call": "tool",
  "approval.requested": "hum", "approval.decided": "hum", "agent.question": "hum", "agent.sendback": "hum",
  "stage.failed": "bad", "incident.escalated": "bad", "supervisor.overruled": "bad", "incident.opened": "bad",
  "incident.resolved": "stage", "incident.mitigated": "stage" };
function renderTimeline() {
  const tl = $("#tl");
  if (!S.t0) { tl.innerHTML = ""; $("#tl-range").textContent = ""; return; }
  const end = Math.max(S.lastTs || S.t0, mode === "live" && !S.tEnd ? Date.now() : 0, S.t0 + 1000);
  const span = end - S.t0;
  const x = (ts) => Math.max(0, Math.min(100, ((ts - S.t0) / span) * 100));
  let html = "";
  let waitStart = null;
  for (const e of S.events) {
    const t = Date.parse(e.ts);
    if (e.kind === "approval.requested") waitStart = t;
    if (e.kind === "approval.decided" && waitStart) { html += `<div class="band" style="left:${x(waitStart)}%;width:${x(t) - x(waitStart)}%"></div>`; waitStart = null; }
    const c = TL_CLASS[e.kind];
    if (c) html += `<div class="tick ${c}" style="left:${x(t)}%" title="${esc(e.kind)} ${esc(e.text || "")}"></div>`;
    if (e.kind === "stage.started") html += `<div class="lbl" style="left:${Math.max(2.5, Math.min(97.5, x(t)))}%">${esc(e.stage)}</div>`;
  }
  tl.innerHTML = html;
  $("#tl-range").textContent = `${clock(S.t0)} → ${clock(end)}`;
}

// ---------------- apply one event ----------------
const SAY_AGENT = { triage: "triage", diagnosis: "diagnosis", validation: "validation", plan: "planner", mitigation: "mitigation",
  verify: "verify", fix: "coder", test: "tester", pr: "pull request", review: "reviewer", cicd: "ci/cd", postmortem: "postmortem", docs: "docs" };
const who = (st) => SAY_AGENT[st] || st || "system";

function apply(e, animate) {
  const ts = e.ts || new Date().toISOString();
  if (e.kind === "watcher.tick") { if (mode !== "replay") renderWatch(e.data); return; }
  S.events.push(e);
  S.lastTs = Date.parse(ts);
  const st = e.stage, d = e.data || {};
  switch (e.kind) {
    case "incident.opened":
      S.t0 = Date.parse(ts);
      if (animate) { sysHot("watcher", 2000); pulse("watcher", "triage", "", 900); }
      say("bad", "watcher", e.text, ts);
      setNow(`<span class="who">alert</span> ${esc(e.text)}`);
      break;
    case "stage.started":
      S.runs[st] = (S.runs[st] || 0) + 1; setRuns(st);
      setNode(st, "running");
      if (animate) pulse(st === "triage" ? "watcher" : "supervisor", st, "", 700);
      setNow(`<span class="who">${esc(who(st))}</span> started${S.runs[st] > 1 ? ` (run ${S.runs[st]})` : ""}`);
      break;
    case "stage.session":
      if (st === "supervisor") hubThinking(true);
      break;
    case "supervisor.decision": {
      hubThinking(false);
      const dec = d.decision || {};
      if (animate && dec.stage && POS[dec.stage]) pulse("supervisor", dec.stage, "", 650);
      say("sup", "supervisor", e.text, ts);
      setNow(`<span class="who">supervisor</span> ${esc(e.text)}`);
      break;
    }
    case "supervisor.overruled":
      hubThinking(false);
      say("bad", "guardrail", e.text, ts);
      break;
    case "tool.call": {
      const sys = systemFor(d.tool);
      S.tools[d.tool] = (S.tools[d.tool] || 0) + 1; S.toolTotal++;
      renderTraffic();
      if (animate && POS[st]) { flash(st, sys); pulse(st, sys, "tool", 600, 0.12); sysHot(sys); }
      setNow(`<span class="who">${esc(who(st))}</span> called <b>${esc(d.tool)}</b> <span class="muted">on ${esc(SYSTEMS[sys].label)}</span>`);
      break;
    }
    case "subagent":
      satellite(st, d.title || "sub-agent");
      say("agent", who(st), `started a parallel sub-agent: ${d.title || ""}`, ts);
      if (animate) pulse(st, "harness", "tool", 700, 0.1);
      break;
    case "sandbox":
      if (animate && POS[st]) { flash(st, "sandbox"); sysHot("sandbox", 1500); }
      say("sys", "sandbox", `${who(st)} started a Daytona sandbox`, ts);
      break;
    case "stage.done":
      setNode(st, "done");
      say("agent", who(st), e.text, ts);
      if (animate && POS[st]) pulse(st, "supervisor", "", 650);
      break;
    case "stage.failed":
      setNode(st, "failed");
      say("bad", who(st), e.text, ts);
      break;
    case "stage.retry":
      say("bad", who(st), e.text, ts);
      break;
    case "stage.skipped":
      if (!S.status[st]) setNode(st, "skipped");
      break;
    case "approval.requested":
      setNode(st, "waiting");
      S.pending.push({ id: d.approval_id, stage: st, tool: d.tool, args: d.args });
      renderApproval();
      if (animate) { pulse(st, "human", "talk", 800, 0.1); sysHot("human", 3000); }
      say("human", `${who(st)} → on-call`, `asks permission to run ${d.tool} ${JSON.stringify(d.args || {})}`, ts);
      setNow(`<span class="who" style="background:var(--hum-soft);color:var(--hum)">waiting</span> ${esc(who(st))} needs approval for <b>${esc(d.tool)}</b>`);
      break;
    case "approval.decided":
      S.pending = S.pending.filter((p) => p.id !== d.approval_id);
      renderApproval();
      if (S.status[st] === "waiting") setNode(st, "running");
      if (animate) pulse("human", st, "talk", 700, 0.1);
      say("human", `on-call (${d.via || "?"})`, e.text, ts);
      break;
    case "agent.question":
    case "agent.sendback":
      if (animate) talkLine(d.from, d.to, d.message || "");
      say(e.kind === "agent.question" ? "ask" : "back", `${d.from} → ${d.to}`, d.message, ts);
      break;
    case "agent.answer":
      say("agent", `${who(st)} (answer)`, (d.answer && d.answer.summary) || e.text, ts);
      break;
    case "evidence":
      addEvidence(e);
      break;
    case "cost":
      setCost(Number(d.total_usd || 0));
      break;
    case "jira":
      if (S.inc) { S.inc.jira_key = d.key; S.inc.jira_url = d.url; renderTitle(); }
      if (animate) { pulse("plan", "human", "talk", 700); sysHot("human", 1500); }
      say("sys", "jira", e.text, ts, d.url ? ` <a href="${esc(d.url)}" target="_blank" rel="noopener">open ↗</a>` : "");
      break;
    case "incident.mitigated":
      if (S.inc) { S.inc.status = "mitigated"; renderTitle(); }
      say("agent", "incident", e.text, ts);
      break;
    case "incident.resolved":
    case "incident.escalated":
    case "incident.closed":
      S.tEnd = Date.parse(ts);
      hubThinking(false);
      if (S.inc) { S.inc.status = { "incident.resolved": "resolved", "incident.escalated": "escalated", "incident.closed": "false_alarm" }[e.kind]; renderTitle(); }
      say(e.kind === "incident.resolved" ? "agent" : "bad", "incident", e.text, ts);
      setNow(`<span class="who">${e.kind === "incident.resolved" ? "resolved" : "stopped"}</span> ${esc(e.text)}`);
      break;
    case "incident.symptom":
      say("sys", "watcher", e.text, ts);
      break;
  }
  renderTimeline();
}

// ---------------- loading an incident ----------------
function resetView() {
  S = freshState();
  drawMap();
  $("#talk").innerHTML = `<li class="empty">The agents' decisions, questions and answers appear here.</li>`;
  $("#evidence").innerHTML = `<p class="empty">Log lines, traces and commits appear here as they are read.</p>`;
  $("#approval").innerHTML = "";
  setCost(0); renderTraffic(); renderTimeline(); renderTitle();
}
async function loadIncident(id) {
  const r = await fetch(`/api/incidents/${id}`);
  if (!r.ok) return null;
  const inc = await r.json();
  resetView();
  S.id = inc.id; S.inc = inc; S.t0 = Date.parse(inc.opened_at);
  renderTitle();
  return inc;
}
async function goLive(id) {
  stopReplay();
  const inc = await loadIncident(id);
  if (!inc) return;
  const active = ["open", "mitigated"].includes(inc.status);
  setMode(active ? "live" : "view");
  for (const e of inc.events) apply(e, false);
  S.pending = (inc.approvals || []).filter((a) => a.status === "pending").map((a) => ({ id: a.id, stage: a.stage, tool: a.tool, args: a.args }));
  renderApproval();
  setCost(Number(inc.total_cost_usd || 0));
  if (inc.resolved_at) S.tEnd = Date.parse(inc.resolved_at);
  else if (!active && S.lastTs) S.tEnd = S.lastTs;
  tickElapsed();
}
async function replay(id) {
  stopReplay();
  const inc = await loadIncident(id);
  if (!inc) return;
  setMode("replay");
  const evs = inc.events.filter((e) => e.kind !== "watcher.tick");
  Object.assign(S.inc, { status: "open", jira_key: null, jira_url: null, pr_url: null });
  renderTitle();
  let i = 0;
  const next = () => {
    if (i >= evs.length) { replayTimer = null; $("#replay-btn").textContent = "Replay"; return; }
    const e = evs[i++];
    apply(e, true);
    const gap = i < evs.length ? Date.parse(evs[i].ts) - Date.parse(e.ts) : 0;
    replayTimer = setTimeout(next, Math.max(90, Math.min(1400, gap / 6)));
  };
  $("#replay-btn").textContent = "Stop";
  next();
}
function stopReplay() {
  if (replayTimer) clearTimeout(replayTimer);
  replayTimer = null;
  $("#replay-btn").textContent = "Replay";
}
function setMode(m) {
  mode = m;
  $("#mode").className = "mode " + ({ live: "live", replay: "replay", view: "view" }[m] || "");
  $("#mode-text").textContent = { live: "live", replay: "replay", view: "finished" }[m] || "watching";
}

// ---------------- stream ----------------
function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("hello", (m) => { renderWatch(JSON.parse(m.data).watch); });
  es.addEventListener("message", async (m) => {
    const e = JSON.parse(m.data);
    if (e.kind === "watcher.tick") { if (mode !== "replay") renderWatch(e.data); return; }
    if (e.kind === "incident.opened" && e.incident_id !== S.id) { await goLive(e.incident_id); return; }
    if ((mode === "live" || mode === "view") && e.incident_id === S.id) {
      apply(e, true);
      if (["stage.done", "jira", "incident.resolved", "incident.escalated"].includes(e.kind)) {
        const r = await fetch(`/api/incidents/${S.id}`);
        if (r.ok) {
          const inc = await r.json();
          Object.assign(S.inc, { status: inc.status, severity: inc.severity, jira_key: inc.jira_key, jira_url: inc.jira_url, pr_url: inc.pr_url, summary: inc.summary });
          renderTitle();
        }
      }
    }
  });
  es.onerror = () => { if (mode !== "replay") { $("#mode").className = "mode"; $("#mode-text").textContent = "reconnecting"; } };
  es.onopen = () => { if (mode !== "replay") setMode(mode); };
}

// ---------------- drawer ----------------
function openDrawer(view = "history") {
  $("#drawer").hidden = false;
  $("#menu-btn").setAttribute("aria-expanded", "true");
  document.querySelectorAll(".drawer-h nav button").forEach((b) => b.classList.toggle("on", b.dataset.v === view));
  ({ history: showHistory, connections: showConnections, system: showSystem })[view]();
}
function closeDrawer() { $("#drawer").hidden = true; $("#menu-btn").setAttribute("aria-expanded", "false"); }
async function showHistory() {
  const rows = await (await fetch("/api/incidents")).json();
  $("#drawer-b").innerHTML = `<table><thead><tr><th>Incident</th><th>Service</th><th>Status</th><th>Opened</th><th>Cost</th><th></th></tr></thead><tbody>
    ${rows.map((i) => `<tr data-id="${esc(i.id)}"><td><b>${esc(i.id)}</b><div class="muted small">${esc(i.summary || "")}</div></td>
    <td>${esc(i.service)}</td><td>${esc(i.status)}</td><td>${new Date(i.opened_at).toLocaleString()}</td>
    <td>₹${(Number(i.total_cost_usd || 0) * USD_INR).toFixed(2)}</td>
    <td><button class="ghost" data-replay="${esc(i.id)}">Replay</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">No incidents yet.</td></tr>`}
    </tbody></table>`;
  document.querySelectorAll("#drawer-b tr[data-id]").forEach((tr) => tr.onclick = (ev) => {
    closeDrawer();
    if (ev.target.dataset.replay) replay(ev.target.dataset.replay); else goLive(tr.dataset.id);
  });
}
async function showConnections() {
  $("#drawer-b").innerHTML = `<p class="muted">Checking…</p>`;
  const c = await (await fetch("/api/connections")).json();
  const box = (name, ok, detail, warn) => `<div class="cbox ${ok ? "ok" : warn ? "warn" : ""}"><b><span class="dot"></span>${esc(name)}</b><div class="d">${esc(detail ?? "")}</div></div>`;
  const tf = c.trueforge || {};
  $("#drawer-b").innerHTML = `<div class="conns">${[
    box("TrueForge", tf.ok, `v${tf.detail || "?"} · ${tf.model_providers ?? 0} model provider · ${(tf.agents || []).length} agents`),
    ...Object.entries(tf.mcp_servers || {}).map(([n, s]) => box(`MCP · ${n}`, s === "authenticated" || s === "not_required", s, s === "auth_required")),
    box("Ops MCP (live)", c.ops_mcp?.ok, c.ops_mcp?.detail), box("Prometheus", c.prometheus?.ok, c.prometheus?.ok ? "ready" : c.prometheus?.detail),
    box("Jira approvals", c.jira?.ok, c.jira?.detail, !c.jira?.ok), box("Slack", c.slack?.ok, c.slack?.detail, !c.slack?.ok),
  ].join("")}</div><p class="muted small" style="margin-top:12px">Agents: ${esc((tf.agents || []).join(", "))}</p>`;
}
async function showSystem() {
  const s = await (await fetch("/api/system")).json();
  $("#drawer-b").innerHTML = `<p class="muted">Everything NightShift knows about this system comes from <code>systems/${esc(s.name)}.yaml</code>. A new system needs a new file, not new agent code.</p><pre>${esc(JSON.stringify(s, null, 2))}</pre>`;
}
document.querySelectorAll(".drawer-h nav button").forEach((b) => b.addEventListener("click", () => openDrawer(b.dataset.v)));
$("#menu-btn").onclick = () => openDrawer("history");
$("#drawer-close").onclick = closeDrawer;
$("#drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") closeDrawer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

$("#replay-btn").onclick = async () => {
  if (replayTimer) { stopReplay(); setMode("idle"); return; }
  const rows = await (await fetch("/api/incidents")).json();
  const target = rows.find((i) => ["resolved", "escalated"].includes(i.status)) || rows[0];
  if (target) replay(target.id); else setNow(`<span class="muted">No incidents to replay yet.</span>`);
};

// ---------------- start ----------------
(async function start() {
  resetView();
  setMode("idle");
  connect();
  fetch("/api/watch").then((r) => r.json()).then(renderWatch).catch(() => {});
  const rows = await (await fetch("/api/incidents")).json();
  const active = rows.find((i) => ["open", "mitigated"].includes(i.status));
  if (location.hash === "#replay" && rows.length) { $("#replay-btn").click(); return; }
  if (location.hash.startsWith("#view-")) { goLive(location.hash.slice(6)); return; }
  if (active) goLive(active.id);
  else setNow(rows.length ? `<span class="muted">Idle. The watcher is running. Press <b>Replay</b> to watch the last incident.</span>` : `<span class="muted">Idle. The watcher is running.</span>`);
})();
