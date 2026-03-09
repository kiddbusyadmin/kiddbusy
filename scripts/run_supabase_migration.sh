#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <migration.sql>"
  exit 1
fi

MIGRATION_FILE="$1"
if [[ ! -f "$MIGRATION_FILE" ]]; then
  echo "Migration file not found: $MIGRATION_FILE"
  exit 1
fi

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "Missing SUPABASE_ACCESS_TOKEN"
  exit 1
fi

PROJECT_REF="${SUPABASE_PROJECT_REF:-}"
if [[ -z "$PROJECT_REF" ]]; then
  if [[ -n "${SUPABASE_URL:-}" ]]; then
    PROJECT_REF="$(echo "$SUPABASE_URL" | sed -E 's#https://([^.]+)\.supabase\.co#\1#')"
  fi
fi
if [[ -z "$PROJECT_REF" ]]; then
  echo "Missing SUPABASE_PROJECT_REF (or SUPABASE_URL)"
  exit 1
fi

JSON_PAYLOAD="$(python3 - "$MIGRATION_FILE" <<'PY'
import json, sys, pathlib
path = pathlib.Path(sys.argv[1])
sql = path.read_text(encoding='utf-8')
print(json.dumps({"query": sql, "read_only": False}))
PY
)"

RESP_FILE="/tmp/supabase_migration_resp_$(date +%s).json"
HTTP_CODE="$(curl -sS -o "$RESP_FILE" -w "%{http_code}" \
  -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$JSON_PAYLOAD")"

if [[ "$HTTP_CODE" != "201" && "$HTTP_CODE" != "200" ]]; then
  echo "Migration failed (HTTP $HTTP_CODE):"
  cat "$RESP_FILE"
  exit 1
fi

echo "Migration applied: $MIGRATION_FILE"
cat "$RESP_FILE"
