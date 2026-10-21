// Manipulation Shield security console. No framework, no build step. Talks to /v1 on the same origin.
const $ = (sel) => document.querySelector(sel);
const view = () => $("#view");

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ACTIONS = {
  payment: "Payments",
  vendor_bank_change: "Vendor bank changes",
  credential_reset: "Password and MFA resets",
  access_grant: "Access grants",
  data_export: "Data exports",
};
const ALL_KINDS = Object.keys(ACTIONS);
const MIN_LABELS_FOR_RATE = 5;
const MIN_LABELS_FOR_ENFORCE = 20;

// --- session (pilot auth: API key + actor id, this tab only) ---------------------------------
const session = {
  get key() {
    return sessionStorage.getItem("shield.key");
  },
  get actor() {
    return sessionStorage.getItem("shield.actor");
  },
  set(key, actor) {
    sessionStorage.setItem("shield.key", key);
    sessionStorage.setItem("shield.actor", actor);
  },
  clear() {
    sessionStorage.removeItem("shield.key");
    sessionStorage.removeItem("shield.actor");
  },
};

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${session.key}`,
      "x-shield-actor": session.actor ?? "",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    session.clear();
    route();
    throw new Error("Signed out: the API key was not accepted.");
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// --- formatting ------------------------------------------------------------------------------
const badge = (v) =>
  v ? `<span class="badge ${esc(v)}">${esc(String(v).replace("_", " "))}</span>` : "";
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const money = (amount, currency) =>
  amount == null ? "" : `${Number(amount).toLocaleString()} ${esc(currency ?? "")}`.trim();
function pct(r) {
  if (!r || r.den < MIN_LABELS_FOR_RATE)
    return `<span class="muted">not enough labels${r ? ` (${r.den})` : ""}</span>`;
  return `${(r.value * 100).toFixed(1)}% <span class="ci">${r.num}/${r.den} · 95% CI ${(r.ci[0] * 100).toFixed(0)}–${(r.ci[1] * 100).toFixed(0)}%</span>`;
}
let tacticNames = {};
const tacticName = (id) => tacticNames[id] ?? id;

/** Evidence highlighting: case- and whitespace-insensitive, longest first, non-overlapping. */
function highlight(text, spans) {
  const ranges = [];
  for (const { span, label } of [...spans].sort((a, b) => b.span.length - a.span.length)) {
    if (!span || span.length < 3) continue;
    const re = new RegExp(reEsc(span.trim()).replace(/\s+/g, "\\s+"), "gi");
    let m;
    while ((m = re.exec(text))) {
      const [start, end] = [m.index, m.index + m[0].length];
      if (!ranges.some((r) => start < r.end && end > r.start)) ranges.push({ start, end, label });
      if (!m[0].length) re.lastIndex++;
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const r of ranges) {
    out +=
      esc(text.slice(pos, r.start)) +
      `<mark title="${esc(r.label)}">${esc(text.slice(r.start, r.end))}</mark>`;
    pos = r.end;
  }
  return out + esc(text.slice(pos));
}

// --- views -----------------------------------------------------------------------------------
function signIn() {
  $("#nav").hidden = true;
  view().innerHTML = `
    <form class="panel signin" id="signin">
      <h2 class="mt0">Sign in</h2>
      <label><span>API key</span><input id="key" type="password" autocomplete="off" required /></label>
      <label><span>Your id for the audit trail (e.g. email or employee number)</span><input id="actor" required /></label>
      <p class="muted small">Pilot sign-in: the key stays in this browser tab only. Single sign-on replaces this before production.</p>
      <button class="primary" type="submit">Sign in</button>
      <p class="error" id="err" hidden></p>
    </form>`;
  $("#signin").addEventListener("submit", async (e) => {
    e.preventDefault();
    session.set($("#key").value.trim(), $("#actor").value.trim());
    try {
      await api("/v1/reports/summary?days=1");
      location.hash = "#/overview";
      route();
    } catch (err) {
      session.clear();
      $("#err").textContent = err.message;
      $("#err").hidden = false;
    }
  });
}

async function overview() {
  const days = Number(new URLSearchParams(location.hash.split("?")[1]).get("days") ?? 30);
  const s = await api(`/v1/reports/summary?days=${days}`);
  const t = s.totals;
  const shadow = s.workflows.filter((w) => w.mode === "shadow" && w.checks > 0);
  const stopped =
    Object.entries(t.stoppedByCurrency)
      .map(([c, v]) => money(v, c))
      .join(" + ") || "0";
  const maxTactic = Math.max(1, ...s.topTactics.map((x) => x.count));
  view().innerHTML = `
    <div class="row between">
      <h2>Overview</h2>
      <select id="days" aria-label="Period">${[7, 30, 90]
        .map((d) => `<option value="${d}" ${d === days ? "selected" : ""}>Last ${d} days</option>`)
        .join("")}</select>
    </div>
    ${
      shadow.length
        ? `<div class="banner warn inline">Shadow mode on ${shadow
            .map((w) => esc(ACTIONS[w.actionKind] ?? w.actionKind))
            .join(
              ", ",
            )}: nothing is held there. Review requests to measure false alarms before enforcing.</div>`
        : ""
    }
    <div class="cards">
      <div class="panel card"><div class="n">${t.checks}</div><div class="l">requests checked</div></div>
      <div class="panel card"><div class="n">${t.paused}</div><div class="l">paused or would pause</div></div>
      <div class="panel card"><div class="n">${t.confirmedAttacks}</div><div class="l">confirmed attacks</div></div>
      <div class="panel card"><div class="n">${t.stoppedAttacks}</div><div class="l">attacks stopped while held${Object.keys(t.stoppedByCurrency).length ? ` · ${stopped}` : ""}</div></div>
      <div class="panel card"><div class="n">${t.medianVerifyMinutes == null ? "–" : `${t.medianVerifyMinutes.toFixed(1)} min`}</div><div class="l">median time to verify</div></div>
    </div>

    <h2>Workflows</h2>
    <div class="panel scroll"><table>
      <thead><tr><th>Workflow</th><th>Mode</th><th>Checks</th><th>Paused</th><th>Pause precision</th><th>False-alarm rate</th><th>Catch rate</th><th>Labels</th></tr></thead>
      <tbody>${
        s.workflows
          .map(
            (w) => `<tr>
              <td>${esc(ACTIONS[w.actionKind] ?? w.actionKind)}</td>
              <td>${badge(w.mode)}</td>
              <td>${w.checks}</td>
              <td>${w.decisions.PAUSE}${w.checks ? ` <span class="ci">${((w.decisions.PAUSE / w.checks) * 100).toFixed(0)}%</span>` : ""}</td>
              <td>${pct(w.pausePrecision)}</td>
              <td>${pct(w.falseAlarmRate)}</td>
              <td>${pct(w.catchRate)}</td>
              <td>${w.labelled.attack} attack · ${w.labelled.legitimate} legit</td>
            </tr>`,
          )
          .join("") || `<tr><td colspan="8" class="muted">No checks yet.</td></tr>`
      }</tbody>
    </table></div>
    <p class="muted small">Precision: of labelled pauses, how many were attacks. False-alarm rate: of requests labelled legitimate, how many were paused. Catch rate depends on which requests reviewers chose to label, so read it with care.</p>

    <div class="grid2">
      <div>
        <h2>Top tactics</h2>
        <div class="panel"><ul class="bars">${
          s.topTactics
            .map(
              (x) =>
                `<li><div>${esc(x.name)}<span class="bar" data-w="${Math.round((x.count / maxTactic) * 100)}"></span></div><div>${x.count}</div></li>`,
            )
            .join("") || `<li class="muted">None yet.</li>`
        }</ul></div>
      </div>
      <div>
        <h2>Catch log</h2>
        <div class="panel scroll"><table>
          <thead><tr><th>When</th><th>Workflow</th><th>Amount</th><th>Outcome</th></tr></thead>
          <tbody>${
            s.catches
              .map(
                (c) => `<tr class="click" data-href="#/requests/${esc(c.requestId)}">
                  <td>${when(c.createdAt)}</td>
                  <td>${esc(ACTIONS[c.actionKind] ?? c.actionKind)}<div class="mono">${esc(c.objectIds.join(", "))}</div></td>
                  <td>${money(c.amount, c.currency)}</td>
                  <td>${c.stopped ? badge("held") + " stopped" : c.decision === "PAUSE" ? "would have paused" : `<span class="muted">${esc(c.decision)}: missed</span>`}</td>
                </tr>`,
              )
              .join("") || `<tr><td colspan="4" class="muted">No confirmed attacks.</td></tr>`
          }</tbody>
        </table></div>
      </div>
    </div>`;
  for (const bar of document.querySelectorAll(".bar")) bar.style.width = `${bar.dataset.w}%`;
  $("#days").addEventListener(
    "change",
    (e) => (location.hash = `#/overview?days=${e.target.value}`),
  );
}

