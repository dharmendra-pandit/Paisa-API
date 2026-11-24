#!/usr/bin/env bash
#
# Turns on Paisa AI on the server (or swaps its key or model), from your PC.
#
#     bash deploy/set-ai.sh <server-ip> <key.pem>
#
#     bash deploy/set-ai.sh 35.154.125.240 /c/Users/Lenovo/Downloads/paisa-backend-key.pem
#
# It asks for the API key without showing it, and sends it over SSH on stdin —
# never as a command-line argument, so it is not left in your shell history or
# in the server's process list. The key is written only to .env.production on
# the server, which is never uploaded, committed or baked into an image.
#
# Defaults suit a reasoning model; override any of them for another provider:
#
#     AI_MODEL=some-model AI_REASONING_EFFORT= AI_MAX_OUTPUT_TOKENS=800 \
#         AI_BASE_URL=https://example.com/v1 bash deploy/set-ai.sh <ip> <key.pem>
#
# Then it restarts the API and asks the model one real question, so a wrong
# key or model name shows up here rather than in the app.

set -euo pipefail

IP="${1:-}"
KEY_FILE="${2:-}"
if [[ -z "$IP" || -z "$KEY_FILE" ]]; then
  echo "Usage: bash deploy/set-ai.sh <server-ip> <key.pem>" >&2
  exit 1
fi
[[ -f "$KEY_FILE" ]] || { echo "Key file not found: $KEY_FILE" >&2; exit 1; }

BASE_URL="${AI_BASE_URL:-https://api.openai.com/v1}"
MODEL="${AI_MODEL:-gpt-5-mini}"
EFFORT="${AI_REASONING_EFFORT-minimal}"
TOKENS="${AI_MAX_OUTPUT_TOKENS:-2000}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

read -rsp "Paste the AI API key (it will not show), then press Enter: " API_KEY
echo
API_KEY="$(printf '%s' "$API_KEY" | tr -d '[:space:]')"
if [[ ! "$API_KEY" =~ ^[A-Za-z0-9_-]{20,}$ ]]; then
  echo "That does not look like an API key (letters, digits, - and _ only)." >&2
  exit 1
fi

log "Saving the AI settings on the server (model: $MODEL)"

# Everything except the key is substituted here; the key arrives on stdin.
REMOTE=$(cat <<SCRIPT
set -euo pipefail
cd /home/ubuntu/paisa
grep -q AI_REASONING_EFFORT src/config/env.js || {
  echo "    !! The server has older code. Run deploy/aws-deploy.sh first, then this again." >&2
  exit 1
}
IFS= read -r KEY
f=.env.production
set_var() {
  if grep -q "^\$1=" "\$f"; then sed -i "s|^\$1=.*|\$1=\$2|" "\$f"; else printf '%s=%s\n' "\$1" "\$2" >>"\$f"; fi
}
set_var AI_API_KEY "\$KEY"
set_var AI_BASE_URL "$BASE_URL"
set_var AI_MODEL "$MODEL"
set_var AI_REASONING_EFFORT "$EFFORT"
set_var AI_MAX_OUTPUT_TOKENS "$TOKENS"
chmod 600 "\$f"
echo "    saved to .env.production"

C="docker compose -f docker-compose.prod.yml"
\$C up -d --force-recreate --no-deps api >/dev/null 2>&1
for i in \$(seq 1 40); do
  if \$C exec -T api node -e "require('http').get('http://127.0.0.1:5000/api/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
    echo "    API restarted"
    break
  fi
  [ "\$i" -eq 40 ] && { echo "    !! API did not come back. Check: \$C logs api" >&2; exit 1; }
  sleep 1
done

echo "    asking one test question..."
\$C exec -T api node -e "
  require('./src/services/ai.service')
    .chat({ currency: 'INR' }, { messages: [{ role: 'user', content: 'Reply with just the word OK.' }], includeContext: false })
    .then((r) => { console.log('    answer: ' + r.reply.slice(0, 80)); process.exit(0); })
    .catch((e) => { console.log('    !! test failed: ' + e.message); process.exit(1); });
" 2>&1 | grep -E '^    ' || { echo "    !! See why: \$C logs --tail 20 api" >&2; exit 1; }
SCRIPT
)

printf '%s\n' "$API_KEY" | ssh -i "$KEY_FILE" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
  "ubuntu@$IP" "bash -c $(printf '%q' "$REMOTE")"

log "Paisa AI is on. Open the AI tab in the app to try it."
