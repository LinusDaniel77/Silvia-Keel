# API (M2/M3 core)

The backend that customer systems plug into: an AP or help-desk system asks before releasing a
payment, a vendor bank change or an account reset, and gets a verdict. Email and chat connectors
feed it the messages behind the request.

```sh
pnpm api                      # in-memory Postgres (PGlite) with a demo tenant; prints an API key
DATABASE_URL=postgres://… pnpm api   # real Postgres; migrations run on start
```

All `/v1` routes need `Authorization: Bearer <api key>`. Keys are stored as SHA-256 hashes. Routes
that record a human decision also need `x-shield-actor: <opaque id>`, which goes only into the audit
trail.

| Route                                 | What it does                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/artifacts`                  | Ingests one message: `{ rawEmail }` (RFC 822) or `{ artifact: { channel, sender, subject, body, … } }`, plus optional `correlation: { objectIds, claimedRequester, actionKind }`. Returns `{ requestId, artifactId, correlatedBy }`.                                                                       |
| `POST /v1/approvals/check`            | **The gate.** `{ action: { kind, amount?, currency? }, objectIds, subject: { type: vendor\|role, id, name? }, claimedRequester?, artifacts? }`. Joins the request's messages, analyzes them, records the analysis, and returns `{ decision, hold, wouldHold, mode, explanations, tactics, verification }`. |
| `POST /v1/verifications/:id/complete` | `{ outcome: legitimate\|attack\|inconclusive, channelUsed }`. Releases, blocks or keeps holding the request.                                                                                                                                                                                               |
| `POST /v1/verifications/:id/override` | `{ reason }` (at least 10 characters). Releases the request and writes an audit event.                                                                                                                                                                                                                     |
| `PUT /v1/known-contacts`              | `{ source, contacts: [{ subjectType, subjectId, channel: phone\|email, value }] }`. Sync from the vendor master or HR directory.                                                                                                                                                                           |
| `PUT /v1/workflows/:actionKind`       | `{ mode: shadow\|enforce }`. Audited.                                                                                                                                                                                                                                                                      |
| `GET /v1/requests/:id`                | The request with its messages (purged bodies flagged), analyses and verifications.                                                                                                                                                                                                                         |
| `GET /v1/labels/export`               | Verified requests as eval-corpus JSONL (`source: partner`).                                                                                                                                                                                                                                                |

## How a check works

1. **Correlate.** The approval is joined to the open request it belongs to, using the rules in
   `packages/engine/src/correlate.ts`:
   - a shared object id within 14 days;
   - an id written in the other side's text (an approval for `INV-4471` finds the email that
     mentions it);
   - the same claimed requester asking for the same action within 48 hours.
2. **Analyze** every message the request has, with the tenant's own domains and the vendor's
   known email domains as context.
3. **Mode.** Every workflow starts in **shadow**: nothing is held, and the would-be decision is
   recorded so false-alarm rates can be measured before anyone is interrupted. In **enforce**, a
   PAUSE holds the request (`hold: true`).
4. **Verify.** A held request gets a callback script built **only** from `known_contacts`, the
   system of record. A phone number is preferred, because it is a different channel from the request.
   - Contact details inside the request are never used.
   - With no contact on file, the verification is `needs_contact`; nothing is invented.
5. **Label.** The verification outcome is the ground-truth label for the eval: the flywheel.

## Tenancy and data

- **Isolation.** Every tenant table has Postgres row-level security. Request handling runs inside
  `withTenant()` (`packages/db/src/db.ts`) as role `shield_app` with `app.tenant_id` set, so a
  query cannot read or write another tenant's rows. The connecting owner role does
  administration only: tenant creation, key lookup and the retention purge.
- **No people in the schema.** There is no recipient, employee or per-person score column. The
  single person reference is `audit_events.actor_ref`. The test is in
  `packages/db/test/schema.test.ts`.
- **Retention.** Bodies older than the tenant's `retention_days` (default 30) are nulled hourly.
  The body's hash, the analysis and its evidence quotes, and the verification outcome remain.
- **LLM off by default.** The server only calls Claude with `SHIELD_LLM=on` and credentials
  present.

## Not yet

- SSO and RBAC (M6).
- Native connectors: Microsoft 365, Slack, Teams, and the AP and help-desk systems (M2, chosen by
  design partners).
- An async queue for slow LLM calls.
- The web console (M4).
