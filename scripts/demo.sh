#!/usr/bin/env bash
# Walks through R1 to R4 with curl against running services.
# Start everything first (npm start, or docker compose up), then run: npm run demo

set -u
MW="${MIDDLEWARE_URL:-http://localhost:3000}"
CRM="${CRM_URL:-http://localhost:4000}"
TOKEN="${CRM_API_TOKEN:-dev-crm-token}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
S="$HERE/samples"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
send() { curl -s -o /dev/stderr -w "  http %{http_code} in %{time_total}s\n" -X POST "$MW/webhooks/qiscus/new-session" -H 'Content-Type: application/json' --data @"$S/$1" 2>&1; echo; }
leads() { curl -s "$CRM/api/leads" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const l=JSON.parse(d);console.log(`  CRM now has ${l.length} lead(s)`);for(const x of l)console.log(`   ${x.id}  ${x.source.padEnd(9)} ${String(x.phone||"(no phone)").padEnd(15)} ${x.full_name}`)})'; }
queue() { curl -s -X POST "$CRM/mock/scenarios" -H 'Content-Type: application/json' -d "{\"queue\":[$1]}" > /dev/null; }

curl -sf "$MW/health" > /dev/null || { echo "Middleware is not reachable at $MW. Start it with: npm start"; exit 1; }
curl -sf "$CRM/api/leads" > /dev/null || { echo "Mock CRM is not reachable at $CRM. Start it with: npm start"; exit 1; }

bold "0. Clearing the mock CRM"
curl -s -X DELETE "$CRM/api/leads" > /dev/null && echo "  done"

bold "1. WhatsApp text message (Appendix A sample)"
send 01-whatsapp-text.json
sleep 1; leads

bold "2. Qiscus sends the exact same webhook again (R3)"
send 01-whatsapp-text.json
sleep 1; leads

bold "3. First message is an image with a caption, Singapore number (R1, R2)"
send 02-whatsapp-image-caption.json

bold "4. Facebook Messenger and Instagram (no phone, platform ID only)"
send 04-facebook.json
send 05-instagram.json
sleep 1; leads

bold "5. WhatsApp number we cannot trust: 0812 0000 0009 (held for review, not sent)"
send 06-whatsapp-ambiguous-phone.json

bold "6. CRM returns 503 twice, then recovers (R4 retry)"
queue '"error","error"'
send 03-whatsapp-local-number.json
echo "  waiting for retries..."; sleep 5; leads

bold "7. CRM rate limits us with 429 and Retry-After"
queue '"rate_limit"'
send 07-returning-customer-new-session.json
echo "  waiting for Retry-After..."; sleep 5; leads

bold "8. Slow CRM: Qiscus still gets an answer straight away"
queue '"slow"'
cp "$S/01-whatsapp-text.json" /tmp/autosmart-slow.json
sed -i.bak -e 's/550001001/550001999/g' -e 's/70004321/70004399/g' -e 's/Aisyah Rahman/Farah Lim/g' /tmp/autosmart-slow.json
curl -s -o /dev/null -w "  middleware answered Qiscus in %{time_total}s\n" -X POST "$MW/webhooks/qiscus/new-session" -H 'Content-Type: application/json' --data @/tmp/autosmart-slow.json
echo "  the CRM takes about 10 seconds; waiting..."; sleep 12; leads

bold "9. Records that need a person (dead letters)"
curl -s "$MW/dead-letters" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const l=JSON.parse(d);if(!l.length)console.log("  none");for(const x of l)console.log(`  ${x.status.padEnd(16)} ${x.key}  ${x.lastError}`)})'

bold "Done. Open $CRM/ to see the leads page."
