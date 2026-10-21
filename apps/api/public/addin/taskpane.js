// Outlook task pane: checks the open email against the Manipulation Shield API on this origin.
// Nothing is stored server-side unless the user chooses "Report to security".
const $ = (sel) => document.querySelector(sel);
const view = () => $("#view");

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const VERDICT = {
  PAUSE: "Stop. Verify this through a contact you already have on file before acting.",
  WARN: "Be careful: this uses a pressure tactic.",
  ALLOW: "No pressure tactics found.",
};
const ACTIONS = [
  ["none", "Not sure / nothing specific"],
  ["payment", "A payment or wire"],
  ["vendor_bank_change", "A change to a vendor's bank details"],
  ["credential_reset", "A password or MFA reset"],
  ["access_grant", "Access to a system"],
  ["data_export", "Sending data or files"],
];

let message = null;
let lastAction = "none";

const settings = {
  get key() {
    return Office.context.roamingSettings.get("shieldKey") || "";
  },
  save(key) {
    Office.context.roamingSettings.set("shieldKey", key);
    return new Promise((resolve) => Office.context.roamingSettings.saveAsync(() => resolve()));
  },
};

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { authorization: `Bearer ${settings.key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (res.status === 401)
    throw new Error("Your organization key was not accepted. Update it in Settings.");
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function highlight(text, spans) {
  const ranges = [];
  for (const span of [...spans].sort((a, b) => b.length - a.length)) {
    if (!span || span.length < 3) continue;
    const re = new RegExp(reEsc(span.trim()).replace(/\s+/g, "\\s+"), "gi");
    let m;
    while ((m = re.exec(text))) {
      const [start, end] = [m.index, m.index + m[0].length];
      if (!ranges.some((r) => start < r.end && end > r.start)) ranges.push({ start, end });
      if (!m[0].length) re.lastIndex++;
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const r of ranges) {
    out += esc(text.slice(pos, r.start)) + `<mark>${esc(text.slice(r.start, r.end))}</mark>`;
    pos = r.end;
  }
  return out + esc(text.slice(pos));
}

/** Reads the open email through Office.js. Reply-To needs Mailbox 1.8; older clients skip it. */
function readItem() {
  const item = Office.context.mailbox.item;
  const base = {
    channel: "email",
    sender: {
      ...(item.from?.emailAddress ? { address: item.from.emailAddress.toLowerCase() } : {}),
      ...(item.from?.displayName ? { displayName: item.from.displayName } : {}),
    },
    ...(item.subject ? { subject: item.subject } : {}),
  };
  const body = new Promise((resolve, reject) =>
    item.body.getAsync(Office.CoercionType.Text, (r) =>
      r.status === Office.AsyncResultStatus.Succeeded
        ? resolve(r.value)
        : reject(new Error("Could not read the message body.")),
    ),
  );
  const replyTo = new Promise((resolve) => {
    if (typeof item.getAllInternetHeadersAsync !== "function") return resolve(undefined);
    item.getAllInternetHeadersAsync((r) => {
      const m =
        r.status === Office.AsyncResultStatus.Succeeded &&
        /^reply-to:\s*(?:.*<)?([^<>\s]+@[^<>\s]+)>?\s*$/im.exec(r.value);
      resolve(m ? m[1].toLowerCase() : undefined);
    });
  });
  return Promise.all([body, replyTo]).then(([text, reply]) => ({
    ...base,
    body: text,
    ...(reply ? { replyTo: reply } : {}),
  }));
}

function keyForm(error) {
  $("#settingsLink").hidden = true;
  view().innerHTML = `
    <p>Enter the key your security team gave you. It's stored in your Outlook settings.</p>
    <label><span>Organization key</span><input id="key" type="password" autocomplete="off" /></label>
    <button class="primary" id="saveKey">Save</button>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}`;
  $("#saveKey").addEventListener("click", async () => {
    const key = $("#key").value.trim();
    if (!key) return;
    await settings.save(key);
    check();
  });
}

async function check(action = lastAction) {
  lastAction = action;
  $("#settingsLink").hidden = false;
  view().innerHTML = `<p class="muted">Checking…</p>`;
  try {
    message ??= await readItem();
    const r = await api("/v1/check-message", { artifact: message, action: { kind: action } });
    const spans = r.tactics.flatMap((t) => t.evidence);
    view().innerHTML = `
      <div class="verdict"><span class="badge ${esc(r.decision)}">${esc(r.decision)}</span><div>${esc(VERDICT[r.decision])}</div></div>
      ${r.explanations.length ? `<ul>${r.explanations.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
      <label><span>What does this email ask you to do?</span>
        <select id="action">${ACTIONS.map(([v, l]) => `<option value="${v}" ${v === action ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
      </label>
      ${spans.length ? `<h3>Where it shows up</h3><div class="message">${message.subject ? highlight(message.subject, spans) + "\n\n" : ""}${highlight(message.body, spans)}</div>` : ""}
      <button class="secondary" id="report">Report to security</button>
      <p class="small muted" id="reportNote">Checking stores nothing. Reporting sends this email to your security team's console.</p>`;
    $("#action").addEventListener("change", (e) => check(e.target.value));
    $("#report").addEventListener("click", report);
  } catch (e) {
    if (/key was not accepted/.test(e.message)) return keyForm(e.message);
    view().innerHTML = `<p class="error">${esc(e.message)}</p><button class="secondary" id="retry">Try again</button>`;
    $("#retry").addEventListener("click", () => check());
  }
}

async function report() {
  $("#report").disabled = true;
  try {
    await api("/v1/artifacts", {
      artifact: message,
      correlation: lastAction !== "none" ? { actionKind: lastAction } : {},
    });
    $("#reportNote").innerHTML =
      `<span class="ok">Reported. Your security team can see it now.</span>`;
  } catch (e) {
    $("#report").disabled = false;
    $("#reportNote").innerHTML = `<span class="error">${esc(e.message)}</span>`;
  }
}

$("#settingsLink").addEventListener("click", () => keyForm());

if (typeof Office === "undefined") {
  view().innerHTML = `<p>Open this pane from Outlook: select an email, then choose <strong>Check request</strong>.</p>`;
} else {
  Office.onReady(() => {
    if (!Office.context.mailbox?.item) {
      view().innerHTML = `<p>Select an email in Outlook, then choose <strong>Check request</strong>.</p>`;
      return;
    }
    if (!settings.key) keyForm();
    else check();
  });
}
