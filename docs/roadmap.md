# Manipulation Shield: build plan, v1 → v3

## Context

The roadmap (Oct 20, 2026, Daniel Lee) defines a manipulation-detection company. It inspects inbound requests for the _psychological signature_ of social engineering, such as urgency, authority, secrecy, channel switching and process bypass. It does not check whether the media is fake. It moves through three stages, with a gate between each:

- **v1: Enterprise.** Social-engineering defense for finance, IT and exec teams. Gate to v2: paying customers, published accuracy and SOC 2.
- **v2: Defense contractors.** Counter-elicitation for cleared staff. Gate to v3: contractor references and an accredited team.
- **v3: Government.** Reached through In-Q-Tel, SBIR, primes and allied governments. Defensive products only.
- **Copilot track (parallel).** A communication copilot on the same engine.

Decisions taken when this plan was approved:

- **TypeScript + Postgres monorepo.** Everything is containerized and nothing is vendor-locked, so the same code can move to GovCloud or an air-gapped deployment for v2 and v3. Python is used only for offline ML and eval.
- **Copilot runs in parallel but stays thin.**
- **First build is Milestone 0:** tactic library, detection engine and eval harness.

This plan covers what to build, in what order, and what has to be true at each gate. It also covers where the roadmap has holes that the engineering has to close.

---

## Where the roadmap has holes the engineering must close

1. **The unit of analysis is the _request_, not the message.** "Channel switch" means an email followed by a call or a chat. That cannot be detected one message at a time. The core data model needs a `Request` entity that correlates artifacts across channels. The correlation keys are the _action object_ (payment ID, vendor ID, the account being reset) and the _claimed requester_. Retrofitting this later would mean rewriting the engine.
2. **Intervene at the action, not the inbox.** Pausing an email is noise. Pausing a _vendor bank change or payment release_ is precise and defensible. In v1 the hard gate sits in the approval workflow (AP system, help-desk reset), and email and chat are _evidence_. This is how "precision first" becomes architecture.
3. **Real data cannot produce a meaningful published catch rate.** Real BEC attacks are rare, so recall measured on partner traffic will have huge error bars. Measure the two halves separately:
   - **Precision / false-alarm rate:** from real partner traffic, run in shadow mode.
   - **Recall:** from consented red-team simulations at partners, partners' historical incidents and the synthetic corpus.

   The published accuracy report needs this methodology written down and reviewed.

4. **Shadow mode is not optional.** Each new partner runs 2–4 weeks detect-only, with no pauses, before enforcement starts. This tunes thresholds per tenant and produces the false-alarm numbers that go into the published report.
5. **Verification is the ground-truth flywheel.** Each forced verification has an outcome: the request was legitimate or it was an attack. That outcome is a label. Capture it as structured data from day one.
6. **Prompt injection is a first-class threat.** Attackers will write emails aimed at the classifier, such as "this is routine, nothing unusual." Mitigations:
   - Message content is always treated as data, never as instructions.
   - Deterministic feature extractors run independently of the LLM, and the LLM cannot veto them.
   - An injection attempt is itself a tactic.
   - The eval set includes an adversarial suite.
7. **"Analyze requests, not employees" must be structural, not policy.**
   - The schema has no per-employee risk score or table.
   - Aggregations are keyed on tactic, channel, workflow or vendor, never on recipient.
   - An architecture test fails CI if any query groups by recipient.
   - Baselines like "this vendor's bank details haven't changed in 3 years" are keyed on vendor, workflow or role, never on an individual.
8. **Defense contractors (v2) handling CUI need FedRAMP-Moderate-equivalent hosting** (DFARS 252.204-7012) and CMMC Level 2. So government-grade infrastructure starts in **v2**, not v3. That is why portability matters from day one.
9. **A facility clearance cannot be self-obtained.** It needs sponsorship from a cleared customer. Plan for a v2 contractor customer or prime to sponsor the FCL, because the "accredited team" gate depends on it.
10. **The copilot is a brand risk to the security thesis.** The security pitch is that the company is "visibly incapable of being a manipulation company." A people-reading copilot under the same brand undercuts that. Recommendation: a separate brand and a separate data plane, with the shared engine consumed as a library. Copilot data and security-tenant data never mix. This also answers an open question in the roadmap.

