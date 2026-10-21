// Manipulation Shield demo page. No framework, no build step.
const $ = (id) => document.getElementById(id);
let config = null;

const esc = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const VERDICT_LINE = {
  PAUSE: "Pause and verify through a contact you already have on file.",
  WARN: "Proceed with care: the request uses a pressure tactic.",
  ALLOW: "No pressure tactics found in this request.",
};

/** Highlight evidence spans in text: case- and whitespace-insensitive, longest first, non-overlapping. */
function highlight(text, spans) {
  const ranges = [];
  for (const { span, label } of spans.sort((a, b) => b.span.length - a.span.length)) {
    const re = new RegExp(reEsc(span.trim()).replace(/\s+/g, "\\s+"), "gi");
    let m;
    while ((m = re.exec(text))) {
      const [start, end] = [m.index, m.index + m[0].length];
      if (!ranges.some((r) => start < r.end && end > r.start)) ranges.push({ start, end, label });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const r of ranges) {
    out += esc(text.slice(pos, r.start));
    out += `<mark title="${esc(r.label)}">${esc(text.slice(r.start, r.end))}</mark>`;
    pos = r.end;
  }
  return out + esc(text.slice(pos));
}

function render({ analysis, artifacts, claudeUsed }) {
  $("empty").hidden = true;
  $("result").hidden = false;
  const badge = $("badge");
  badge.textContent = analysis.decision;
  badge.className = `badge ${analysis.decision}`;
  $("verdictLine").textContent = VERDICT_LINE[analysis.decision];
  $("combo").textContent = analysis.criticalCombination
    ? `Critical combination: ${config?.combinations?.[analysis.criticalCombination] ?? analysis.criticalCombination}`
    : analysis.highRiskAction
      ? `High-risk action${analysis.familiesFired.length ? ` · families: ${analysis.familiesFired.join(", ")}` : ""}`
      : "No high-risk action, so this can warn but never pause.";

  $("explanations").innerHTML = analysis.explanations.map((e) => `<li>${esc(e)}</li>`).join("");

  const threshold = 0.5;
  const name = (id) => config?.tactics?.[id]?.name ?? id;
  const spans = analysis.hits
    .filter((h) => h.confidence >= threshold)
    .flatMap((h) => h.evidence.map((span) => ({ span, label: name(h.tacticId) })));
  $("message").innerHTML = artifacts
    .map((a) => {
      const meta = [
        a.channel,
        a.sender?.displayName || a.sender?.address
          ? `from ${a.sender.displayName ?? ""} <${a.sender.address ?? "?"}>`
          : "",
        a.replyTo ? `reply-to ${a.replyTo}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const subject = a.subject ? `${highlight(a.subject, spans)}\n\n` : "";
      return `<div class="art"><div class="meta">${esc(meta)}</div>${subject}${highlight(a.body, spans)}</div>`;
    })
    .join("");

  $("tactics").innerHTML =
    analysis.hits
      .map(
        (h) => `<tr class="${h.confidence < threshold ? "below" : ""}">
          <td>${esc(name(h.tacticId))}<div class="id">${esc(h.tacticId)}</div></td>
          <td><span class="bar" data-w="${Math.round(h.confidence * 60)}"></span>${h.confidence.toFixed(2)}</td>
          <td>${h.source === "both" ? "rules + Claude" : h.source === "llm" ? "Claude" : "rules"}</td>
        </tr>`,
      )
      .join("") || `<tr><td colspan="3">None</td></tr>`;
  // Inline style attributes are blocked by the page's CSP; set widths through the CSSOM instead.
  for (const bar of document.querySelectorAll(".bar")) bar.style.width = `${bar.dataset.w}px`;

  const p = analysis.provenance;
  $("prov").textContent = `library ${p.libraryVersion} · engine ${p.engineVersion} · ${
    claudeUsed ? `Claude ${p.model} (${p.llmStatus})` : "rules only"
  }${p.promptHash ? ` · prompt ${p.promptHash}` : ""}`;
}

async function run() {
  $("error").hidden = true;
  $("go").disabled = true;
  $("go").textContent = $("useClaude").checked ? "Analyzing with Claude…" : "Analyzing…";
  try {
    const amount = $("amount").value === "" ? undefined : Number($("amount").value);
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: $("text").value,
        action: $("action").value,
        amount,
        orgDomain: $("orgDomain").value,
        knownDomain: $("knownDomain").value,
        useClaude: $("useClaude").checked,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    render(data);
  } catch (e) {
    $("error").textContent = e.message;
    $("error").hidden = false;
  } finally {
    $("go").disabled = false;
    $("go").textContent = "Analyze";
  }
}

function loadSample(s) {
  $("text").value = s.text;
  $("action").value = s.action;
  $("amount").value = "";
  $("orgDomain").value = s.orgDomain;
  $("knownDomain").value = s.knownDomain;
  run();
}

async function init() {
  config = await (await fetch("/api/config")).json();
  $("status").textContent = `Tactic library ${config.libraryVersion} · ${
    config.claudeAvailable ? `Claude available (${config.model})` : "rules only"
  }`;
  if (config.claudeAvailable) {
    $("useClaude").checked = true;
    $("claudeNote").textContent = "· sends the text to Anthropic";
  } else {
    $("useClaude").disabled = true;
    $("claudeNote").textContent = "· unavailable: set SHIELD_ANTHROPIC_API_KEY and restart";
  }
  $("samples").innerHTML = "";
  for (const s of config.samples) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s.label;
    b.addEventListener("click", () => loadSample(s));
    $("samples").append(b);
  }
  $("go").addEventListener("click", run);
  $("text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
  });
}

init().catch((e) => {
  $("status").textContent = `Could not load: ${e.message}`;
});
