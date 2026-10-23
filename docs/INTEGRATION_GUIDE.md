# AutoSmart integration guide (for the IT team)

**What it does.** Every time a customer starts a new chat on WhatsApp, Facebook Messenger or Instagram, Qiscus tells our integration service. The service creates a lead in your CRM with the customer's name, phone number (WhatsApp), channel, first message and the Qiscus chat reference. Nobody needs to type leads in by hand any more.

**How it works, in one line.** Qiscus calls the service, the service answers within a second, then sends the lead to your CRM in the background. If the CRM is busy or down, it waits and tries again. If it still cannot, the lead is kept safely for someone to check.

## What we need from you

| Item | Why |
| --- | --- |
| CRM API base URL and an API token (production and a test environment) | So the service can create leads |
| Your CRM's rate limit, if any | So we do not send faster than it accepts |
| A server or container to run the service (or approval for Qiscus to host it) | Any machine that can run Docker or Node.js 20 |
| An outbound route from that server to the CRM | The service calls `POST /api/leads` |
| An inbound HTTPS address for the service | Qiscus calls it when a chat starts |
| An email address for alerts | Someone who can check failed leads, usually the CRM admin |

## Settings you will see

`CRM_BASE_URL`, `CRM_API_TOKEN`, `DEFAULT_COUNTRY` (MY), `WEBHOOK_SECRET` (shared with Qiscus). Keep the token and secret in your secrets store, not in code.

## Everyday checks

- **Is it running?** Open `/health`. It shows `ok` and how many leads were sent, are retrying or failed.
- **Anything stuck?** Open `/dead-letters`. Each entry says why it is there.

## Common issues

| You see | What it means | What to do |
| --- | --- | --- |
| `failed` with "CRM rejected the lead (401)" | The API token is wrong or expired | Update `CRM_API_TOKEN`, then replay the entry |
| `failed` with "CRM rejected the lead (400)" | The CRM refused a field | Read the error detail; usually a rule change in the CRM |
| `failed` with "gave up after 5 attempts" | The CRM was down longer than our retries | When the CRM is back, replay: `POST /dead-letters/<key>/replay` |
| `unknown_outcome` | The CRM did not answer in time; it may still have created the lead | Search the CRM for the Qiscus room ID first. Replay with `?force=true` only if the lead is not there |
| `needs_review` with `invalid_phone` | The WhatsApp number could not be read reliably (for example `0812 0000 0009`) | Confirm the number with the customer in the chat; the entry shows a suggested format |
| Leads arrive with no phone | They came from Facebook or Instagram, which do not share phone numbers | Expected. The chatbot asks for a number |
| Nothing arrives at all | Qiscus cannot reach the service, or the secret does not match | Check the service logs for "wrong or missing secret" and the inbound address |

## Who to contact

Qiscus Technical Account Manager for platform or webhook questions; your CRM admin for CRM errors.
