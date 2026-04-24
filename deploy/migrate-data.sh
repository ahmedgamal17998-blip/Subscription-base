#!/bin/bash
# ============================================================================
# Migrate data from Neon PostgreSQL → VPS PostgreSQL
#
# Run this ON YOUR LOCAL MACHINE (not on VPS), because you need
# access to both the Neon DB and the VPS.
#
# Prerequisites:
#   - psql and pg_dump installed locally (or use VPS)
#   - Neon DATABASE_URL from your current .env
#   - VPS DATABASE_URL from setup-vps.sh output
#
# Usage:
#   chmod +x deploy/migrate-data.sh
#   ./deploy/migrate-data.sh
# ============================================================================

set -euo pipefail

echo "============================================"
echo "  Neon → VPS Data Migration"
echo "============================================"
echo ""

# ── Step 1: Get connection strings ────────────────────────────────────────────
read -p "Neon DATABASE_URL: " NEON_URL
read -p "VPS DATABASE_URL:  " VPS_URL

DUMP_FILE="neon-export-$(date +%Y%m%d-%H%M%S).sql"

# ── Step 2: Export from Neon ──────────────────────────────────────────────────
echo ""
echo "[1/3] Exporting data from Neon..."
pg_dump "$NEON_URL" \
  --data-only \
  --no-owner \
  --no-privileges \
  --exclude-table='_prisma_migrations' \
  --exclude-table='_prisma*' \
  > "$DUMP_FILE"

LINES=$(wc -l < "$DUMP_FILE")
echo "  Exported to $DUMP_FILE ($LINES lines)"

# ── Step 3: Preview ──────────────────────────────────────────────────────────
echo ""
echo "[2/3] Preview — tables found in dump:"
grep "^COPY " "$DUMP_FILE" | sed 's/COPY public\.\(.*\) (.*/  - \1/' || echo "  (no COPY statements found)"
echo ""

read -p "Continue importing to VPS? (y/n): " CONFIRM
if [ "$CONFIRM" != "y" ]; then
  echo "Aborted. Dump saved at: $DUMP_FILE"
  exit 0
fi

# ── Step 4: Import to VPS ────────────────────────────────────────────────────
echo ""
echo "[3/3] Importing to VPS PostgreSQL..."
psql "$VPS_URL" < "$DUMP_FILE"

echo ""
echo "============================================"
echo "  MIGRATION COMPLETE"
echo "============================================"
echo "  Dump file: $DUMP_FILE"
echo ""
echo "  Verify on VPS:"
echo "    psql \$VPS_URL -c 'SELECT count(*) FROM \"Subscription\";'"
echo "    psql \$VPS_URL -c 'SELECT count(*) FROM \"Payment\";'"
echo "    psql \$VPS_URL -c 'SELECT count(*) FROM \"Product\";'"
echo "============================================"
