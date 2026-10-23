# AutoSmart: Qiscus to CRM lead integration

When a customer starts a chat with AutoSmart on WhatsApp, Messenger or Instagram, Qiscus sends a New Session webhook. This service turns that webhook into a clean lead in AutoSmart's CRM, without duplicates and without losing leads when the CRM has a bad day.

The repo has three parts:

| Part | Folder | Port | What it does |
| --- | --- | --- | --- |
| Integration middleware | `middleware/` | 3000 | Receives the webhook, maps fields, normalises the phone, prevents duplicates, calls the CRM, retries, keeps a dead letter list |
| Mock AutoSmart CRM | `crm-mock/` | 4000 | Implements `POST /api/leads` from Appendix B, including validation, no duplicate checks, slow answers, 503 and 429 |
| Leads view | `crm-mock/` at `/` | 4000 | A plain HTML page listing every lead, with duplicates and missing phones flagged |

Everything uses Node.js built in modules only. There is nothing to `npm install`.

---

## 1. Run it (about 2 minutes)

You need Node.js 20 or newer (`node -v`).

```bash
git clone https://github.com/ali-tech-dimensions/autosmart-qiscus-crm-integration.git
cd autosmart-qiscus-crm-integration

npm start          # starts the mock CRM on :4000 and the middleware on :3000
```

In a second terminal:

```bash
npm test           # 38 automated tests, about 10 seconds
npm run demo       # curl walkthrough of R1 to R4 against the running services
```

Then open **http://localhost:4000/** to see the leads.

You can also start each service on its own:

```bash
npm run crm          # mock CRM only
npm run middleware   # middleware only
```

### With Docker (bonus B2)

```bash
docker compose up --build
```

This starts the same two services on the same ports, with their data on named volumes. I wrote the compose file in the standard Compose v2 format, but Docker Compose is not installed on the machine I built this on, so I tested everything with plain Node. If it gives you trouble, `npm start` does the same job.

### Send a webhook by hand

```bash
curl -X POST http://localhost:3000/webhooks/qiscus/new-session \
  -H 'Content-Type: application/json' \
  --data @samples/01-whatsapp-text.json
```

The `samples/` folder has seven webhooks: the Appendix A message, an image with a caption, a local Malaysian number, Facebook, Instagram, an ambiguous phone, and a returning customer.

### Configuration

All settings are environment variables. Defaults work for local runs. See `.env.example`.

| Variable | Default | Notes |
| --- | --- | --- |
| `CRM_BASE_URL` | `http://localhost:4000` | |
| `CRM_API_TOKEN` | `dev-crm-token` | Must match the mock CRM |
| `CRM_TIMEOUT_MS` | `12000` | Longer than the CRM's 10 second worst case, see section 3 |
| `MAX_ATTEMPTS` | `5` | Attempts for temporary errors |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | `1000` / `30000` | Exponential backoff with jitter |
| `DEFAULT_COUNTRY` | `MY` | Country used for numbers without a country code (`MY`, `SG` or `ID`) |
| `WEBHOOK_SECRET` | empty | If set, requests must send it in `X-Webhook-Secret` |
| `DATA_DIR` | `./data` | Where the event log and mock CRM data are kept |
| `MOCK_SLOW_MS`, `MOCK_RETRY_AFTER`, `MOCK_RANDOM_FAILURE_RATE` | `10000`, `2`, `0` | Mock CRM behaviour |

### Endpoints

Middleware:

- `POST /webhooks/qiscus/new-session`: the webhook Qiscus calls
- `GET /health`: status and a count of records by state
- `GET /events?status=sent,failed`: every record the service has seen
- `GET /dead-letters`: records that need a person
- `POST /dead-letters/:key/replay`: send a dead letter again (add `?force=true` for timeouts, see below)

Mock CRM:

- `POST /api/leads` and `GET /api/leads` (Appendix B)
- `GET /`: the leads page
- Test helpers, not part of the real API: `X-Mock-Scenario: slow | error | internal | rate_limit` header on a single request, `POST /mock/scenarios` with `{"queue": ["error", "error"]}` to make the next calls fail in order (useful because the middleware, not you, makes the CRM call), `GET /mock/stats`, `DELETE /api/leads` to reset.

---

## 2. How a webhook becomes a lead

```
Qiscus ──webhook──▶ middleware ──202 in a few ms──▶ Qiscus
                        │
                        ├─ check shape, secret
                        ├─ duplicate? (room ID + first message ID) ──▶ 200 "duplicate_ignored"
                        ├─ map fields, normalise phone
                        ├─ phone unusable on WhatsApp? ──▶ held for review
                        └─ save as pending ──▶ background worker ──▶ POST /api/leads
                                                   │
                                   201 ─▶ sent    429/5xx/unreachable ─▶ retry with backoff ─▶ failed (dead letter)
                                   400/401 ─▶ failed, no retry    timeout ─▶ unknown_outcome (dead letter)
```

### Field mapping (R1)