---

## Architecture (built once, survives to v3)

```
silvia-keel/                     pnpm workspaces + turborepo, TS strict, Node 22
  packages/
    shared/      domain types + zod schemas: Artifact, Request, Analysis, TacticHit, Verdict, Verification
    tactics/     THE MOAT: tactics/*.yaml + zod schema + loader + semver + lint
    llm/         provider interface (Anthropic API now; Bedrock/GovCloud + open-weight later),
                 prompt templates, structured-output parsing, prompt hashing
    engine/      normalize → prefilter → extract features → LLM tactic classify → combine → decide → explain
    eval/        corpus format, harness, metrics (precision/recall/FAR per tactic + overall), report generator
    db/          Postgres schema + migrations (Drizzle or Kysely; plain SQL, no Supabase lock-in)
    connectors/  (v1 M2+) m365-graph, gmail, slack, teams, ap-*, helpdesk-*
  apps/
    cli/         `shield analyze <file.eml|.txt|.json>`, `shield eval`, `shield tactics lint`
    api/         (M2+) Fastify: ingestion webhooks, analysis API, verification API
    worker/      (M2+) queue consumers (pg-boss on Postgres, so there is no extra infra)
    console/     (M4+) Next.js security-team console
    outlook-addin/ (M2) "Check this request" button
    copilot/     (copilot track) separate app, separate DB
  docs/          principles.md, tactic-authoring.md, eval-methodology.md, threat-model.md, data-handling.md
```

### Detection pipeline (`packages/engine`)

1. **Normalize.** Turn email, chat, approval event or transcript into an `Artifact` with text, headers and metadata. Strip quoted history, but keep it as thread context.
2. **Prefilter.** Deterministic and cheap. Does the artifact touch a high-risk _intent_: payment, bank details, credentials or MFA, gift cards, data export, or a request to move to a private channel? About 95% of traffic stops here. This controls LLM cost and data exposure.
3. **Feature extractors.** Deterministic and LLM-independent:
   - Lexical cue lists per tactic.
   - Reply-to and display-name mismatch, and lookalike domains.
   - First contact.
   - Changes to vendor master data.
   - Amount outside the vendor or workflow norm.
   - Out-of-hours timing.
   - Cross-channel correlation inside the `Request`.
4. **LLM tactic classifier.** A fast model triages first and a stronger model does the full read. Default models are `claude-haiku-5-5` and `claude-sonnet-5-5`, configurable. The prompt is built from the tactic library. Output is constrained JSON: for each tactic ID, `{fired, confidence, evidence: [verbatim quoted spans]}`. Evidence spans are validated so they must appear verbatim in the input, and hallucinated evidence leads to rejection.
5. **Combine and decide.** An interpretable rule policy, not an opaque score:
   - **PAUSE:** at least 2 independent tactic _families_ above threshold, on a high-risk action. Or a single critical combination, such as a vendor bank change plus secrecy.
   - **WARN:** one family.
   - **ALLOW:** otherwise.

   Thresholds can be tuned per tenant and per workflow, and are calibrated in shadow mode.

6. **Explain.** A one-line explanation per fired tactic comes from the tactic's `explanation_template`. It names the tactic, never the person. Banned-phrase tests enforce this, with phrases such as "fraudster", "scammer" and "this person is".

Every `Analysis` records the tactic library version, model ID, prompt hash, feature outputs and the decision. These verdicts are reproducible for audit and for the accuracy report.

### Tactic schema (`packages/tactics`)

