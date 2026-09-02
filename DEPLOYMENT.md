# Deploying Paisa to a Hostinger KVM2 VPS

Production deployment on a self-managed VPS with your own domain. The stack is
Docker Compose running three containers: the Node API, MongoDB (never exposed to
the internet), and Caddy terminating TLS with automatic Let's Encrypt
certificates.

```
                    Internet
                       │
                 :80 :443 (only open ports)
                       │
              ┌────────▼────────┐
              │      Caddy      │  automatic TLS, security headers
              └────────┬────────┘
                       │  paisa-edge network
              ┌────────▼────────┐
              │   Paisa API     │  no published ports
              └────────┬────────┘
                       │  paisa-internal network
              ┌────────▼────────┐
              │    MongoDB      │  no published ports, auth required
              └─────────────────┘
```

The two networks are deliberate: Caddy can reach the API, but it cannot reach
MongoDB. A compromise of the proxy does not hand over the database.

---

## Prerequisites

- A Hostinger KVM2 VPS running **Ubuntu 22.04 or 24.04**
- A domain, with DNS you can edit
- An SSH key already added to the server (Hostinger does this at creation)

---

## 1. Point your domain at the server

In your DNS provider, create an **A record** for the subdomain you want the API
on, pointing at the VPS's IPv4 address:

| Type | Name  | Value            | TTL  |
|------|-------|------------------|------|
| A    | `api` | `<your VPS IP>`  | 3600 |

If your VPS has an IPv6 address, add an `AAAA` record too.

**Do this first and let it propagate.** Caddy requests a certificate on its first
start, and Let's Encrypt validates by connecting to the domain. If DNS is not
live yet the request fails, and repeated failures hit a rate limit that locks you
out for an hour.

Check it resolves before continuing:

```bash
dig +short api.yourdomain.com
```

---

## 2. Provision the server (once)

SSH in as root and run the provisioning script:

```bash
ssh root@<your VPS IP>
git clone <your-repo-url> paisa
cd paisa/backend
bash deploy/provision.sh
```

This creates a non-root `paisa` user, installs Docker, locks the firewall to
ports 22/80/443, enables fail2ban and unattended security upgrades, and adds a
2GB swap file (a 4GB KVM2 running Mongo plus a Docker build will OOM without it).

**Then verify SSH as the new user in a separate terminal before hardening:**

```bash
ssh paisa@<your VPS IP>     # must work before you continue
```

