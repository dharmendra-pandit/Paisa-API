#!/usr/bin/env bash
#
# Uploads the backend to the VPS over SSH.
#
#     bash deploy/upload.sh paisa@203.0.113.10
#     bash deploy/upload.sh root@203.0.113.10 --path /root/paisa
#
# Run from the `backend` directory on your own machine (Git Bash on Windows is
# fine — it has ssh, scp and tar).
#
# Why a tarball rather than rsync or git: rsync is not installed on a stock
# Windows Git Bash, and the source tree is ~1MB without node_modules, so a
# single compressed transfer is faster than anything incremental would be.
#
# What is deliberately NOT uploaded:
#   - node_modules   rebuilt on the server by `npm ci` inside the Docker build,
#                    because native modules compiled on Windows will not run on
#                    Linux
#   - .env           your LOCAL development secrets. Production secrets live
#                    only on the server, in .env.production, and are never
#                    copied from a developer machine
#   - backups/       database dumps, which do not belong in a code upload
#
# The upload never touches .env.production on the server, so re-uploading new
# code will not clobber the secrets you configured there.

set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-}"
REMOTE_PATH="/home/\$USER/paisa/backend"

if [[ -z "$TARGET" ]]; then
  cat >&2 <<USAGE
Usage: bash deploy/upload.sh <user@host> [--path <remote-dir>] [--port <ssh-port>]

Examples:
  bash deploy/upload.sh paisa@203.0.113.10
  bash deploy/upload.sh root@203.0.113.10 --path /root/paisa/backend
USAGE
  exit 1
fi

shift
SSH_PORT=22
while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) REMOTE_PATH="$2"; shift 2 ;;
    --port) SSH_PORT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

ARCHIVE="paisa-backend-$(date +%Y%m%d-%H%M%S).tar.gz"
TMP="${TMPDIR:-/tmp}/$ARCHIVE"

log "Packing the backend (excluding node_modules, secrets and backups)"
tar -czf "$TMP" \
  --exclude='./node_modules' \
  --exclude='./.env' \
  --exclude='./.env.local' \
  --exclude='./.env.production' \
  --exclude='./backups' \
  --exclude='./coverage' \
  --exclude='./.git' \
  --exclude='*.tar.gz' \
  .

SIZE=$(du -h "$TMP" | cut -f1)
echo "    $ARCHIVE ($SIZE)"

# Sanity check: refuse to ship an archive that somehow contains a secrets file.
if tar -tzf "$TMP" | grep -qE '(^|/)\.env$|(^|/)\.env\.production$'; then
  echo "REFUSING TO UPLOAD: the archive contains a .env file" >&2
  rm -f "$TMP"
  exit 1
fi

log "Copying to $TARGET:$REMOTE_PATH"
# shellcheck disable=SC2029  # remote expansion of $USER is intentional
ssh -p "$SSH_PORT" "$TARGET" "mkdir -p $REMOTE_PATH"
scp -P "$SSH_PORT" "$TMP" "$TARGET:/tmp/$ARCHIVE"

log "Extracting on the server"
# shellcheck disable=SC2029
ssh -p "$SSH_PORT" "$TARGET" "
  set -e
  cd $REMOTE_PATH
  tar -xzf /tmp/$ARCHIVE
  rm -f /tmp/$ARCHIVE
  chmod +x deploy/*.sh
  # Line endings: a file edited on Windows arrives with CRLF, and bash fails on
  # the shebang with a confusing 'bad interpreter' error.
  sed -i 's/\r$//' deploy/*.sh 2>/dev/null || true
  echo \"    extracted into \$(pwd)\"
  if [ -f .env.production ]; then
    echo '    .env.production already present — left untouched'
  else
    echo '    NOTE: .env.production not found. Create it before deploying.'
  fi
"

rm -f "$TMP"

log "Upload complete"
cat <<NEXT

On the server:

    ssh $TARGET
    cd $REMOTE_PATH

    # first time only:
    cp .env.production.example .env.production
    chmod 600 .env.production
    nano .env.production          # fill in DOMAIN, ACME_EMAIL and every secret

    bash deploy/deploy.sh

NEXT