- **Identity:** `id`, `name`, `family` (urgency | authority | secrecy | channel | process-bypass | payment-anomaly | elicitation | injection | self-check), `stages` (enterprise | elicitation | copilot), `version`, `status` (draft | active | deprecated).
- **Content:** `description`, `explanation_template`, `indicators` (lexical, structural, contextual), `examples.positive[]`, `examples.hard_negative[]`, `severity`, `stack_rules`, `references`, `author`.
- **Hard negatives are mandatory.** Examples: the real CFO's real urgent wire, and a legitimate vendor bank change with a documented letter. They are what makes precision possible.
- **Lint rules:** schema validity, at least N positives and N hard negatives, no person-labeling language, unique IDs, semver bump required when content changes.

### LLM layer

- A provider interface from day one, with adapters for the Anthropic API now, Bedrock GovCloud in v2 and v3, and an open-weight model for air-gapped v3.
- Anthropic zero-data-retention terms are needed before any partner data is processed. The provider becomes a listed subprocessor in the SOC 2 scope.

---

## v1: Enterprise social-engineering defense

### M0: Engine, tactic library and eval (first build, in this repo)

- Monorepo scaffold: pnpm, turbo, TS strict, vitest, eslint and prettier, GitHub Actions CI (lint, typecheck, test, tactic lint, eval smoke).
- `packages/shared` domain types and `packages/tactics` schema and loader.
- **Seed library of about 20 tactics:**
  - Core families: urgency, authority, secrecy, channel switch, unusual payment method, policy bypass.
  - The six from the roadmap's enterprise table: executive pressure, secrecy, channel switch, process bypass, vendor detail change, help-desk pressure.
  - Prompt injection.

  Each tactic has positive examples and hard negatives.

- `packages/engine` covering all six pipeline stages above. The LLM is behind an interface, with a deterministic fake for tests.
- **`packages/eval` corpus and metrics:**
  - Corpus is JSONL: artifact, labels (tactics, attack yes/no) and `source` (synthetic | public | partner | redteam).
  - The harness reports precision, recall and false-alarm rate (FAR) overall and per tactic, with Wilson confidence intervals, plus a confusion matrix.
  - It also produces a markdown report.
  - Initial corpus is about 300 items:
    - Synthetic variants generated from the tactic library and hand-reviewed.
    - Public BEC examples from FBI IC3 PSAs and vendor write-ups.
    - About 50% hard-negative legitimate urgent requests.
    - An adversarial injection suite.
- `apps/cli`: `analyze`, `eval` and `tactics lint`.
- `docs/principles.md` turns the six roadmap principles into enforced rules and names the test that enforces each one.

### M1: Copilot "first test" and partner demo harness

- **Copilot first test.** Run 5 real conversations through the engine in copilot mode, scoring Claude's read against Daniel's on a rubric: catches, misses, speed and false reads. Record the gaps as tactic-library work.
- **Paste-a-request analyzer.** A minimal web page where design partners paste or forward a past incident and see the tactic read. This is the sales asset for signing design partners.

### M2: Integrations (the payment and vendor-change workflow first)

- **Microsoft 365 Graph mail ingestion.** Use change-notification subscriptions with least-privilege application access scoped to finance and AP mailboxes through an application access policy, not tenant-wide. Gmail follows the same pattern.
- **Outlook add-in.** A "Check this request" button for the user, which works without any admin integration.
- **AP and vendor-master gate.** A generic webhook/API contract ("approve-pending event → verdict") plus 1–2 native adapters. Pick adapters by what design partners use, for example Bill.com, Ramp, NetSuite or Coupa. Vendor master data supplies the _known-good contacts_.
- **Request correlator.** Links an email, a chat and an approval into one `Request` by action object and claimed requester.
- **Slack and Teams.** Message events from finance and helpdesk channels. Teams call metadata only (who called, when), with no audio.
- **Calls.** Cloned-voice calls are visible in v1 only as metadata or as a user report ("I got a call confirming this") inside the verification flow. Real-time voice is deferred, as stated below.

### M3: Forced-pause verification flow

