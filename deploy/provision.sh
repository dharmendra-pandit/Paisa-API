#!/usr/bin/env bash
#
# One-time hardening and setup for a fresh Ubuntu server (22.04 or later):
# a Hostinger KVM2, or an AWS EC2 instance.
#
# Run ONCE as root on a brand new server, before the first deploy:
#     bash deploy/provision.sh
#
# On EC2, log in as `ubuntu` and reuse that account as the deploy user —
# its key is the one EC2 installed, while root's authorized_keys there only
# prints "Please login as ubuntu":
#     sudo DEPLOY_USER=ubuntu bash deploy/provision.sh
#
# What it does, and why each part matters on a box with a public IP:
#   - creates a non-root deploy user with docker access
#   - installs Docker Engine + the compose plugin from Docker's own repo
#     (Ubuntu's packaged docker.io lags badly)
#   - locks the firewall to 22/80/443 — everything else, including MongoDB's
#     27017, is unreachable from the internet
#   - installs fail2ban to blunt SSH brute-forcing
#   - enables unattended security upgrades
#
# It is idempotent: re-running it will not duplicate users, rules or repos.

set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-paisa}"
SSH_PORT="${SSH_PORT:-22}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root: sudo bash deploy/provision.sh" >&2
  exit 1
fi

log "Updating base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq ca-certificates curl gnupg ufw fail2ban unattended-upgrades git

# ---------------------------------------------------------------------------
# Deploy user
# ---------------------------------------------------------------------------
if id "$DEPLOY_USER" &>/dev/null; then
  log "User '$DEPLOY_USER' already exists"
else
  log "Creating deploy user '$DEPLOY_USER'"
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  usermod -aG sudo "$DEPLOY_USER"

  # Carry root's authorised keys over so you can log in as the new user
  # immediately — otherwise disabling root SSH locks you out.
  if [[ -f /root/.ssh/authorized_keys ]]; then
    install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
    install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
      /root/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/authorized_keys"
    log "Copied root's SSH keys to $DEPLOY_USER"
  else
    warn "No /root/.ssh/authorized_keys found — add a key for $DEPLOY_USER before hardening SSH"
  fi
fi

# ---------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------
if command -v docker &>/dev/null; then
  log "Docker already installed ($(docker --version))"
else
  log "Installing Docker Engine"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list

  apt-get update -qq || true
  if ! apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    # Docker's own repo can trail a brand-new Ubuntu release by weeks. Ubuntu's
    # packages are older but run the same compose file.
    warn "Docker's repository has no packages for this Ubuntu release yet — using Ubuntu's own"
    rm -f /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker.io docker-compose-v2 docker-buildx
  fi
fi

usermod -aG docker "$DEPLOY_USER"
systemctl enable --now docker

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------
log "Configuring firewall (allow $SSH_PORT, 80, 443 only)"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow "$SSH_PORT"/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP (ACME challenge + redirect)'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 443/udp comment 'HTTP/3'
ufw --force enable

# Docker publishes ports by writing iptables rules that bypass ufw entirely.
# The compose file avoids publishing MongoDB at all, which is the real fix; this
# is belt-and-braces in case a future edit adds a `ports:` entry by accident.
cat >/etc/docker/daemon.json <<'JSON'
{
  "iptables": true,
  "userland-proxy": false,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
JSON
systemctl restart docker

# ---------------------------------------------------------------------------
# fail2ban + automatic security updates
# ---------------------------------------------------------------------------
log "Enabling fail2ban and unattended security upgrades"
cat >/etc/fail2ban/jail.local <<JAIL
[sshd]
enabled  = true
port     = $SSH_PORT
maxretry = 5
findtime = 10m
bantime  = 1h
JAIL
systemctl enable --now fail2ban
systemctl restart fail2ban

cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

# ---------------------------------------------------------------------------
# Swap — a 4GB KVM2 running Mongo, Node and a build will OOM without it.
# ---------------------------------------------------------------------------
if ! swapon --show | grep -q '/swapfile'; then
  log "Creating 2GB swap file"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >>/etc/sysctl.conf
fi

log "Provisioning complete"
cat <<NEXT

Next steps:
  1. Verify you can SSH in as '$DEPLOY_USER' in a SEPARATE terminal:
         ssh $DEPLOY_USER@<this-server-ip>
     Do not skip this. The next step can lock you out if the key did not copy.

  2. Harden SSH (only after step 1 works):
         sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/'          /etc/ssh/sshd_config
         sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
         sudo systemctl restart ssh

  3. Point your domain's A record at this server's IP and wait for it to resolve.

  4. Clone the repo and deploy:
         git clone <your-repo> ~/paisa && cd ~/paisa/backend
         cp .env.production.example .env.production
         nano .env.production      # fill in DOMAIN, secrets, database passwords
         chmod 600 .env.production
         bash deploy/deploy.sh

NEXT
