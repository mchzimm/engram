#!/usr/bin/env bash
set -o pipefail
DB="$HOME/.engramx/memory.db"
CLI="node dist/cli.js"

if [ ! -f "$DB" ]; then
  echo "[batch-init] DB not found: $DB" >&2
  exit 1
fi

echo "[batch-init] Using DB: $DB"

# For each project entry (project:<id>:project_root) run incremental init if last_mined missing/zero
sqlite3 -separator $'\t' "$DB" "SELECT substr(key, length('project:')+1, instr(key, ':project_root') - (length('project:')+1)) AS id, value FROM stats WHERE key LIKE 'project:%:project_root';" | while IFS=$'\t' read -r id root; do
  if [ -z "$id" ] || [ -z "$root" ]; then
    echo "[batch-init] skipping invalid entry: id='$id' root='$root'"
    continue
  fi
  # Check last_mined
  last=$(sqlite3 "$DB" "SELECT value FROM stats WHERE key='project:${id}:last_mined' LIMIT 1;")
  if [ -z "$last" ] || [ "$last" = "0" ]; then
    echo "[batch-init] INIT needed for project: $root (id: $id)"
    echo "[batch-init] Running: $CLI init \"$root\" --incremental"
    # Run init; allow failure but continue
    if $CLI init "$root" --incremental; then
      echo "[batch-init] init completed for $root"
    else
      echo "[batch-init] init FAILED for $root" >&2
    fi
  else
    echo "[batch-init] Skipping $root (last_mined=$last)"
  fi
done

echo "[batch-init] Done"