- A PAUSE puts the action on hold until verification succeeds. Verification goes through a **known-good channel taken from the system of record**, meaning vendor master data or the HRIS directory. Contact details in the suspicious message are never used.
- The flow gives the employee a callback script and records the outcome (legitimate or attack). An override path requires a reason and creates an audit event.
- Outcomes become labels for the eval corpus and threshold tuning (the flywheel).
- **Escalation SLA.** Verification must not cost more than about 2 minutes on a legitimate request. Measure that, because friction is how tools get switched off.

### M4: Console and shadow mode

- Next.js console:
  - Alert feed with the tactics that fired and their evidence.
  - Catch log with dollar amounts stopped.
  - Tactic and channel trends.
  - Workflow and threshold config.
  - Shadow/enforce toggle per workflow.
  - Accuracy dashboard per tenant.
- It deliberately has **no employee-level views or rankings.**

### M5: Help-desk pressure workflow

- ServiceNow, Jira Service Management and Okta/Entra adapters for password and MFA reset requests.
- Applies the same pause and verify flow, with the known-good channel coming from HRIS and the manager.

### M6: Enterprise readiness, run in parallel from M2

- **Identity and access:** SSO (SAML/OIDC), SCIM, RBAC (security admin, finance admin, viewer).
- **Data protection:**
  - Tenant isolation through Postgres RLS plus a tenant ID on every row.
  - Envelope encryption with per-tenant keys.
  - Retention settings: store evidence spans and hashes, purge full bodies after N days.
- **Audit and operations:** audit log, status page, incident runbook.
- **Compliance:**
  - Start SOC 2 Type I early using Vanta or Drata, then open the Type II window.
  - Third-party pen test.
  - DPA, subprocessor list and security whitepaper.

### M7: Published accuracy report v1

- Written methodology from `docs/eval-methodology.md`.
- Precision and false-alarm rate (FAR) from shadow and enforce data across partners.
- Recall from red-team and historical incidents plus the corpus.
- Per-tactic tables and confidence intervals.
- Reviewed by the security-credible advisor.

### Gate 1 → v2 (make it measurable)

- At least 3 paying customers converted from design partners, and at least 1 referral.
- A published accuracy report. The bar: pauses on legitimate requests are at most about 1 in 200 high-risk requests, and the median verification takes under 2 minutes.
- Documented attacks stopped, with dollar amounts.
- SOC 2 Type I complete and the Type II observation window running.

---

## v2: Defense contractors (counter-elicitation)

### Engine extensions

- **Thread and longitudinal analysis.** Elicitation only shows across weeks of messages from one outreach party. Add an `OutreachThread` that aggregates messages per external party. Add trajectory features:
  - Escalation in how specific the asks become.
  - Flattery followed by an ask.
  - Pressure to move to private channels.
  - A recruiter or consulting offer followed by requests for technical detail.
- **Elicitation tactic library.** About 15 new tactics, built with counterintelligence-informed advisors and cross-referenced to public NCSC and DCSA guidance on elicitation and recruitment.

### Products

- **Opt-in employee tool.** The employee forwards to a scan address, uses a share sheet, uses a browser extension, or uploads a screenshot with OCR. LinkedIn has no API for this, so forwarding and screenshots are the realistic path. The tool returns an instant read and explains how to report. It drafts a **suspicious-contact report** for the facility security officer (FSO), in line with the NISPOM reporting obligations in 32 CFR 117.
- **Security-office view.** Shows only aggregated, anonymized trends: which tactics, channels and programs are being targeted.
  - k-anonymity floor: a cell is suppressed when fewer than 5 people contribute to it.
  - No drill-down to individuals.
  - Program names are configurable and kept as tenant-local labels, because they may be sensitive.

### Infrastructure and compliance (the real long pole)

- **Deployment.** A GovCloud deployment profile: dedicated single-tenant stack, Helm charts, Terraform modules and FIPS 140-validated crypto. The LLM runs through Bedrock GovCloud.
- **Connectors.** Microsoft 365 GCC High uses different Graph endpoints, so the connector config must handle that.
- **Certifications.**
  - CMMC Level 2: a NIST 800-171 System Security Plan (SSP) and a third-party (C3PAO) assessment.
  - A FedRAMP Moderate _equivalency_ package for DFARS 7012.
