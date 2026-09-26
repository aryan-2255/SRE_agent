// UI audit with Playwright: every dashboard state, several screen sizes, both themes.
// Needs NightShift running on :8090 (with at least one finished incident; set AUDIT_INCIDENT, default INC-015)
// and Google Chrome (or set CHROME=/path/to/chrome).  npm run audit [-- 1440x900 dark]
// Reports console errors, covered/offscreen controls (z-index), content clipped by non-scrolling containers,
// truncated text, and saves a screenshot per state.   node audit.js [sizes] [themes]
const { chromium } = require("playwright-core");
const INC = process.env.AUDIT_INCIDENT || "INC-015";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const fs = require("fs");
const BASE = "http://localhost:8090/";
const SIZES = (process.argv[2] || "1280x800,1366x768,1440x900,1536x864,1920x1080").split(",");
const THEMES = (process.argv[3] || "dark,light").split(",");
fs.mkdirSync(__dirname + "/shots", { recursive: true });

const STATES = [
  { name: "home", url: "" },
  { name: "incident", url: `#view-${INC}` },
  { name: "agent-panel", url: `#${INC}/fix`, wait: "text=Its answer" },
  { name: "supervisor-panel", url: `#${INC}/supervisor`, wait: "text=Its decisions" },
  { name: "drawer-incidents", url: `#view-${INC}`, click: "button[aria-label^='Open incidents']" },
  { name: "drawer-team", url: `#view-${INC}`, click: "button[aria-label^='Open incidents']", then: "text=The team" },
  { name: "drawer-connections", url: `#view-${INC}`, click: "button[aria-label^='Open incidents']", then: "text=Connections" },
  { name: "hover-card", url: `#view-${INC}`, hover: "svg text >> text=Diagnosis" },
  { name: "replay-approval", url: `?speed=1000#replay-${INC}`, wait: "text=Allow", timeout: 40000 },
];

function inPage() {
  const label = (el) => {
    if (!el) return "?";
    const t = (el.getAttribute && (el.getAttribute("aria-label") || "")) || "";
    const txt = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}[${t || txt}]`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.05;
  };
  const out = { covered: [], offscreen: [], clipped: [], truncated: [], overlaid: 0 };
  // 1. controls someone must be able to click: is the thing under their centre the control itself?
  for (const el of document.querySelectorAll("button, a[href], input")) {
    if (!visible(el) || el.closest("[aria-hidden=true]")) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    // inside a scroll box and scrolled out of view is fine
    let sc = el.parentElement, hiddenByScroll = false;
    while (sc) {
      const cs = getComputedStyle(sc);
      if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX)) {
        const sr = sc.getBoundingClientRect();
        if (y < sr.top || y > sr.bottom || x < sr.left || x > sr.right) hiddenByScroll = true;
      }
      sc = sc.parentElement;
    }
    if (hiddenByScroll) continue;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) { out.offscreen.push(label(el)); continue; }
    const top = document.elementFromPoint(x, y);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      // behind a modal drawer or the agent panel on purpose; toasts are short-lived
      const overlay = top.closest("[role=dialog], [data-sonner-toaster], [data-sonner-toast]") || (top.classList && top.classList.contains("bg-black/40"));
      if (overlay && !el.closest("[role=dialog]")) out.overlaid = (out.overlaid || 0) + 1;
      else out.covered.push(`${label(el)} under ${label(top)}`);
    }
  }
  // 2. content cut by a container that does not scroll (overflow hidden/clip)
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el) || !(el.innerText || "").trim() || el.children.length > 3) continue;
    const r = el.getBoundingClientRect();
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY)) break; // scrollable: reachable
      if (/(hidden|clip)/.test(cs.overflowY) || /(hidden|clip)/.test(cs.overflowX)) {
        const pr = p.getBoundingClientRect();
        if (r.bottom > pr.bottom + 2 || r.right > pr.right + 2 || r.top < pr.top - 2 || r.left < pr.left - 2) {
          // single-line ellipsis is deliberate
          const ecs = getComputedStyle(el);
          if (ecs.textOverflow !== "ellipsis") out.clipped.push(`${label(el)} cut by ${label(p)} (${Math.round(r.bottom - pr.bottom)}px below, ${Math.round(r.right - pr.right)}px right)`);
        }
        break;
      }
      p = p.parentElement;
    }
  }
  // 3. text shortened with an ellipsis
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1) out.truncated.push((el.innerText || "").trim().slice(0, 60));
    if (cs.webkitLineClamp && cs.webkitLineClamp !== "none" && el.scrollHeight > el.clientHeight + 2) out.truncated.push("[clamped] " + (el.innerText || "").trim().slice(0, 50));
  }
  out.page = { sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, w: innerWidth, h: innerHeight };
  return out;
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const report = [];
  for (const size of SIZES) {
    const [w, h] = size.split("x").map(Number);
    for (const theme of THEMES) {
      for (const st of STATES) {
        const page = await browser.newPage({ viewport: { width: w, height: h } });
        const errors = [];
        page.on("console", (m) => { if (["error", "warning"].includes(m.type())) errors.push(m.text().slice(0, 200)); });
        page.on("pageerror", (e) => errors.push("EXCEPTION " + e.message.slice(0, 200)));
        try {
          await page.goto(`${BASE}?theme=${theme}${st.url.startsWith("?") ? "&" + st.url.slice(1) : st.url}`, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(2500);
          if (st.wait) await page.waitForSelector(st.wait, { timeout: st.timeout || 8000 });
          if (st.click) { await page.click(st.click); await page.waitForTimeout(700); }
          if (st.then) { await page.click(st.then); await page.waitForTimeout(900); }
          if (st.hover) { await page.hover(st.hover); await page.waitForTimeout(500); }
          await page.waitForTimeout(800);
          const res = await page.evaluate(inPage);
          const file = `shots/${size}-${theme}-${st.name}.png`;
          await page.screenshot({ path: __dirname + "/" + file });
          report.push({ size, theme, state: st.name, errors, ...res, file });
        } catch (e) {
          report.push({ size, theme, state: st.name, failed: e.message.slice(0, 200), errors });
        }
        await page.close();
      }
    }
  }
  await browser.close();
  fs.writeFileSync(__dirname + "/report.json", JSON.stringify(report, null, 1));
  // summary: one line per state with counts; details for the first occurrence of each problem
  const seen = new Set();
  for (const r of report) {
    const n = (k) => (r[k] || []).length;
    console.log(`${r.size.padEnd(9)} ${r.theme.padEnd(5)} ${r.state.padEnd(18)} ${r.failed ? "FAILED " + r.failed : `err ${n("errors")} covered ${n("covered")} offscreen ${n("offscreen")} clipped ${n("clipped")} truncated ${n("truncated")} page ${r.page.sw}x${r.page.sh}`}`);
    for (const k of ["errors", "covered", "offscreen", "clipped"]) for (const x of r[k] || []) {
      const key = k + x.replace(/\d+px/g, "");
      if (!seen.has(key)) { seen.add(key); console.log(`    ${k}: ${x}`); }
    }
  }
})();
