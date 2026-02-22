# Extension (Phase 2)

Load this folder as an unpacked extension in Chrome.

## What it does

- Runs only on Gmail (`https://mail.google.com/*`).
- Watches compose dialogs.
- On send click, injects a hidden 1x1 pixel (`<img>`).
- Stores recent tracked email metadata in local extension storage.
- Popup shows user UUID, tracker URL, and recent tracked emails.

## Default tracker URL

`http://localhost:8080`

Update it from popup before sending if your tracker API runs elsewhere.