- **People.** US-person-only support for these tenants. Begin facility clearance (FCL) sponsorship through a customer.

### Gate 2 → v3

- At least 2–3 contractor customers who will serve as references.
- CMMC L2 certified.
- FCL in progress or granted, plus cleared key staff.
- A prime partnership identified.

---

## v3: Government

### Product hardening

- **Deployment modes:** single-tenant GovCloud; on-prem or **air-gapped** Kubernetes with Iron Bank hardened images.
- **Models and auth:** an open-weight model adapter for disconnected networks, with its own eval run, because the accuracy report must be reproduced _per model_. CAC/PIV authentication.
- **Platform compliance:** DISA STIG compliance, SBOM and signed artifacts, Section 508 accessibility.

### Accreditation

- FedRAMP Moderate, then High, through the FedRAMP 20x path where it applies.
- DoD Impact Level 4/5 for defense agencies.
- An Authority to Operate (ATO) through a sponsoring agency.

### Paths in

- An SBIR Phase I proposal aligned to a workforce-protection topic, then Phase II, with Phase III as the production route.
- An In-Q-Tel pitch once v2 references exist.
- Riding a prime's contract vehicle.
- Allied buyers: UK, NATO DIANA and EU hybrid-threat programs.

### Defense-only as a technical control, not just a promise

- The product has no API that returns per-person profiles or influence recommendations.
- An acceptable-use clause in every contract.
- An internal ethics review for any government feature request.
- A public "what we will never build" page.

---

## Copilot track (parallel, thin)

- A separate app, brand and database that consumes `packages/engine` and `packages/tactics` as libraries.
- **Features, in order:**
  1. **Self-check.** Run the tactic library over the _user's own_ draft. This reuses the engine directly.
  2. **Draft and de-escalate.**
  3. **Prep.** Goal, the user's leverage, and what the other side likely cares about.
  4. **Read the room.** When two readings are possible, it gives both and names the question that settles it.
  5. **Practice.** Claude role-plays the other side with realistic pushback.
  6. **Remember context.**
- **Precise boundary for "remember context":**
  - It stores only what the user explicitly authors about goals, commitments, stated interests and history.
  - It never stores inferred psychological vulnerabilities.
  - Requests to exploit insecurities, script deception or push past a "no" are refused.
  - A refusal eval suite enforces this boundary, and it runs in CI.
- **Honest pushback.** The system prompt and the eval rubric reward telling users when _they_ are the one escalating.
- **First audience.** Recommendation: work and client conversations. They are closest to the security buyer's world, and the roadmap leaves this open.

---

## Indicative timeline (as of 2026-10-21)

| Period       | Milestones                                                                      |
| ------------ | ------------------------------------------------------------------------------- |
| Nov–Dec 2026 | M0 engine, library and eval; M1 copilot test and demo; sign 3–5 design partners |
| Q1 2027      | M2 integrations, M3 verify flow; partners in shadow mode; SOC 2 Type I kickoff  |
| Q2 2027      | M4 console, enforce mode, M5 help desk; first paid conversions                  |
| Q3–Q4 2027   | M7 accuracy report; SOC 2 Type II window; **Gate 1**                            |
| 2028         | v2 engine and products, GovCloud profile, CMMC L2, FCL sponsorship; **Gate 2**  |
| 2029+        | v3 hardening, FedRAMP/IL5, SBIR/IQT/primes                                      |

---

## M0 status

Built in this repository:

- **Monorepo:** pnpm workspaces, TypeScript strict, vitest, eslint, prettier, and GitHub Actions CI.
- **`packages/tactics`:**
  - 20 seed tactics across 10 families.
  - Manifest with 8 critical combinations.
  - Linter: schema, examples, person labels, regexes, structural feature ids, and version discipline through `library.lock.json`.
- **`packages/llm`:** provider interface, Claude adapter, scripted test provider, cache-stable prompt builder and verbatim-evidence validation.
  - The Claude adapter uses structured output, a cached system prompt and server-side refusal fallback.
