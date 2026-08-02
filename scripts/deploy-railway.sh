#!/usr/bin/env bash
#
# One-shot Railway deploy for EventRide.
#
# Prerequisite (the ONLY manual step): run `railway login` once. It opens a browser and needs your
# password, which is why it cannot be scripted.
#
# Then:  ./scripts/deploy-railway.sh
#
# Provisions MySQL and Redis, sets every environment variable, deploys the API from
# apps/api/Dockerfile, waits for health, and seeds the database.

set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-eventride}"

say() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

command -v railway >/dev/null || die "Railway CLI missing. Install it: npm i -g @railway/cli"

railway whoami >/dev/null 2>&1 || die "Not logged in. Run:  railway login"
say "Logged in as: $(railway whoami 2>&1 | tail -1)"

# ---------------------------------------------------------------- project
if railway status >/dev/null 2>&1; then
  say "Using the already-linked Railway project"
else
  say "Creating project '$PROJECT_NAME'"
  railway init --name "$PROJECT_NAME"
fi

# ---------------------------------------------------------------- databases
say "Provisioning MySQL"
railway add --database mysql || echo "  (MySQL may already exist — continuing)"

say "Provisioning Redis"
railway add --database redis || echo "  (Redis may already exist — continuing)"

say "Waiting for the databases to come up"
sleep 25

# ---------------------------------------------------------------- variables
#
# ?timezone=UTC is NOT optional. MySQL DATETIME carries no offset, so a non-UTC session silently
# shifts every deadline in the system. The API asserts this at boot and refuses to start otherwise.
say "Setting environment variables"
JWT_SECRET="$(openssl rand -base64 32)"

railway variables \
  --set "NODE_ENV=production" \
  --set "PORT=3000" \
  --set "JWT_SECRET=$JWT_SECRET" \
  --set "ROUTING_PROVIDER=mock" \
  --set "DEV_OTP_ENABLED=false" \
  --set 'DATABASE_URL=${{MySQL.MYSQL_URL}}?timezone=UTC' \
  --set 'REDIS_URL=${{Redis.REDIS_URL}}' \
  --set "CORS_ORIGINS=http://localhost:8081,http://localhost:19006" \
  --skip-deploys

# ---------------------------------------------------------------- deploy
say "Deploying (Dockerfile build; the container runs prisma migrate deploy on start)"
railway up --detach

say "Waiting for the deployment to become healthy"
for i in $(seq 1 40); do
  sleep 15
  URL="$(railway domain 2>/dev/null | grep -oE 'https?://[^ ]+' | head -1 || true)"
  if [ -n "${URL:-}" ] && curl -fsS "$URL/ready" >/dev/null 2>&1; then
    say "Healthy at $URL"
    break
  fi
  printf '.'
done

URL="$(railway domain 2>/dev/null | grep -oE 'https?://[^ ]+' | head -1 || true)"
[ -n "${URL:-}" ] || die "No public domain yet. Generate one in the Railway dashboard (Settings → Networking), then re-run."

# ---------------------------------------------------------------- seed
say "Seeding the database (1 event, 6 locations, 40 drivers, 200 guests, 1 admin)"
railway run pnpm --filter @eventride/api seed || echo "  Seed failed — run it manually: railway run pnpm --filter @eventride/api seed"

# ---------------------------------------------------------------- verify
say "Verifying the live deployment"
echo "  /health : $(curl -fsS "$URL/health" || echo FAILED)"
echo "  /ready  : $(curl -fsS "$URL/ready"  || echo FAILED)"
echo "  login   : $(curl -fsS -X POST "$URL/api/v1/auth/login" \
      -H 'Content-Type: application/json' \
      -d '{"email":"admin@event.test","password":"admin123"}' | head -c 40 || echo FAILED)..."

cat <<EOF

────────────────────────────────────────────────────────────
  API is live:  $URL

  Point the apps at it — in apps/guest/app.json and
  apps/portal/app.json set:

      "extra": { "apiBaseUrl": "$URL" }

  Then add the app origins to CORS_ORIGINS:

      railway variables --set "CORS_ORIGINS=<origins>"

  Admin sign-in: admin@event.test / admin123

  NOTE: DEV_OTP_ENABLED is false in production, so guest and
  driver OTP login needs a real SMS provider. To demo without
  one, temporarily run:

      railway variables --set "DEV_OTP_ENABLED=true"
────────────────────────────────────────────────────────────
EOF
