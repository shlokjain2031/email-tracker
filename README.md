# Email Tracker Extension

Self-hosted Gmail pixel tracking with:
- Chrome extension (injects tracking pixel on send)
- Node.js server (records opens + serves dashboard)
- SQLite storage

## Quick start (first-time setup)

### 1) Clone and install

```bash
git clone <your-fork-or-repo-url>
cd email-tracker
npm install
```

### 2) Build workspaces

```bash
npm --workspace=shared run build
npm --workspace=server run build
```

### 3) Start server

```bash
PORT=8090 DASHBOARD_TOKEN=change-me npm --workspace=server run start
```

Health check:

```bash
curl http://localhost:8090/health
```

### 4) Load extension

1. Open Chrome: `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select `extension/`
4. Open extension popup and set:
   - **Tracker Base URL** (for local: `http://localhost:8090`, for production: your HTTPS domain)
   - **Dashboard Token** (must match `DASHBOARD_TOKEN`)

### 5) Test end-to-end

1. Send a Gmail message with tracking enabled
2. Open the message
3. Check dashboard at `<tracker-base-url>/dashboard`

---

## Required configuration

Server environment variables:

- `PORT` (default: `8080`)
- `DASHBOARD_TOKEN` (required for dashboard APIs)

Optional:

- `DB_PATH` (default: `server/data/tracker.db`)
- `DEDUP_WINDOW_MS` (default: `30000`)

## What users must configure when self-hosting

If someone else wants to use this repo, they need to configure:

1. Their own domain (recommended) or host/IP
2. Their own HTTPS reverse proxy for production email clients
3. Their own `PORT`
4. Their own strong `DASHBOARD_TOKEN`
5. Their own extension popup values (tracker URL + dashboard token)

That is the minimum for a working deployment.

## Repo structure

- `extension/` Chrome extension (MV3)
- `server/` Express tracker + dashboard + SQLite
- `shared/` shared token/types package
- `deploy/` sample reverse proxy configs

## Tracking behavior

- Pixel endpoint: `GET /t/:token.gif`
- Dashboard endpoints:
  - `GET /dashboard/api/emails`
  - `GET /dashboard/api/open-events`
- Sender suppression endpoint:
  - `POST /mark-suppress-next`
- Optional metrics/debug endpoints:
  - `GET /metrics/gmail-proxy-latency`
  - `GET /metrics/suppress-signals`
  - `GET /metrics/suppression-debug`

Deduplication is based on recent `open_events` lookups and defaults to a 30 second window (`DEDUP_WINDOW_MS=30000`).

## Production HTTPS setup

Use HTTPS in production. Many email clients block or downgrade non-HTTPS assets.

1. Point your domain DNS to your server
2. Open firewall/NAT for ports `80` and `443`
3. Run Node server on localhost (for example `127.0.0.1:8090`)
4. Put reverse proxy in front (Caddy or Nginx)
   - terminate TLS
   - proxy to Node server
5. Use sample configs in:
   - `deploy/Caddyfile`
   - `deploy/nginx-email-tracker.conf`

## Operational recommendations

- Run with a process manager (`systemd`/`pm2`)
- Back up SQLite DB file regularly
- Rotate logs and monitor disk usage
- Keep `DASHBOARD_TOKEN` private

## Privacy note

The tracker stores open metadata including IP, User-Agent, timestamp, and GeoIP-enriched location fields.

## End-to-end user lifecycle

This is the full lifecycle from install to dashboard analytics:

1. **Install and configure**
  - Operator installs dependencies, builds packages, and starts the server.
  - Operator configures `PORT`, `DASHBOARD_TOKEN`, and tracker base URL in extension popup.

2. **Sender composes and sends**
  - Gmail content script detects compose dialogs.
  - On send intent, it requests tracking data from the extension background worker.
  - Background worker creates `user_id` (stable), `email_id` (per message UUID), and token.
  - Content script injects a hidden pixel: `/t/<token>.gif` into outgoing message HTML.

3. **Message arrives in recipient mailbox**
  - The pixel URL is embedded in email body.
  - When rendered, recipient client (or proxy) requests pixel from tracker server.

4. **Server processes pixel request**
  - Token is decoded.
  - IP/User-Agent/Geo are captured.
  - Deduplication checks run against recent open events (`DEDUP_WINDOW_MS`).
  - If event is unique and not suppressed, `tracked_emails.open_count` increments.
  - Event row is always stored in `open_events` with flags like `is_duplicate` and `is_sender_suppressed`.

5. **Dashboard and extension read analytics**
  - Dashboard APIs return tracked emails and open event history.
  - Extension popup/inbox badges consume these APIs using `X-Tracker-Token`.

## Sender vs receiver separation (unique suppression model)

This project uses **identity-based, event-driven suppression** to prevent counting sender self-opens.

How it works:

1. Gmail content script scans visible thread images and extracts tracking tokens.
2. It decodes token payload and compares `sender_email` from token with currently logged-in Gmail account email.
3. If they match, it sends `POST /mark-suppress-next` with that `email_id`.
4. Server stores a short-lived, in-memory suppression mark (consume-once semantics).
5. On next pixel hit for that `email_id`, server consumes mark and writes event as sender-suppressed.
6. Suppressed event is stored for audit/debug but does **not** increment unique open count.

Why this is reliable for Gmail:

- It avoids brittle folder/tab inference.
- It uses account identity (`sender_email === logged-in Gmail email`) instead of UI heuristics.
- It is event-based (explicit mark + consume), not a broad heartbeat time window.

## Repository walkthrough

Top-level:

- `extension/` Gmail extension (MV3)
  - `src/content/gmailCompose.js`: compose injection, inbox badges, sender suppression signaling
  - `src/background/serviceWorker.js`: token generation, storage, dashboard fetches, `mark-suppress-next` calls
  - `src/popup/*`: popup UI for tracker URL/token and recent email debug
- `server/` Express API + dashboard + SQLite persistence
  - `src/index.ts`: app bootstrap (`/health`, routers, `PORT`)
  - `src/routes/track.ts`: pixel route, suppression endpoints, metrics/debug
  - `src/routes/dashboard.ts`: dashboard HTML and authenticated APIs
  - `src/services/openRecorder.ts`: dedupe + insert logic + open count updates
  - `src/services/geoip.ts`: GeoIP enrichment helper
  - `src/db/schema.sql` and `src/db/sqlite.ts`: schema + DB initialization
- `shared/`
  - shared token encode/decode contracts used by server and extension
- `deploy/`
  - sample Caddy/Nginx reverse-proxy configs for HTTPS

Data flow summary:

Extension send action -> tokenized pixel URL -> recipient/proxy pixel fetch -> server open recording/dedupe/suppression -> dashboard and popup reporting.