Only once that works, disable root and password login:

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/'                /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/'  /etc/ssh/sshd_config
sudo systemctl restart ssh
```

---

## 3. Configure secrets

As the `paisa` user:

```bash
cd ~/paisa/backend
cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production
```

Generate each secret separately — never reuse one value for two settings:

```bash
openssl rand -hex 48    # JWT_ACCESS_SECRET
openssl rand -hex 48    # JWT_REFRESH_SECRET
openssl rand -hex 24    # MONGO_ROOT_PASSWORD
openssl rand -hex 24    # MONGO_APP_PASSWORD
```

At minimum you must set `DOMAIN`, `ACME_EMAIL`, `CORS_ORIGINS`, all four
passwords above, and both Mongo usernames. `deploy.sh` refuses to run while any
`CHANGE_ME` placeholder remains.

> **On `CORS_ORIGINS`:** a native mobile app sends no `Origin` header and is
> unaffected by CORS. Set this only for browser clients, and never to `*` —
> combined with `credentials: true` that is both a security hole and rejected by
> browsers outright.

---

## 4. Deploy

```bash
bash deploy/deploy.sh
```

The script starts MongoDB and waits for it, builds the API image, **syncs
database indexes before any traffic is served**, then starts the API and Caddy
and waits for a healthy response.

That index step is not optional. Production runs with Mongoose's `autoIndex`
disabled — letting a booting web process build indexes blocks startup and makes
replicas race each other — so the unique constraints on account email, SMS
replay fingerprints, budget keys and subscription keys exist *only* because
`npm run indexes:sync` runs. Skip it and duplicate accounts become possible.

Verify:

```bash
curl https://api.yourdomain.com/api/v1/health
```

```json
{ "success": true, "message": "OK", "data": { "status": "healthy", "database": "connected" } }
```

The first request may take a few seconds while Caddy obtains its certificate.

---

## 5. Set up backups

```bash
bash deploy/backup.sh                    # verify it works right now
crontab -e
```

```cron
15 3 * * * cd /home/paisa/paisa/backend && bash deploy/backup.sh >> /var/log/paisa-backup.log 2>&1
```

The script dumps a compressed archive, **verifies it is readable** rather than
trusting the exit code, and prunes anything older than `BACKUP_RETENTION_DAYS`.

⚠️ **These backups sit on the same disk as the database they protect.** A dead
server takes both. Copy them off the box:

```bash
rclone copy ./backups remote:paisa-backups --max-age 48h
```

Restore with:

```bash
bash deploy/backup.sh --restore paisa-paisa-20260902-031500.archive.gz
```

---

## Routine operations

| Task | Command |
|------|---------|
| Deploy new code | `bash deploy/deploy.sh --pull` |
| Restart the API | `docker compose -f docker-compose.prod.yml restart api` |
| Follow logs | `docker compose -f docker-compose.prod.yml logs -f api` |
| Container status | `docker compose -f docker-compose.prod.yml ps` |
| Mongo shell | `docker compose -f docker-compose.prod.yml exec mongo mongosh -u "$MONGO_ROOT_USER" -p --authenticationDatabase admin` |
| Rebuild indexes | `docker compose -f docker-compose.prod.yml run --rm api npm run indexes:sync` |
| Seed demo data | `docker compose -f docker-compose.prod.yml run --rm api npm run seed` |
| Stop everything | `docker compose -f docker-compose.prod.yml down` |

Deploys are safe to repeat. A failed build leaves the running site untouched,
because the old container is only replaced once the new image builds cleanly.

---

## Security notes

**MongoDB is not reachable from the internet.** It publishes no ports and lives
on an internal Docker network. This matters more than it sounds: the development
`docker-compose.yml` binds `27017:27017` with no authentication, which on a
public IP is discovered by automated scanners within hours and ransomed. Never
use the dev compose file on the VPS.

**The API does not connect as root.** `deploy/mongo-init.js` creates a separate
application user with `readWrite` on the `paisa` database only. If the API is
ever compromised, the blast radius is this app's data rather than the whole
MongoDB instance.

**Docker bypasses ufw.** Publishing a port in Compose writes iptables rules that
skip the firewall entirely. The real protection is that the compose file
publishes nothing except Caddy's 80/443 — check any future edit that adds a
`ports:` entry.

**API docs are off by default.** `SWAGGER_ENABLED` defaults to `false` in
production because interactive docs enumerate every endpoint and schema, which
is an attack-surface map on a public domain. Turn it on temporarily if you need
it, then turn it back off.

**Rate limits key on the /64 for IPv6.** ISPs hand a whole /64 to one customer,
so keying on the full address would let a single client rotate through addresses
and get unlimited login attempts.

---

## Sizing

A KVM2 (2 vCPU / 8GB) comfortably runs this stack. MongoDB's WiredTiger cache is
capped at 1GB in the compose file and the API is limited to 1GB, leaving ample
headroom for the OS and a build.

If you later outgrow one box, the natural first split is moving MongoDB to a
managed service and pointing `MONGODB_URI` at it — nothing else in the stack
needs to change.

---

## Troubleshooting

**Certificate will not issue**

```bash
docker compose -f docker-compose.prod.yml logs caddy
dig +short api.yourdomain.com     # must return your VPS IP
sudo ufw status                    # 80 and 443 must be allowed
```

Almost always DNS has not propagated, or something else already holds port 80.

**API container restarts in a loop**

```bash
docker compose -f docker-compose.prod.yml logs api
```

`config/env.js` validates the environment at import and throws on anything
missing, so the error names the offending variable directly.

**`Authentication failed` from MongoDB**

The app user is created by `deploy/mongo-init.js`, which runs **only on first
boot with an empty data directory**. If you changed `MONGO_APP_PASSWORD` after
the first deploy, the container did not pick it up. Either update the password
in the running database:

```bash
docker compose -f docker-compose.prod.yml exec mongo mongosh \
  -u "$MONGO_ROOT_USER" -p --authenticationDatabase admin \
  --eval 'db.getSiblingDB("paisa").changeUserPassword("paisa_app", "<new password>")'
```

or, if the database holds nothing you need, start clean:

```bash
docker compose -f docker-compose.prod.yml down -v   # DESTROYS ALL DATA
bash deploy/deploy.sh
```

**Out of memory during a build**

Confirm swap is active with `swapon --show`. `provision.sh` adds 2GB; if you
skipped it, run that part again.