- **`packages/engine`:** normalize (.eml parsing included), prefilter, features, rules, LLM merge, decide and explain.
- **`packages/eval`:**
  - 302-item deterministic seed corpus, including a held-out paraphrase slice and 30 injection pairs.
  - Harness with Wilson intervals, per-slice and per-tactic metrics, and a markdown report.
  - CI regression gate.
- **`apps/cli`:** `shield analyze | eval | tactics lint | tactics lock`.
- **Tests:** the roadmap's principles as tests; see `docs/principles.md`.

Deviations from the plan, and why:

- **No turborepo.** pnpm workspaces with source-level imports are enough at this size; add turbo when build caching matters.
- **`packages/db` deferred to M2.** Nothing persists until connectors exist.
- **One LLM pass on `claude-opus-5-5`, not a triage/full-read cascade.** Measure the single model at different effort levels with the eval before adding a cascade. A cascade costs prompt-cache reuse and adds a second failure mode.

## M1 status

Built:

- **`apps/demo`:** a local paste-a-request web app.
  - Server: `node:http` with no extra dependencies, a strict CSP, a 100 KB body limit and an allowlisted static file set. It never logs bodies.
  - Page: evidence highlighting, four examples, light and dark themes, and a phone-width layout.
  - Tests run against a real server on an ephemeral port.
- **`apps/copilot`:** the first-test harness. It reads `copilot-data/*/conversation.txt` and `my-read.md` and asks Claude for a structured read.
  - The read covers goals, leverage, feelings, alternate readings, tactics by each side (self-check), honest pushback and a next message.
  - Tactic claims without a verbatim quote are dropped.
  - Output is a side-by-side report with a scoring table.
  - Principle 6 holds structurally: the output schema has no field for the other person's weak spots. Tests check both the schema and the prompt.

Not yet run: the live Claude eval and the copilot test itself. Both need Anthropic credentials visible in the session.

## M2/M3 core status

Built:

- **`packages/db`:**
  - Postgres schema with row-level security for each tenant, migrations, PGlite for tests and local runs, and retention purge.
  - No person columns (tested).
- **`packages/engine/src/correlate.ts`:** joins messages and approvals into one request.
- **`apps/api`:** the approval gate.
  - Shadow and enforce modes.
  - Verification only through system-of-record contacts.
  - Outcomes as labels, audited overrides, and label export for the eval. See `docs/api.md`.
- **Paid-eval cost controls:** `--estimate` (free), `--max-usd`, `--batch` (half price), `--tags`, and low effort by default. The cheap first look is estimated at about $0.05 on Haiku 5.5.

**M4 console (built):** served by the API at `/console` (see `docs/api.md`).

- Overview with per-workflow pause precision, false-alarm rate and catch rate, each with confidence intervals.
- Catch log and top tactics.
- Request triage with evidence highlighting, verify, override and after-the-fact review.
- Shadow/enforce switching, gated on reviewed false-alarm rates.
- No per-person views.
- `--seed-demo` fills it for partner walk-throughs.

**Pilot-ready (built):**

- Docker Compose with Postgres 16 and `pnpm admin` (tenants, key rotation, vendor-contact CSV
  import). See `docs/pilot.md`.
- A real-Postgres test path, also run in CI.
- The Outlook "Check request" add-in. See `docs/outlook-addin.md`. It has not yet been tested
  inside a real Outlook client.

The paid eval is blocked until 2026-11-01 by the Anthropic account's spending limit (verified with
one request). When it reopens, run the cheap Haiku batch in `docs/eval-methodology.md` (about
$0.05). It was deliberately deferred for budget anyway. Next free steps: native connectors once design partners pick their systems, and the M4 console.

Next:

1. Run `pnpm shield eval --provider anthropic` under zero-data-retention terms. Record the numbers in `docs/eval-methodology.md`, paying particular attention to the paraphrase slice and the two false alarms.
2. Run the copilot first test (M1).
3. Build the paste-a-request demo for design partners.
