# Running a shadow-mode pilot

How a design partner runs Manipulation Shield on its own infrastructure for 2–4 weeks in
**shadow mode**: every high-risk request is checked and recorded, nothing is held, and the
security team reviews what _would_ have been paused. Enforcement comes only after the reviewed
false-alarm rate is acceptable.

## What you need

- A Linux host with Docker and Docker Compose. 2 vCPU, 4 GB RAM and 20 GB disk are plenty for a pilot.
- A TLS-terminating reverse proxy in front of it (nginx, Caddy, your load balancer). The stack
  publishes port 4180 on `127.0.0.1` only.
- An export of vendor contacts from your vendor master (NetSuite, SAP, Coupa…): the phone numbers
  and emails your AP team already trusts.
- Someone in AP or IT who can call the gate before releasing a payment or a bank-detail change.
  Until a native connector exists, that call comes from a script or workflow step, or from the
  console by hand.

## 1. Start it

```sh
cp .env.example .env        # set POSTGRES_PASSWORD and SHIELD_DB_PASSWORD
docker compose up -d --build
docker compose logs api     # "Manipulation Shield API on http://0.0.0.0:4180 (LLM off: rules only)"
```

On first start, Postgres creates a non-superuser `shield_owner` and the `shield` database. The API
then runs the migrations, which create the restricted `shield_app` role that every tenant request
runs under. Row-level security confines that role to one tenant's rows.

## 2. Create your tenant and import contacts

```sh
docker compose run --rm api pnpm admin create-tenant --name "Acme" --org-domain acme.com
# tenant: 6f1c…   api key (shown once): shk_…

docker compose run --rm -v "$PWD/contacts.csv:/tmp/contacts.csv:ro" api \
  pnpm admin import-contacts --tenant 6f1c… --source "NetSuite vendor master" /tmp/contacts.csv
```

`contacts.csv` needs this header row, then one row per contact:

```
subject_type,subject_id,channel,value
vendor,V-ATLAS-01,phone,+1 206 555 0100
vendor,V-ATLAS-01,email,ap@atlasfreight.com
role,cfo,phone,+1 206 555 0199
```

Re-import whenever the vendor master changes; existing rows are updated. To rotate the API key:
`pnpm admin rotate-key --tenant <id>`. The new key is printed once and all older keys stop working.

## 3. Send requests

Before an approval goes through, call the gate. Attach the messages behind it inline, or send
them earlier through `POST /v1/artifacts`.

```sh
curl -s https://shield.internal/v1/approvals/check \
  -H "authorization: Bearer $SHIELD_KEY" -H 'content-type: application/json' \
  -d '{
    "action": { "kind": "vendor_bank_change" },
    "objectIds": ["V-ATLAS-01", "INV-4471"],
    "subject": { "type": "vendor", "id": "V-ATLAS-01", "name": "Atlas Freight" },
    "artifacts": [{ "rawEmail": "<the raw .eml text>" }]
  }'
```

In shadow mode the response always has `"hold": false`, and `"wouldHold"` tells you what
enforcement would have done. See [`api.md`](api.md) for every route.

## 4. Review in the console

Open `https://shield.internal/console`. Sign in with the API key and your id for the audit trail.

- Each week, label the requests that paused or warned as **legitimate** or **attack**, plus a
  sample of the rest. Those labels are what make the false-alarm rate real.
- **Overview** shows, per workflow, how many pauses were attacks, how many legitimate requests
  were paused, and what was caught, each with a confidence interval.
- **Switch to enforce** (Workflows) once at least 20 requests are labelled and the false-alarm rate
  is acceptable to the finance team. From then on, a paused request is held until someone calls
  the contact on file. The callback script never uses contact details from the message.

## Data handling during the pilot

- **Message bodies** are deleted after 30 days (`retention_days` per tenant). Hashes, analyses with
  their evidence quotes, and verification outcomes remain.
- **No people in the data.** No employee or recipient data is stored or scored. The only person
  reference is the id of whoever verified, reviewed or overrode something, kept in the audit trail.
- **The Claude classifier is off.** If you turn it on (`SHIELD_LLM=on` plus a key), message text is
  sent to Anthropic. Only do that under a zero-data-retention agreement
  ([`data-handling.md`](data-handling.md)).
- **Backups** are the Postgres volume `pgdata`; back it up like any other finance-adjacent database.

## Known limits of the pilot build

- **Authentication.** Sign-in uses an API key. SSO and role-based access come in M6.
- **Connectors.** There are no native connectors yet for Microsoft 365, Slack, Teams, or AP and
  help-desk systems. Calls come from your scripts or workflow tools.
- **Detection is rules only.** The rules are precise on known phrasings but miss reworded attacks.
  The shadow-mode review is exactly how that shows up in your own traffic before anything is
  enforced.
