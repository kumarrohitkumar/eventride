# Deploying EventRide

Two things need hosting: the **API** (needs MySQL + Redis) and the **two mobile apps**.

The apps are React Native — for a reviewer the normal path is Expo Go, no hosting required. Hosting
is only needed if you want a clickable link, which is what the web build is for.

---

## 0. Current state

| | |
|---|---|
| Repo | https://github.com/kumarrohitkumar/eventride |
| API | **live** — https://eventride-api-production.up.railway.app |
| Apps | web preview pending one setting (§2 Option B); APK on demand (§2 Option C) |

---

## 1. API — recommended: Railway

Railway is the least friction because it provides **managed MySQL and Redis** in the same project,
and builds straight from the committed `apps/api/Dockerfile`.

1. railway.app → **New Project → Deploy from GitHub repo** → pick this repo
2. **+ New → Database → MySQL**, then **+ New → Database → Redis**
3. On the API service → **Settings**:
   - Root directory: `/` (the Dockerfile needs the whole workspace — it installs from the monorepo)
   - Dockerfile path: `apps/api/Dockerfile`
4. On the API service → **Variables**:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{MySQL.MYSQL_URL}}` then append `?timezone=UTC` — **required**, see the warning below |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `JWT_SECRET` | a long random string (`openssl rand -base64 32`) |
| `NODE_ENV` | `production` |
| `ROUTING_PROVIDER` | `mock` (or `google` + `GOOGLE_MAPS_API_KEY`) |
| `DEV_OTP_ENABLED` | `false` |
| `CORS_ORIGINS` | your app origins, comma-separated — never `*` |
| `PORT` | `3000` |

5. Deploy. The container runs `prisma migrate deploy` on boot, so the schema is created for you.
6. Seed once, from the Railway shell: `pnpm --filter @eventride/api seed`

> **`?timezone=UTC` is not optional.** MySQL's `DATETIME` carries no offset, so a non-UTC session
> silently shifts every deadline in the system. The API asserts this at boot and refuses to start if
> the session is not UTC — that failure is the guard working, not a bug.

### Alternatives

| Host | Notes |
|---|---|
| **Fly.io** | `fly launch --dockerfile apps/api/Dockerfile`. No managed MySQL — pair with Aiven or PlanetScale, and add Upstash for Redis |
| **Render** | Builds the Dockerfile fine, but offers only Postgres. Bring external MySQL (Aiven free tier) |
| **Any VPS** | `docker build -f apps/api/Dockerfile -t eventride-api . && docker run …` — verified working locally |

### Verify a deployment

```bash
curl https://<your-api>/health   # {"status":"ok",...}
curl https://<your-api>/ready    # {"ready":true,"checks":{"database":true,"redis":true}}
curl https://<your-api>/metrics  # Prometheus text
```

`/ready` is the one that matters: it proves MySQL and Redis are actually reachable, not just that the
process is alive.

---

## 2. Mobile apps

### Option A — Expo Go (what a reviewer will actually use)

```bash
pnpm guest    # scan the QR code
pnpm portal
```

Point them at the deployed API by editing `extra.apiBaseUrl` in each `app.json`, or run against
`localhost:3000`.

### Option B — GitHub Pages (a clickable link, no extra account)

`.github/workflows/pages.yml` publishes both web builds. Enable it:

1. Repo **Settings → Pages → Source: GitHub Actions**
2. Repo **Settings → Variables → Actions** → add `API_BASE_URL` = your deployed API URL
3. Add that Pages origin to the API's `CORS_ORIGINS`, or the apps will load and every request will
   fail preflight

Links become:

```
https://<user>.github.io/<repo>/guest/
https://<user>.github.io/<repo>/portal/
```

**Honest caveat:** the web build is a real preview of layout and flow, but it is not the product.
`expo-secure-store` does not exist on web, so the session lives in memory and does not survive a
refresh; push notifications and background location are native-only.

### Option C — a downloadable APK (the real app)

```bash
npm i -g eas-cli
eas login                                    # free Expo account; opens a browser
cd apps/guest  && eas build -p android --profile preview
cd apps/portal && eas build -p android --profile preview
```

Each build runs in Expo's cloud (~10–15 min) and ends with a URL serving a `.apk` a reviewer can
install on any Android phone. `eas.json` is committed with `buildType: apk` and
`distribution: internal`, so no Play Store account is involved, and both apps already point at the
deployed API.

This is the **only** path that exercises push delivery, background location and the OS permission
dialogs — all three are unverified in this build precisely because no device or simulator was
available. Running an APK on a real phone is what would close that gap.

iOS needs a paid Apple Developer account for installable builds, so Android is the practical choice
for a reviewer.

---

## 3. What is verified, and what is not

**Verified locally:**

- `docker build -f apps/api/Dockerfile .` succeeds
- the container boots, reports `healthy`, connects to MySQL and Redis, serves a real login, runs as
  a non-root user, and its healthcheck passes
- `prisma migrate deploy` runs on container start
- with `NODE_ENV=production` and `DEV_OTP_ENABLED=false`, the dev OTP is no longer returned

**Verified on the live Railway deployment:**

- all three migrations applied against Railway's MySQL 9.4, including the hand-written
  generated-column and AUTO_INCREMENT ones
- `/health`, `/ready` (database **and** Redis), `/metrics` all serving
- admin credential login and driver OTP login both work
- RBAC holds in production: a driver token on an admin route returns 403

**Still not verified:**

- no load test against the hosted instance
- multi-instance: the Redis round lock and Socket.IO adapter are designed for it and untested
- push delivery, background location and OS permission dialogs — these need an APK on a real phone
  (§2 Option C)

**Two things the deployment taught us, worth knowing before repeating it:**

1. `railway.json`'s `startCommand` **overrides the Dockerfile CMD**. Ours still said
   `pnpm exec tsx …` after the runtime image had deliberately dropped pnpm and tsx, so the container
   died instantly with zero log output — which looks exactly like a resource limit and is not.
2. A managed database is usually reachable only from inside the platform network, so `railway run`
   (which executes locally) cannot seed it. Hence the bundled `dist/seed.cjs` and the `SEED_ON_BOOT`
   flag — set it once, then turn it off, because the seed clears data.

---

## 4. Production notes worth reading before a real event

1. **Rotate `JWT_SECRET`** — the committed `.env.example` value is a placeholder and tokens live 12h.
2. **`DEV_OTP_ENABLED=false`** is enforced: `loadEnv()` refuses to boot in production otherwise. With
   it off, a real SMS provider is required or nobody can sign in.
3. **`CORS_ORIGINS` must not be `*`** — also enforced at boot.
4. **Redis is a soft dependency.** If it dies, positions fall back to the 30s-sampled column and the
   round lock falls back to a MySQL advisory lock; dispatch keeps working at lower fidelity.
5. **One API instance** is well inside the designed scale (100 drivers, 500 guests). Scaling out needs
   the Socket.IO Redis adapter enabled — already the design, not yet exercised.
6. **Routing spend**: `ROUTING_PROVIDER=mock` costs nothing. With `google`, budget roughly 320 calls
   per hour at peak (measured), and `/metrics` exposes the live counter.