| CRM field | Taken from | Notes |
| --- | --- | --- |
| `full_name` | `payload.from.name`, then `room.name`, then `room_log.name` | Trimmed to 100 characters, "Unknown customer" if all are empty |
| `phone` | `payload.from.email`, then `room_log.user_id` | WhatsApp only. For Facebook and Instagram this field holds a platform ID, so it is not sent |
| `source` | `room_log.source`, then the parsed `room.options` string | `wa` to `whatsapp`, `fb` to `facebook`, `ig` to `instagram`, anything else to `other` (logged) |
| `first_message` | `payload.message` | Text as is. For attachments: the caption plus the link, or `[type] link` when there is no caption. Trimmed to 1,000 characters |
| `external_ref` | `payload.room.id_str` | The Qiscus room, so sales can find the chat |
| `created_at` | `message.timestamp`, then `room_log.created_at` | |

### Phone normalisation (R2)

`middleware/src/phone.js` handles the three markets with a small rule table: country code, then length and leading digit of the national number. All eight valid examples in Appendix C pass (see `test/phone.test.js`).

- `+` or `00` in front: matched against Malaysia, Singapore and Indonesia. Other valid looking international numbers are passed on as they are.
- Leading `0`: a local number in the default country (Malaysia unless `DEFAULT_COUNTRY` says otherwise).
- No prefix: first tried as a number that already has a country code (how WhatsApp sends them), then as a local number missing its `0`.
- **`0812 0000 0009`** is local format but not a valid Malaysian number. It looks like an Indonesian mobile. I chose **not to guess**: the lead is held for review with a hint (`+6281200000009 (Indonesia)`). A wrong guess sends a salesperson to a stranger.
- **`12345`** is invalid and handled the same way.

I used a short rule table rather than libphonenumber to keep the project dependency free and easy to read for three countries. In production I would switch to libphonenumber.

---

## 3. Design decisions and assumptions

### No duplicate leads (R3)

Every webhook gets a key: `qiscus:<room id>:<first message id>`. A redelivery of the same webhook has the same body, so the same key. The first time a key is seen it is saved before anything else happens. Any later delivery with that key gets `200 duplicate_ignored`, including one that arrives while the first is still being sent. If the room or message ID is ever missing, the key falls back to a hash of the raw body, which still catches exact redeliveries.

The harder case is the CRM itself. Appendix B says a slow CRM still creates the lead after the caller stops waiting, and it has no duplicate check. So a timeout does not tell us whether the lead exists. If the service retried after a timeout, it could create the lead twice. That is the most likely way to create a duplicate, so I handled it this way:

- The CRM timeout is 12 seconds, longer than the CRM's documented 10 second worst case. We can afford that because Qiscus has already had its answer.
- If the timeout still happens, the record is parked as `unknown_outcome` instead of retried. A person checks the CRM for the room ID and replays it with `?force=true` only if the lead is not there.
- Errors that mean the lead was **not** created (429, 5xx, connection refused) are retried automatically.

### Resilient error handling (R4)

- Qiscus gets a `202` within milliseconds. The CRM call happens in the background, so a slow CRM never makes Qiscus wait past its 5 second limit.
- Temporary errors are retried with exponential backoff and jitter, and a `Retry-After` header is respected. After `MAX_ATTEMPTS` the record moves to the dead letters with the last error (bonus B1).
- `400` and `401` are not retried, because sending the same thing again will not fix them. They go straight to the dead letters with the CRM's error body, so the cause is obvious.
- Every request handler has a catch, and the process logs unhandled errors instead of exiting. Bad JSON, unknown webhook types and oversized bodies get a clear `400` or `413`.
- Records are written to `data/middleware-events.json` before the reply goes to Qiscus. If the service restarts, it picks up anything still `pending` or `retrying`.
- Logs are one JSON object per line, so they are easy to search and ship.

### Answers to the open questions (section 3.3)

**A returning customer starts a new session weeks later. New lead or not?**
New lead. In a car dealership a new conversation weeks later usually means new interest: another model, a trade in, a service booking. If we merged it into an old lead, a salesperson could miss a hot prospect sitting on a closed record. The new lead has the same phone, so it is easy to connect, and the leads view shows it with a "phone seen before" flag. This is a business rule, though, and I would confirm it with AutoSmart's sales manager in the first week. If they prefer updates, the change is small, but it needs a CRM search or update endpoint, which Appendix B does not have.

**What happens to a lead whose phone number cannot be normalised?**
For WhatsApp the CRM requires a phone, so the lead cannot be created yet. It is held as `needs_review` with the raw value, the reason and a hint, visible at `/dead-letters`. It is not dropped, and it is not sent with a made up number. In a live setup the alert would go to the branch team, who can confirm the number in the chat. For Facebook and Instagram a phone is optional, so those leads are created without one and flagged on the leads page.

**What does the service return to Qiscus when the CRM is down?**
`202 Accepted`, as soon as the webhook is safely saved. Returning an error would make Qiscus resend the webhook (per the delivery assumption), which adds load and risk without helping, because we already have the data. Our own retry queue is the right place to wait out the outage. The service only returns errors when the problem is with the request itself (bad JSON, wrong secret).

