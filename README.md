# Email Tracker

Phase 4 scaffold for a Gmail pixel-tracking system.

## Structure

- extension/: Chrome extension (MV3)
- server/: Public tracker service (Express + SQLite)
- shared/: Shared token/types contracts

## Current notes

- SQLite DB defaults to `server/data/tracker.db`.
- Tracking token is unsigned base64url JSON containing:
  - user_id
  - email_id
  - recipient
  - sent_at
- Chrome extension injects a hidden 1x1 pixel on Gmail send action.
- Each user has a stable UUID and each sent email gets a unique email UUID.
- Popup shows tracker URL, user UUID, and recent tracked sends.
- Tracker endpoint: `GET /t/:token.gif`.
- Pixel response headers disable cache:
  - `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`
  - `Pragma: no-cache`
  - `Expires: 0`
- On each open, server stores IP + User-Agent + immediate GeoIP enrichment.
- Deduplication is active for 60 seconds on (`email_id`, `ip_address`, `user_agent`):
  - duplicate events are stored with `is_duplicate = 1`
  - only non-duplicates increment `tracked_emails.open_count`
- Dashboard UI is served by the same Express server at `/dashboard`.
- Dashboard API endpoints:
  - `GET /dashboard/api/emails`
  - `GET /dashboard/api/open-events`
- Dashboard API requires header `X-Tracker-Token` with secret from env var `DASHBOARD_TOKEN`.
- Dashboard page asks for token with a prompt and sends it in API requests.

## Public HTTPS setup (email-tracker.duckdns.org)

Use this when testing from Gmail so the tracking pixel is loaded over HTTPS.

1. Point `email-tracker.duckdns.org` to your server public IP in DuckDNS.
2. Open firewall/NAT for TCP 80 and 443 to that server.
3. Run the tracker API on localhost (for example on port 8090) with `DASHBOARD_TOKEN` set.
4. Put a reverse proxy (Caddy or Nginx) in front of the node server:
  - terminate TLS for `email-tracker.duckdns.org`
  - proxy requests to `http://127.0.0.1:8090`
  - sample configs are included in `deploy/Caddyfile` and `deploy/nginx-email-tracker.conf`
5. Verify externally:
  - `https://email-tracker.duckdns.org/health`
  - `https://email-tracker.duckdns.org/t/<token>.gif`
6. In the extension popup, set **Tracker Base URL** to `https://email-tracker.duckdns.org`.
7. Reload the unpacked extension and send a test email from Gmail.
8. Open the email, then verify rows in SQLite (`tracked_emails`, `open_events`) and the dashboard.
