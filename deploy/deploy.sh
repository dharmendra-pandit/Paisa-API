#!/usr/bin/env bash
#
# Deploys (or redeploys) Paisa on the VPS.
#
#     bash deploy/deploy.sh            # build, migrate indexes, restart
#     bash deploy/deploy.sh --pull     # git pull first
#     bash deploy/deploy.sh --no-build # restart without rebuilding the image
#
# Run from the `backend` directory. Safe to run repeatedly.
#
# The ordering here is the important part: the database comes up first and is
# waited for, indexes are synced BEFORE the new API starts serving, and the old
# container is only replaced once the new image builds cleanly. A failed build
# leaves the running site untouched.

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yml"
ENV_FILE=".env.production"
DO_PULL=false
DO_BUILD=true

for arg in "$@"; do
  case "$arg" in
    --pull) DO_PULL=true ;;
    --no-build) DO_BUILD=false ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preflight — fail before touching anything running
# ---------------------------------------------------------------------------
[[ -f "$ENV_FILE" ]] || fail "$ENV_FILE not found. Copy .env.production.example and fill it in."

# Refuse to deploy with placeholder secrets still in place. This check exists
# because "I'll change it later" is how CHANGE_ME ends up in production.
if grep -q 'CHANGE_ME' "$ENV_FILE"; then
  fail "$ENV_FILE still contains CHANGE_ME placeholders. Replace every secret before deploying."
fi

# shellcheck disable=SC2046
export $(grep -vE '^\s*#' "$ENV_FILE" | grep -E '^\s*\w+=' | xargs -d '\n')

[[ -n "${DOMAIN:-}" ]] || fail "DOMAIN is not set in $ENV_FILE"
[[ "${DOMAIN}" != "api.yourdomain.com" ]] || fail "DOMAIN is still the example value"

perms=$(stat -c '%a' "$ENV_FILE")
if [[ "$perms" != "600" ]]; then
  log "Tightening permissions on $ENV_FILE (was $perms)"
  chmod 600 "$ENV_FILE"
fi

if $DO_PULL; then
  log "Pulling latest code"
  git pull --ff-only
fi

# ---------------------------------------------------------------------------
# Database first
# ---------------------------------------------------------------------------
log "Starting MongoDB"
$COMPOSE up -d mongo

log "Waiting for MongoDB to accept connections"
for i in {1..40}; do
  if $COMPOSE exec -T mongo mongosh --quiet --eval 'db.adminCommand("ping").ok' >/dev/null 2>&1; then
    echo "   ready after ${i}s"
    break
  fi
  [[ $i -eq 40 ]] && fail "MongoDB did not become healthy in 40s. Check: $COMPOSE logs mongo"
  sleep 1
done

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
if $DO_BUILD; then
  log "Building API image"
  $COMPOSE build api
fi

# ---------------------------------------------------------------------------
# Indexes before traffic
#
# Production runs with autoIndex disabled, so unique constraints only exist
# because this step runs. Doing it before the new API starts means a release
# that adds an index never serves a request without it.
# ---------------------------------------------------------------------------
log "Synchronising database indexes"
$COMPOSE run --rm --no-deps api npm run indexes:sync

# ---------------------------------------------------------------------------
# Roll the app
# ---------------------------------------------------------------------------
log "Starting API and reverse proxy"
$COMPOSE up -d api caddy

log "Waiting for the API to report healthy"
for i in {1..30}; do
  if $COMPOSE exec -T api node -e "require('http').get('http://127.0.0.1:5000/api/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
    echo "   healthy after ${i}s"
    break
  fi
  [[ $i -eq 30 ]] && fail "API did not become healthy. Check: $COMPOSE logs api"
  sleep 1
done

# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------
log "Removing dangling images"
docker image prune -f >/dev/null

log "Deployment complete"
$COMPOSE ps

cat <<DONE

  API      https://${DOMAIN}${API_PREFIX:-/api/v1}
  Health   https://${DOMAIN}${API_PREFIX:-/api/v1}/health

  Logs     docker compose -f docker-compose.prod.yml logs -f api
  Restart  docker compose -f docker-compose.prod.yml restart api
  Backup   bash deploy/backup.sh

Note: the first request after a fresh deploy can take a few seconds while Caddy
obtains its certificate. If it fails, confirm ${DOMAIN} resolves to this server
and that ports 80/443 are open, then check: docker compose -f docker-compose.prod.yml logs caddy

DONE
