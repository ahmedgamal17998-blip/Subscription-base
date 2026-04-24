#!/bin/bash
# ============================================================================
# VPS Setup Script — Paymob + GHL Auto-Renewal System
# Contabo VPS 10 SSD (4 cores, 8GB RAM, 150GB SSD, Ubuntu)
#
# Usage:
#   scp deploy/setup-vps.sh root@YOUR_IP:~/
#   ssh root@YOUR_IP
#   chmod +x setup-vps.sh
#   sudo ./setup-vps.sh
#
# Supports two modes:
#   - IP-only (for testing):  leave DOMAIN empty
#   - Domain (for production): set DOMAIN=pay.example.com
# ============================================================================

set -euo pipefail

DOMAIN=""                        # <-- SET THIS when you have a domain (e.g., pay.example.com)
VPS_IP=$(curl -s ifconfig.me)    # Auto-detect public IP
APP_DIR="/home/deploy/paymob-ghl"
DB_NAME="paymob_ghl"
DB_USER="paymob"
DB_PASS=$(openssl rand -base64 24)
NODE_VERSION="20"

if [ -n "$DOMAIN" ]; then
  HOST="$DOMAIN"
  APP_URL="https://$DOMAIN"
  MODE="domain"
else
  HOST="$VPS_IP"
  APP_URL="http://$VPS_IP"
  MODE="ip-only"
fi

echo "============================================"
echo "  Paymob + GHL VPS Setup"
echo "  Mode: $MODE"
echo "  Host: $HOST"
echo "============================================"

# ── 1. System Update ──────────────────────────────────────────────────────────
echo "[1/8] Updating system..."
apt update && apt upgrade -y
apt install -y curl git ufw fail2ban nginx

# ── 2. Firewall ───────────────────────────────────────────────────────────────
echo "[2/8] Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp     # SSH
ufw allow 80/tcp     # HTTP
ufw allow 443/tcp    # HTTPS
ufw --force enable
echo "Firewall: only ports 22, 80, 443 open"

# ── 3. Node.js ────────────────────────────────────────────────────────────────
echo "[3/8] Installing Node.js $NODE_VERSION..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt install -y nodejs
npm install -g pm2
echo "Node $(node -v), npm $(npm -v), PM2 $(pm2 -v)"

# ── 4. PostgreSQL ─────────────────────────────────────────────────────────────
echo "[4/8] Installing PostgreSQL..."
apt install -y postgresql postgresql-contrib

sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;"

DATABASE_URL="postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME"

# ── 5. Deploy user + App directory ────────────────────────────────────────────
echo "[5/8] Creating deploy user and app directory..."
id -u deploy &>/dev/null || useradd -m -s /bin/bash deploy
mkdir -p $APP_DIR
mkdir -p /var/log/paymob-ghl
chown -R deploy:deploy $APP_DIR /var/log/paymob-ghl

# ── 6. Nginx ──────────────────────────────────────────────────────────────────
echo "[6/8] Configuring Nginx..."

if [ "$MODE" = "domain" ]; then
  # ── Domain mode: HTTP → HTTPS redirect + certbot ────────────────────────
  cat > /etc/nginx/sites-available/paymob-ghl << NGINX_CONF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}
NGINX_CONF

  ln -sf /etc/nginx/sites-available/paymob-ghl /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  mkdir -p /var/www/certbot
  nginx -t && systemctl restart nginx

  # Get SSL certificate
  apt install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email admin@"$DOMAIN" --redirect

  # Full nginx config with SSL
  cat > /etc/nginx/sites-available/paymob-ghl << NGINX_SSL
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 60s;
    }

    location = /health {
        access_log off;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX_SSL

  systemctl enable certbot.timer
  echo "Nginx + SSL configured for $DOMAIN"

else
  # ── IP-only mode: plain HTTP (no SSL) ───────────────────────────────────
  cat > /etc/nginx/sites-available/paymob-ghl << 'NGINX_IP'
server {
    listen 80 default_server;
    server_name _;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
    }

    location = /health {
        access_log off;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINX_IP

  ln -sf /etc/nginx/sites-available/paymob-ghl /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  echo "Nginx configured for IP-only mode (HTTP on port 80)"
fi

nginx -t && systemctl reload nginx

# ── 7. Fail2ban ──────────────────────────────────────────────────────────────
echo "[7/8] Configuring fail2ban..."
systemctl enable fail2ban
systemctl start fail2ban

# ── 8. Create .env template ──────────────────────────────────────────────────
echo "[8/8] Creating .env template..."

cat > $APP_DIR/.env << ENV_FILE
# Generated by setup-vps.sh — fill in the Paymob/GHL values
NODE_ENV=production
PORT=3000
APP_URL=$APP_URL

# Database (auto-generated)
DATABASE_URL=$DATABASE_URL

# Paymob (fill these in)
PAYMOB_API_KEY=
PAYMOB_HMAC_SECRET=
PAYMOB_SECRET_KEY=
PAYMOB_PUBLIC_KEY=
PAYMOB_INTEGRATION_ID=
PAYMOB_MOTO_INTEGRATION_ID=
PAYMOB_WALLET_INTEGRATION_ID=

# GoHighLevel
GHL_WEBHOOK_URL=

# Admin
ADMIN_API_KEY=$(openssl rand -base64 32)

# Subscription Plan IDs (from scripts/setup-plans.js)
PAYMOB_MONTHLY_PLAN_ID=
PAYMOB_YEARLY_PLAN_ID=
PAYMOB_WEEKLY_PLAN_ID=

# Legacy amounts (used when no product configured)
CURRENCY=EGP
MONTHLY_AMOUNT_CENTS=10000
YEARLY_AMOUNT_CENTS=100000
ENV_FILE

chown deploy:deploy $APP_DIR/.env
chmod 600 $APP_DIR/.env

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
echo "  SETUP COMPLETE ($MODE mode)"
echo "============================================"
echo ""
CREDS_FILE="/root/.paymob-credentials"
cat > $CREDS_FILE << CREDS
DB_PASS=$DB_PASS
DATABASE_URL=$DATABASE_URL
CREDS
chmod 600 $CREDS_FILE

echo "  App URL: $APP_URL"
echo "  .env created at: $APP_DIR/.env"
echo "  Admin key auto-generated in .env"
echo ""
echo "  DB credentials saved to: $CREDS_FILE (root-only, chmod 600)"
echo "  View with: sudo cat $CREDS_FILE"
echo ""
echo "============================================"
echo "  Next steps:"
echo "============================================"
echo ""
echo "  1. Clone your repo:"
echo "     su - deploy"
echo "     cd $APP_DIR"
echo "     git clone YOUR_REPO_URL ."
echo ""
echo "  2. Fill in Paymob + GHL keys in .env:"
echo "     nano $APP_DIR/.env"
echo ""
echo "  3. Install + migrate + start:"
echo "     npm install --production"
echo "     npx prisma db push"
echo "     pm2 start deploy/ecosystem.config.js"
echo "     pm2 save"
echo ""
echo "  4. Enable PM2 on boot:"
echo "     pm2 startup   # run the printed command as root"
echo ""
if [ "$MODE" = "ip-only" ]; then
echo "  5. When you get a domain:"
echo "     - Point DNS A record to $VPS_IP"
echo "     - Set DOMAIN in this script and re-run"
echo "     - Update APP_URL in .env"
echo "     - Update Paymob webhook URLs"
echo "     - pm2 restart paymob-ghl"
echo ""
fi
echo "============================================"