### Other assumptions

- **Delivery assumption.** The brief says Qiscus may resend a webhook when it gets no 2xx in 5 seconds. I designed for it rather than relying on it. To verify it with the platform team I would ask how retries work (how many, how far apart, same body), then test in a Qiscus staging account: point the webhook at an endpoint that sleeps 6 seconds and count the deliveries.
- **Webhook security.** I did not find a signature scheme for this webhook in the public docs, so there is an optional shared secret in a header. In production I would confirm what Qiscus offers (signature, fixed IP ranges) and use that.
- **Storage.** A JSON file is enough for one instance and makes the state easy to inspect. It is not safe for several instances at once. See "What I would improve".
- **Phone on Facebook and Instagram.** Never taken from the `email` field. The bot in Part 1 asks for a number, and a later version could add it to the lead.

---

## 4. Proof it works (R5)

`npm test` runs 38 tests with Node's built in test runner:

- `test/phone.test.js`: every Appendix C example, the ambiguous and invalid cases, configurable default country.
- `test/mapping.test.js`: field mapping for text, image with caption, attachment without caption, Facebook, Instagram, unknown channels, length limits, keys.
- `test/integration.test.js`: real HTTP between the middleware and the mock CRM:
  - same webhook twice gives one lead, including a redelivery while the CRM is still busy
  - two 503s then success, created once on the third attempt
  - 429 with `Retry-After` is honoured
  - a slow CRM does not delay the reply to Qiscus
  - a CRM that answers after our timeout leaves one lead and a parked record, not two leads
  - CRM unreachable: the service stays up, retries, then parks the record
  - wrong token is not retried
  - unusable phone is held for review
  - returning customer creates a second lead
  - bad JSON does not crash anything
  - a dead letter can be replayed
  - the optional secret blocks unsigned calls

`npm run demo` does the same story with curl against the running services and prints the CRM's leads after each step.

---

## 5. What I would improve with more time

1. **Storage and scale.** Move the event log to Postgres or Redis with a unique key on the webhook key, and the retry queue to a proper job queue. Then several instances can run behind a load balancer.
2. **Lead updates.** Agree the returning customer rule with sales, and if they want updates, ask AutoSmart's CRM team for a search by phone or `external_ref`.
3. **Write back to Qiscus.** Store the CRM lead ID on the Qiscus customer (if the API allows it), so agents see it next to the chat.
4. **Alerts.** Send an email or Slack message when dead letters pile up or the CRM fails several times in a row. Today it is only in the logs and at `/dead-letters`.
5. **Admin page.** A small page to fix a phone number and replay a held lead, instead of using curl.
6. **libphonenumber** for wider phone coverage.
7. **Metrics** for lead capture rate and CRM latency, which feed the success metrics in the Part 1 proposal.

A one page guide for AutoSmart's IT team is in [`docs/INTEGRATION_GUIDE.md`](docs/INTEGRATION_GUIDE.md) (bonus B3).

### Bonus tasks I chose

- **B1, retry and dead letter:** the CRM in this brief is known to be unreliable, so without it the integration would lose leads, which is the exact problem AutoSmart came with.
- **B2, one command setup:** reviewers should not have to start things by hand. `npm start` covers it too.
- **B3, client guide:** as a TAM, the thing I actually hand the client's IT team is a guide, not a repo.

---

## 6. How I used AI

I used **Claude (in Claude Code)** throughout, as a pair programmer. I set the design: one key per session, answer Qiscus first and call the CRM in the background, and no automatic retry after a timeout. I also set the rules for ambiguous phones and the three open questions. Claude wrote most of the first drafts of the code, tests and this README. I then ran everything, read the output and corrected what was wrong. I also used it to read the brief closely and to check my Part 1 proposal against the Qiscus documentation.

Prompts that helped most:

1. *"Read Appendix B again. The CRM creates the lead even if the caller stops waiting, and it has no duplicate check. Which of our retry cases can create a second lead? Write a test that proves we don't."* This led to the `unknown_outcome` state and the test where the CRM answers after our timeout.
2. *"Here is the Appendix C table. Write the phone tests first, one per row, plus 0812 0000 0009 and 12345. Then write the normaliser until they pass. Do not guess the ambiguous one."*
3. *"Make the mock CRM fail on demand. The middleware makes the call, not the test, so a request header is not enough. Add a queue of scenarios."* This is where `POST /mock/scenarios` came from.

Things the AI got wrong, and how I caught them:

- **The test command did not run.** The first `npm test` script was `node --test test/`. On Node 26 that fails with "Cannot find module .../test", because the runner wanted files, not a folder. I saw it on the first run and changed it to `node --test test/*.test.js`.
- **The leads page called a returning customer a duplicate.** The first version flagged any two leads with the same Qiscus room ID in red. When I ran the demo, Aisyah's second session weeks later showed up as a duplicate, which contradicts my own decision in section 3. Duplicates are now "same room and same first contact time" (red). "Same phone" is shown separately in amber, as worth a look.

Everything here I can walk through line by line in the interview.
