#!/bin/bash
# Startet einen frischen lokalen Worker mit leerer Datenbank (Club-Code 1234, Admin-Passwort test-admin-pw).
cd "$(dirname "$0")/.."
pkill -f "[w]rangler dev" 2>/dev/null; sleep 1
rm -rf .wrangler/state
npx wrangler d1 execute n3-spiele --local --file=schema.sql >/dev/null 2>&1
(npx wrangler dev --local --port 8799 > /tmp/wr.log 2>&1 &)
for i in $(seq 1 40); do sleep 2; curl -s -o /dev/null localhost:8799/api/plays && break; done
curl -s -XPUT localhost:8799/api/config/club -H 'x-admin-token: test-admin-pw' -d '{"code":"1234"}' >/dev/null