async function requests() {
  const params = new URLSearchParams(location.hash.split("?")[1]);
  const filters = ["decision", "status", "mode"];
  const query = new URLSearchParams();
  for (const f of filters) if (params.get(f)) query.set(f, params.get(f));
  const sel = (name, opts) =>
    `<select data-filter="${name}" aria-label="${name}"><option value="">Any ${name}</option>${opts
      .map((o) => `<option value="${o}" ${params.get(name) === o ? "selected" : ""}>${o}</option>`)
      .join("")}</select>`;
  view().innerHTML = `
    <h2>Requests</h2>
    <div class="filters">${sel("decision", ["PAUSE", "WARN", "ALLOW"])}${sel("status", ["held", "open", "released", "blocked"])}${sel("mode", ["shadow", "enforce"])}</div>
    <div class="panel scroll"><table>
      <thead><tr><th>When</th><th>Request</th><th>Decision</th><th>Status</th><th>Tactics</th><th>Label</th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
    <div class="row mt12"><button class="secondary" id="more" hidden>Load more</button></div>`;
  for (const s of document.querySelectorAll("[data-filter]"))
    s.addEventListener("change", () => {
      const q = new URLSearchParams();
      for (const x of document.querySelectorAll("[data-filter]"))
        if (x.value) q.set(x.dataset.filter, x.value);
      location.hash = `#/requests?${q}`;
    });
  let before = null;
  const load = async () => {
    const q = new URLSearchParams(query);
    q.set("limit", "50");
    if (before) q.set("before", before);
    const rows = await api(`/v1/requests?${q}`);
    $("#rows").insertAdjacentHTML(
      "beforeend",
      rows
        .map(
          (r) => `<tr class="click" data-href="#/requests/${esc(r.id)}">
            <td>${when(r.createdAt)}</td>
            <td>${esc(ACTIONS[r.action.kind] ?? r.action.kind)} ${money(r.action.amount, r.action.currency)}<div class="mono">${esc(r.objectIds.join(", "))}</div></td>
            <td>${badge(r.decision)} <span class="ci">${esc(r.mode)}</span></td>
            <td>${badge(r.status)}</td>
            <td>${r.tactics.map((t) => esc(tacticName(t))).join(", ") || '<span class="muted">none</span>'}</td>
            <td>${r.label ? badge(r.label) : '<span class="muted">unlabelled</span>'}</td>
          </tr>`,
        )
        .join("") ||
        (before ? "" : `<tr><td colspan="6" class="muted">No requests match.</td></tr>`),
    );
    before = rows.length ? rows[rows.length - 1].createdAt : before;
    $("#more").hidden = rows.length < 50;
  };
  $("#more").addEventListener("click", load);
  await load();
}

