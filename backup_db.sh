#!/bin/bash
# Automated backup of tracking_5.7 db/*.json
# Does NOT touch Downloads, add.js, or the running Node process.
# Safe for remote Full Connection clients on :3000 — no firewall/service changes.

set -euo pipefail

DB_DIR="/root/ssl/tracking_5.7/db"
BACKUP_ROOT="/root/ssl/backups_tracking/db"
LOG="/root/ssl/backups_tracking/db_backup.log"
KEEP_COUNT=48
# 48 hourly backups ~= 2 days of history

mkdir -p "$BACKUP_ROOT"
STAMP=$(date +%Y%m%d_%H%M%S)
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"

{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting db backup -> $DEST"
  if [ ! -d "$DB_DIR" ]; then
    echo "ERROR: DB dir missing: $DB_DIR"
    exit 1
  fi

  for f in "$DB_DIR"/*.json; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    ok=0
    for i in 1 2 3 4 5; do
      if cp -a "$f" "$DEST/$base"; then
        ok=1
        break
      fi
      sleep 0.2
    done
    if [ "$ok" -ne 1 ]; then
      echo "ERROR: failed to copy $base"
      exit 1
    fi
    bytes=$(wc -c < "$DEST/$base" | tr -d ' ')
    echo "  copied $base ($bytes bytes)"
  done

  ls -lah "$DEST" > "$DEST/MANIFEST.txt"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup OK: $DEST"

  mapfile -t ALL < <(ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null || true)
  COUNT=${#ALL[@]}
  if [ "$COUNT" -gt "$KEEP_COUNT" ]; then
    for old in "${ALL[@]:$KEEP_COUNT}"; do
      rm -rf "$old"
      echo "  rotated out: $old"
    done
  fi
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Retention: keep <= $KEEP_COUNT snapshots (count before rotate=$COUNT)"
} >> "$LOG" 2>&1
