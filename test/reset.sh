#!/bin/bash
# Startet einen frischen lokalen Worker mit leerer Datenbank (Admin-Passwort test-admin-pw).
cd "$(dirname "$0")/.."
pkill -f "[w]rangler dev" 2>/dev/null; sleep 1
rm -rf .wrangler/state
npx wrangler d1 execute n3-spiele --local --file=schema.sql >/dev/null 2>&1
(npx wrangler dev --local --test-scheduled --port 8799 > /tmp/wr.log 2>&1 &)
for i in $(seq 1 40); do sleep 2; curl -s -o /dev/null localhost:8799/api/plays && break; done
