# OrderAssist Tracking

Web app + API for tracking incoming PC shipments, device scanning from audit workstations, and USB-based shop tooling.

- **Production:** `orderassistnow.com:3000`
- **Live path:** `/root/ssl/tracking_5.7/` on the OrderAssist server
- **Service:** `tracking.service` (`node add.js`)

## For AI agents

Read **[AGENTS.md](./AGENTS.md)** first — server access, USB workflow, release process, constraints, and what not to break.

Additional detail:

- [docs/USB_RELEASE.md](./docs/USB_RELEASE.md) — how to publish core/big/bootstrap packages and `v.txt`
- [docs/FAIL2BAN.md](./docs/FAIL2BAN.md) — SSH protection and dashboard operations

## Stack

- Node.js / Express (`add.js`)
- JSON file databases (`db/` — not in git)
- Static UI (`html/`, `js/`, `css/`)
- PowerShell workstation scripts (shipped via USB `Downloads/` packages)

## Git ignored (server-only)

- `account/` — ShipStation credentials
- `db/` — tracking JSON data
- `module/login.js` — session/login config
- `Downloads/*.zip`, `Downloads/*.exe` — large USB payloads

`Downloads/v.txt` **is** tracked — small version manifest for USB auto-update.