async function requestDetail(id) {
  const d = await api(`/v1/requests/${encodeURIComponent(id)}`);
  const latest = d.analyses[d.analyses.length - 1];
  const spans = (latest?.hits ?? [])
    .filter((h) => h.confidence >= 0.5)
    .flatMap((h) => h.evidence.map((span) => ({ span, label: tacticName(h.tacticId) })));
  const open = d.verifications.find(
    (v) => v.kind === "callback" && (v.status === "pending" || v.status === "needs_contact"),
  );
  const action = d.request.action;
  view().innerHTML = `
    <p><a href="#/requests">← Requests</a></p>
    <div class="panel">
      <div class="row between">
        <div><strong>${esc(ACTIONS[action.kind] ?? action.kind)}</strong> ${money(action.amount, action.currency)}
          <div class="mono">${esc((d.request.object_ids ?? []).join(", "))} · ${when(d.request.created_at)}</div></div>
        <div class="row">${latest ? badge(latest.decision) + " " + badge(latest.mode) : ""} ${badge(d.request.status)}</div>
      </div>
      ${latest ? `<ul class="plain">${latest.explanations.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
    </div>

    ${
      open
        ? `<h2>Verification needed</h2>
      <div class="panel">
        <div class="script">${esc(open.script)}</div>
        <div class="row mt12">
          <select id="outcome" aria-label="Outcome"><option value="legitimate">Legitimate</option><option value="attack">Attack</option><option value="inconclusive">Inconclusive</option></select>
          <select id="channel" aria-label="Channel used"><option value="phone">Called the number on file</option><option value="email">Emailed the address on file</option><option value="in_person">In person</option></select>
          <button class="primary" id="complete">Record outcome</button>
        </div>
        <div class="row mt12">
          <input id="reason" placeholder="Override reason (required, at least 10 characters)" class="grow" />
          <button class="secondary" id="override">Override and release</button>
        </div>
        <p class="error" id="verr" hidden></p>
      </div>`
        : ""
    }

    <h2>Messages</h2>
    ${
      d.artifacts
        .map(
          (a) =>
            `<div class="message"><div class="meta">${esc(
              [
                a.channel,
                a.sender?.displayName || a.sender?.address
                  ? `from ${a.sender.displayName ?? ""} <${a.sender.address ?? "?"}>`
                  : "",
                a.replyTo ? `reply-to ${a.replyTo}` : "",
              ]
                .filter(Boolean)
                .join(" · "),
            )}</div>${a.purged ? '<span class="muted">Body purged under the retention policy.</span>' : `${a.subject ? highlight(a.subject, spans) + "\n\n" : ""}${highlight(a.body, spans)}`}</div>`,
        )
        .join("") || '<p class="muted">No messages attached to this request.</p>'
    }

    <h2>Review</h2>
    <div class="panel">
      <p class="muted mt0">Label this request so false-alarm rates can be measured. Reviewing doesn't release or hold anything.</p>
      <div class="row">
        <button class="secondary" data-review="legitimate">Legitimate</button>
        <button class="secondary" data-review="attack">Attack</button>
        <button class="secondary" data-review="inconclusive">Inconclusive</button>
      </div>
      <p class="error" id="rerr" hidden></p>
    </div>

    <div class="grid2">
      <div>
        <h2>Analyses</h2>
        <div class="panel scroll"><table><thead><tr><th>When</th><th>Decision</th><th>Mode</th><th>Engine</th></tr></thead><tbody>${d.analyses
          .map(
            (a) =>
              `<tr><td>${when(a.created_at)}</td><td>${badge(a.decision)}${a.held ? " held" : ""}</td><td>${esc(a.mode)}</td><td class="mono">library ${esc(a.provenance.libraryVersion)} · ${esc(a.provenance.provider)}</td></tr>`,
          )
          .join("")}</tbody></table></div>
      </div>
      <div>
        <h2>Audit trail</h2>
        <div class="panel scroll"><table><thead><tr><th>When</th><th>Event</th><th>By</th></tr></thead><tbody>${
          d.auditEvents
            .map(
              (e) =>
                `<tr><td>${when(e.created_at)}</td><td>${esc(e.event.replaceAll("_", " "))}${e.reason ? `<div class="muted">${esc(e.reason)}</div>` : ""}</td><td class="mono">${esc(e.actor_ref)}</td></tr>`,
            )
            .join("") || `<tr><td colspan="3" class="muted">No events.</td></tr>`
        }</tbody></table></div>
      </div>
    </div>`;

  const fail = (el, err) => {
    $(el).textContent = err.message;
    $(el).hidden = false;
  };
  if (open) {
    $("#complete").addEventListener("click", () =>
      api(`/v1/verifications/${open.id}/complete`, {
        method: "POST",
        body: { outcome: $("#outcome").value, channelUsed: $("#channel").value },
      })
        .then(() => requestDetail(id))
        .catch((e) => fail("#verr", e)),
    );
    $("#override").addEventListener("click", () =>
      api(`/v1/verifications/${open.id}/override`, {
        method: "POST",
        body: { reason: $("#reason").value },
      })
        .then(() => requestDetail(id))
        .catch((e) => fail("#verr", e)),
    );
  }
  for (const b of document.querySelectorAll("[data-review]"))
    b.addEventListener("click", () =>
      api(`/v1/requests/${id}/review`, { method: "POST", body: { outcome: b.dataset.review } })
        .then(() => requestDetail(id))
        .catch((e) => fail("#rerr", e)),
    );
}

async function workflows() {
  const s = await api("/v1/reports/summary?days=30");
  const byKind = Object.fromEntries(s.workflows.map((w) => [w.actionKind, w]));
  view().innerHTML = `
    <h2>Workflows</h2>
    <p class="muted">Every workflow starts in shadow mode: decisions are recorded but nothing is held. Switch to enforce once the false-alarm rate on reviewed requests is acceptable.</p>
    <div class="panel scroll"><table>
      <thead><tr><th>Workflow</th><th>Mode</th><th>Checks (30 days)</th><th>False-alarm rate</th><th>Labels</th><th></th></tr></thead>
      <tbody>${ALL_KINDS.map((k) => {
        const w = byKind[k] ?? {
          mode: "shadow",
          checks: 0,
          labelled: { attack: 0, legitimate: 0 },
          falseAlarmRate: null,
        };
        const next = w.mode === "shadow" ? "enforce" : "shadow";
        return `<tr>
          <td>${esc(ACTIONS[k])}</td><td>${badge(w.mode)}</td><td>${w.checks}</td>
          <td>${pct(w.falseAlarmRate)}</td>
          <td>${w.labelled.attack + w.labelled.legitimate}</td>
          <td><button class="secondary" data-kind="${k}" data-next="${next}">Switch to ${next}</button></td>
        </tr>
        <tr hidden id="confirm-${k}"><td colspan="6"><div class="confirm"></div></td></tr>`;
      }).join("")}</tbody>
    </table></div>
    <p class="error" id="werr" hidden></p>`;
  for (const b of document.querySelectorAll("[data-kind]"))
    b.addEventListener("click", () => {
      const k = b.dataset.kind;
      const next = b.dataset.next;
      const w = byKind[k];
      const labels = w ? w.labelled.attack + w.labelled.legitimate : 0;
      const row = $(`#confirm-${k}`);
      row.hidden = false;
      row.querySelector(".confirm").innerHTML =
        next === "enforce"
          ? `<p class="mt0"><strong>Enforce ${esc(ACTIONS[k])}?</strong> Paused requests will be held until someone verifies them through a contact on file.</p>
             <p>False-alarm rate on reviewed requests: ${pct(w?.falseAlarmRate)}.</p>
             ${labels < MIN_LABELS_FOR_ENFORCE ? `<p class="error">Only ${labels} labelled request(s). We recommend at least ${MIN_LABELS_FOR_ENFORCE} before enforcing, so the false-alarm rate means something.</p>` : ""}
             <div class="row"><button class="primary" data-go>Enforce</button><button class="secondary" data-cancel>Cancel</button></div>`
          : `<p class="mt0"><strong>Return ${esc(ACTIONS[k])} to shadow mode?</strong> Nothing will be held.</p>
             <div class="row"><button class="primary" data-go>Switch to shadow</button><button class="secondary" data-cancel>Cancel</button></div>`;
      row.querySelector("[data-cancel]").addEventListener("click", () => (row.hidden = true));
      row.querySelector("[data-go]").addEventListener("click", () =>
        api(`/v1/workflows/${k}`, { method: "PUT", body: { mode: next } })
          .then(workflows)
          .catch((e) => {
            $("#werr").textContent = e.message;
            $("#werr").hidden = false;
          }),
      );
    });
}

// --- routing ---------------------------------------------------------------------------------
async function route() {
  if (!session.key) return signIn();
  $("#nav").hidden = false;
  const path = location.hash.replace(/^#\/?/, "").split("?")[0] || "overview";
  const [page, id] = path.split("/");
  for (const a of document.querySelectorAll("nav a"))
    a.classList.toggle("active", a.dataset.route === page);
  try {
    if (page === "requests" && id) await requestDetail(id);
    else if (page === "requests") await requests();
    else if (page === "workflows") await workflows();
    else await overview();
  } catch (e) {
    if (session.key) view().innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

document.addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-href]");
  if (row) location.hash = row.dataset.href;
});
$("#signout").addEventListener("click", () => {
  session.clear();
  location.hash = "";
  route();
});
window.addEventListener("hashchange", route);

(async () => {
  try {
    const health = await (await fetch("/healthz")).json();
    $("#demo").hidden = !health.demo;
    tacticNames = health.tactics ?? {};
  } catch {
    // The console still works without the names; ids are shown instead.
  }
  route();
})();
