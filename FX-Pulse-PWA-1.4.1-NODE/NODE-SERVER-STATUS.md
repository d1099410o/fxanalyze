# FX Pulse 1.4.1 — Node.js server release

## Verification
- `npm run check`: PASS.
- `npm test`: PASS — 32 passed, 0 failed.
- `npm run verify:server`: PASS — `/`, `/manifest.webmanifest`, `/sw.js`, `/offline.html`, `/api/health` all returned HTTP 200.
- Setup script tested in a clean temporary folder: generated a 96-character random admin token and preserved it on subsequent runs.
- Node.js runtime uses only built-in modules. `npm install` is not required.

## Start
- Windows: double-click `START-FXPULSE-WINDOWS.bat`.
- macOS/Linux: `./START-FXPULSE-MAC-LINUX.sh`.
- Manual: `node scripts/setup.mjs`, then `npm start`.

## Runtime
- Node.js 20 minimum; Node.js 22 LTS recommended.
- Default port: 3000 (`PORT` can be overridden in `.env`).
- Server binds to `0.0.0.0`, prints localhost and LAN IPv4 addresses, and runs until Ctrl+C.
- Initial mode: DEMO.

## Security / network notes
- `.env` and `data/` are ignored by Git and excluded from this release archive.
- `FXPULSE_SETUP_TOKEN` is generated and stored in `.env`; keep it private. Copy it from that file when using the API setup wizard.
- LAN HTTP is for local preview only. PWA installation and remote API-key configuration require HTTPS. Use a TLS reverse proxy or trusted HTTPS tunnel before using the app from another device.
- Do not expose the raw Node.js port directly to the public Internet.
