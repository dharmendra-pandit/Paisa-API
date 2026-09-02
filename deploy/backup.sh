#!/usr/bin/env bash
#
# Nightly MongoDB backup with rotation.
#
#     bash deploy/backup.sh              # take a backup now
#     bash deploy/backup.sh --restore FILE  # restore from an archive
#
# Install as a cron job (as the deploy user, from the backend directory):
#     crontab -e
#     15 3 * * * cd /home/paisa/paisa && bash deploy/backup.sh >> "$HOME/paisa-backup.log" 2>&1
#
# Self-hosting the database means backups are your responsibility, and an
# untested backup is not a backup. The verification step below reads the archive
# back after writing it, so a silently truncated dump fails loudly tonight
# rather than on the day you need it.

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"
ENV_FILE=".env.production"
BACKUP_DIR="./backups"

[[ -f "$ENV_FILE" ]] || { echo "$ENV_FILE not found" >&2; exit 1; }
# shellcheck disable=SC2046
export $(grep -vE '^\s*#' "$ENV_FILE" | grep -E '^\s*\w+=' | xargs -d '\n')

DB_NAME="${MONGO_DB_NAME:-paisa}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="paisa-${DB_NAME}-${STAMP}.archive.gz"

log() { printf '\033[1;36m[backup %s]\033[0m %s\n' "$(date -Is)" "$*"; }
fail() { printf '\033[1;31m[backup] %s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"

# ---------------------------------------------------------------------------
# Restore mode
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--restore" ]]; then
  SOURCE="${2:-}"
  [[ -n "$SOURCE" ]] || fail "Usage: bash deploy/backup.sh --restore <archive-file>"
  [[ -f "$BACKUP_DIR/$(basename "$SOURCE")" ]] || fail "Archive not found in $BACKUP_DIR"

  echo
  echo "  This REPLACES the contents of database '$DB_NAME' with $(basename "$SOURCE")."
  read -r -p "  Type the database name to confirm: " confirm
  [[ "$confirm" == "$DB_NAME" ]] || fail "Confirmation did not match. Nothing was changed."

  log "Restoring $SOURCE"
  $COMPOSE exec -T mongo mongorestore \
    --username "$MONGO_ROOT_USER" --password "$MONGO_ROOT_PASSWORD" \
    --authenticationDatabase admin \
    --nsInclude "${DB_NAME}.*" \
    --drop --gzip --archive <"$BACKUP_DIR/$(basename "$SOURCE")"

  log "Restore complete — re-syncing indexes"
  $COMPOSE run --rm --no-deps api npm run indexes:sync
  exit 0
fi

# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------
LOCAL_PATH="${BACKUP_DIR}/${ARCHIVE}"

log "Dumping database '$DB_NAME'"

# --archive writes a single stream, which compresses far better than a directory
# of BSON and is atomic to copy off the box.
$COMPOSE exec -T mongo mongodump \
  --username "$MONGO_ROOT_USER" --password "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin \
  --db "$DB_NAME" \
  --gzip --archive \
  --quiet >"$LOCAL_PATH"

[[ -f "$LOCAL_PATH" ]] || fail "Dump reported success but ${ARCHIVE} is missing"

SIZE=$(stat -c '%s' "$LOCAL_PATH")
[[ "$SIZE" -gt 1024 ]] || fail "Backup is only ${SIZE} bytes — almost certainly truncated"

# Verify the archive is readable rather than trusting the exit code. A dump that
# fails mid-stream still leaves a plausible-looking file behind.
log "Verifying archive integrity"
gzip -t "$LOCAL_PATH" 2>/dev/null || fail "Archive failed gzip integrity check"

chmod 600 "$LOCAL_PATH"
log "Wrote ${ARCHIVE} ($(numfmt --to=iec-i --suffix=B "$SIZE" 2>/dev/null || echo "${SIZE}B"))"

# ---------------------------------------------------------------------------
# Rotation
# ---------------------------------------------------------------------------
DELETED=$(find "$BACKUP_DIR" -name 'paisa-*.archive.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)
[[ "$DELETED" -gt 0 ]] && log "Pruned ${DELETED} backup(s) older than ${RETENTION_DAYS} days"

REMAINING=$(find "$BACKUP_DIR" -name 'paisa-*.archive.gz' -type f | wc -l)
log "Done — ${REMAINING} backup(s) retained"

cat <<'OFFSITE'

  Reminder: these backups live on the same VPS as the database they protect.
  A disk failure or a lost server takes both. Copy them somewhere else, e.g.

      rclone copy ./backups remote:paisa-backups --max-age 48h

OFFSITE
