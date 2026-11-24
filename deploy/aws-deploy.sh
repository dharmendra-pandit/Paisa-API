#!/usr/bin/env bash
#
# Sets up and deploys Paisa on an AWS EC2 Ubuntu server, from your own PC.
#
#     bash deploy/aws-deploy.sh <server-ip> <domain> <key.pem>
#
#     bash deploy/aws-deploy.sh 35.154.125.240 api.paisa.stellzo.tech \
#         /c/Users/Lenovo/Downloads/paisa-backend-key.pem
#
# Run from the `backend` directory in Git Bash. Safe to run again at any time:
# the first run sets the server up; every later run just ships the new code.
#
# What it does, in order:
#   1. uploads this folder (never .env, node_modules or backups)
#   2. installs Docker, the firewall, fail2ban and swap (skipped once done)
#   3. creates .env.production ON THE SERVER with freshly generated passwords
#      and JWT secrets — they never exist on this PC, and a re-run never
#      replaces them (that would lock the API out of its own database)
#   4. checks the domain points at this server, then builds and starts
#      MongoDB, the API and Caddy, which fetches the HTTPS certificate
#
# Step 4 is skipped while DNS still points somewhere else: asking Let's
# Encrypt for a certificate it cannot validate, a few times in a row, gets the
# domain rate-limited for an hour.

set -euo pipefail

cd "$(dirname "$0")/.."

IP="${1:-}"
DOMAIN="${2:-}"
KEY="${3:-}"

if [[ -z "$IP" || -z "$DOMAIN" || -z "$KEY" ]]; then
  echo "Usage: bash deploy/aws-deploy.sh <server-ip> <domain> <key.pem>" >&2
  exit 1
fi
[[ -f "$KEY" ]] || { echo "Key file not found: $KEY" >&2; exit 1; }

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

TARGET="ubuntu@$IP"
REMOTE="/home/ubuntu/paisa"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 "$TARGET")

log "1/4  Uploading the backend to $TARGET"
# First contact records the server's host key, so the upload's own ssh and scp
# calls do not stop to ask "Are you sure you want to continue connecting?".
"${SSH[@]}" true
bash deploy/upload.sh "$TARGET" --path "$REMOTE" --key "$KEY" >/dev/null
echo "    uploaded to $REMOTE"

log "2/4  Preparing the server (disk, Docker, firewall, fail2ban, swap)"
# A disk enlarged in the AWS console is not usable until the partition and
# filesystem are grown to match. Both commands do nothing when there is
# nothing to grow, so this is safe on every run.
"${SSH[@]}" bash -s <<'GROW'
ROOT=$(findmnt -n -o SOURCE /)
DISK=/dev/$(lsblk -no PKNAME "$ROOT")
PART=${ROOT##*[!0-9]}
sudo growpart "$DISK" "$PART" >/dev/null 2>&1 || true
sudo resize2fs "$ROOT" >/dev/null 2>&1 || true
df -h / | awk 'NR==2 {print "    disk: " $4 " free of " $2}'
GROW
"${SSH[@]}" "cd $REMOTE && sudo DEPLOY_USER=ubuntu bash deploy/provision.sh >/tmp/paisa-provision.log 2>&1 || { tail -30 /tmp/paisa-provision.log; exit 1; }; echo '    done (log: /tmp/paisa-provision.log)'"

log "3/4  Production settings"
# shellcheck disable=SC2087  # expanding DOMAIN locally is the point
"${SSH[@]}" bash -s <<REMOTE_ENV
set -euo pipefail
cd $REMOTE
if [ -f .env.production ]; then
  echo "    .env.production already exists — kept as it is"
  exit 0
fi

cp .env.production.example .env.production
chmod 600 .env.production

secret() { openssl rand -hex "\$1"; }
set_var() { sed -i "s|^\$1=.*|\$1=\$2|" .env.production; }

set_var DOMAIN "$DOMAIN"
set_var CORS_ORIGINS "https://stellzo.tech,https://www.stellzo.tech"
set_var MONGO_ROOT_PASSWORD "\$(secret 24)"
set_var MONGO_APP_PASSWORD "\$(secret 24)"
set_var JWT_ACCESS_SECRET "\$(secret 48)"
set_var JWT_REFRESH_SECRET "\$(secret 48)"
set_var MONGO_CACHE_GB "0.5"

if grep -q CHANGE_ME .env.production; then
  echo "    !! some placeholders were not replaced:" >&2
  grep -n CHANGE_ME .env.production | cut -d= -f1 >&2
  exit 1
fi
echo "    created .env.production with new random passwords (kept only on this server)"
REMOTE_ENV

log "4/4  Checking DNS for $DOMAIN"
resolved=$("${SSH[@]}" "getent ahostsv4 $DOMAIN | awk 'NR==1{print \$1}'" || true)
if [[ "$resolved" != "$IP" ]]; then
  cat <<WAIT

    $DOMAIN points to: ${resolved:-nothing yet}
    It must point to:  $IP

    Change the A record in your DNS, wait a few minutes, then run this
    same command again. The server is ready; only the start is waiting.

WAIT
  exit 2
fi
echo "    $DOMAIN -> $IP"

log "Building and starting Paisa (the first build takes a few minutes)"
# A new SSH login, so the docker group added in step 2 applies.
"${SSH[@]}" "cd $REMOTE && bash deploy/deploy.sh"

log "Checking from the internet"
for i in {1..20}; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/v1/health" || true)
  if [[ "$code" == "200" ]]; then
    echo "    https://$DOMAIN/api/v1/health answered 200"
    exit 0
  fi
  sleep 3
done
echo "    https://$DOMAIN/api/v1/health did not answer yet (last: $code)."
echo "    Check the certificate: ${SSH[*]} 'cd $REMOTE && docker compose -f docker-compose.prod.yml logs caddy'"
exit 1
