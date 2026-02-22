# Extension (Phase 2)

Load this folder as an unpacked extension in Chrome.

## What it does

- Runs only on Gmail (`https://mail.google.com/*`).
- Watches compose dialogs.
- On send click, injects a hidden 1x1 pixel (`<img>`).
- Stores recent tracked email metadata in local extension storage.
- Popup shows user UUID, tracker URL, and recent tracked emails.
- Gmail list view shows an embedded opens badge (`Opens:N`, `Unopened`, or `Not tracked`).
- Clicking a badge opens the dashboard URL filtered for that email.

## Default tracker URL

`https://email-tracker.duckdns.org`

The popup still allows overriding this value. Use an HTTPS URL so Gmail does not block the pixel request as mixed content.

## Dashboard token

Set the dashboard token in the popup so the extension can fetch counts from `/dashboard/api/emails`.
