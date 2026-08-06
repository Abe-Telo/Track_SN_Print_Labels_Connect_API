# AGENTS.md — OrderAssist Tracking

This file is for **AI coding agents** (Cursor, Copilot, Claude, etc.) working on OrderAssist Tracking. Read this before changing production code, USB packages, or server config.

**Repo:** `git@github.com:Abe-Telo/Track_SN_Print_Labels_Connect_API.git`  
**Production app path:** `/root/ssl/tracking_5.7/` (use this unless the user explicitly says `tracking_7.0`)

---

## Production server

| Item | Value |
|------|--------|
| Host | `orderassistnow.com` |
| SSH | `root@orderassistnow.com` (key: `~/.ssh/id_ed25519`) |
| Service | `tracking.service` → `node add.js` on `0.0.0.0:3000` |
| Web UI | `http://orderassistnow.com:3000` (login required) |
| Backups | `/root/ssl/backups_tracking/` (full tree, hourly db, archived zips) |

### Hard constraints

1. **Do not break Full Connection** — work PCs and PowerShell scripts call `orderassistnow.com:3000` (or `localhost:3000` on the PC). Keep these endpoints working: `/verify-tracking`, `/update-remaining`, `/add-device`, `/get-details-by-serial`, `/Downloads/v.txt`, static `/ps`, `/Downloads`, `/workstation`.
2. **Default path is `tracking_5.7`** — not `tracking_7.0`.
3. **Never commit secrets** — `account/`, `db/*.json`, `module/login.js`, API keys, Wi-Fi passwords in scripts are already in repo history in some places; do not add new secrets to git.
4. **Large USB zips are not in git** — `Downloads/*.zip` and `Downloads/*.exe` are gitignored; they live on the server only.
5. **Backup before risky edits** — copy changed files to `/root/ssl/backups_tracking/` before deploy.
6. **Publish USB updates in order** — upload zip(s) first, update `Downloads/v.txt` **last** (see USB release process below).
7. **Fail2ban dashboard is privileged** — keep `/api/fail2ban/*` session-protected, validate every IP/CIDR, and never execute user input through a shell. See `docs/FAIL2BAN.md`.

---

## What this system does

OrderAssist Tracking manages **incoming PC shipments**:

1. Staff add a **tracking number** + expected quantity in the web UI (`remaining` starts at **0**).
2. Work PCs scan serial numbers via PowerShell; each scan increments `remaining` and adds device info.
3. When `remaining === quantity` (solved), the shipment enters a **3-month safe archive** window (not instant archive).
4. **Done** in the UI archives immediately.

Data files (not in git): `db/trackingData.json`, `db/archivedTrackingData.json`.

---

## USB workstation workflow (audit PCs)

USB root is typically **`D:\`**. User flow:

### Phase 1 — COPY TO DESKTOP (unattended start)

- Run **`COPY_TO_DESKTOP.cmd`** from the USB.
- Copies `D:\AUDIT_SCRIPS\*` to Desktop, installs Wi-Fi profiles, runs online update + RunOnce.
- Wi-Fi: **Fios-fXcW7** preferred, **AF7A1C** backup (either network is fine).

### Phase 2 — Updates (walk away)

- **`RunOnce.ps1`** — installs PS modules, schedules `InstallUpdates.ps1` at logon.
- **`InstallUpdates.ps1`** — Windows Update (`-AcceptAll -AutoReboot`).

### Phase 3 — GS Windows Environment (manual, after updates)

- Run **`gs Windows Envierment.bat`** from Desktop → launches **`gs2_server_v5.1_Print.ps1`**.
- This is the **production scanner** (confirmed on live Desktops; hash matches `tracking.1.0.12` core package).
- Submits to **OrderAssist API** (`orderassistnow.com:3000`) **and** **Google Forms** (Forms is a **backup** — keep both).

### Do not replace the scanner casually

- `ps/gs2_server_v2.3_working_Added_Device_info.ps1` on the server is **legacy** (uses `localhost`, old decrement logic). **Do not deploy it to USB.**
- Production scanner: **`gs2_server_v5.1_Print.ps1`** only unless the user explicitly requests a new version and tests on a real PC.

---

## USB package model (as of 1.0.12)

Three downloadable packages + manifest:

| File | Purpose |
|------|---------|
| `tracking.1.0.12.zip` | Full **bootstrap** for old USBs that only read `v=` |
| `tracking.core.1.0.12.zip` | Small scripts (~200 KB) — changes often |
| `tracking.big.1.0.11.zip` | Large tools (~507 MB) — changes rarely |
| `Downloads/v.txt` | Version manifest (committed to git; small) |

`online_script_Update.ps1` (in core package):

- Compares USB markers `.orderassist-core.version` and `.orderassist-big.version` to `CoreVersion` / `BigVersion` in `v.txt`.
- Downloads **only** the package(s) whose version changed.
- Writes full `v.txt` to `D:\v.txt` after success.
- Legacy field `v=` still present so old updaters can fetch `tracking.{v}.zip`.

### USB release checklist (agents)

1. Edit scripts in a staging build (see `/tmp/build_split_release.py` pattern on server).
2. Build `tracking.core.{X}.zip`, `tracking.big.{Y}.zip`, and optionally new bootstrap `tracking.{v}.zip`.
3. Upload zip(s) to `/root/ssl/tracking_5.7/Downloads/`.
4. Update `Downloads/v.txt` with new versions + SHA256 hashes (**last step**).
5. Refresh `workstation/` extract if individual script downloads should match.
6. Restart `tracking.service` only if server code changed (not required for zip-only updates).

Bump **CoreVersion** for script changes. Bump **BigVersion** only when large tools change. Bump **`v=`** when bootstrap layout changes or for legacy USB compatibility.

---

## Key server paths

```
/root/ssl/tracking_5.7/
  add.js                    # Express app entry
  module/
    login.js                # Auth (gitignored)
    safe_archive.js         # 3-month solved → archive logic
    front_end.js            # Done button + hourly auto-archive
    update.db.js            # /update-remaining, device edits
    add.to.db.js            # /add-tracking, /add-device
    scripts_page.js         # /list-scripts API
  db/                       # JSON databases (gitignored)
  Downloads/                # USB zips + v.txt (zips gitignored)
  workstation/              # Individual script downloads for web UI
  ps/                       # Legacy server-side PS scripts (reference)
  deploy/fail2ban/          # Fail2ban config templates (live config is in /etc/fail2ban)
  html/index.html           # App shell (Phase 1 UI)
  js/app/shell.js           # Sidebar navigation
```

---

## Tracking / scan API (work PC scripts)

Production scanner (`gs2_server_v5.1_Print.ps1`) uses:

| Endpoint | Purpose |
|----------|---------|
| `GET /verify-tracking/{last4}` | Match tracking by last 4 digits |
| `POST /update-remaining` | Increment scanned count + add serial (`deviceDate` stamped) |
| `POST /add-device` | Full device record (model, CPU, RAM, etc.) |
| `GET /get-details-by-serial/{sn}` | Check if PC already exists |

**Count-up model:** `remaining` starts at 0 on add; each scan +1. Solved when `remaining === quantity`.

---

## Web UI (Phase 1)

- Left nav: Add Tracking, Search, All Tracking, All Devices, ShipStation, Keys, **Scripts & Tools**, How It Works, Updates.
- **Scripts & Tools** page: `/list-scripts` + downloads from `/workstation`, `/ps`, `/Downloads`.
- Legacy HTML backups: `html/index.legacy.html`, `html/login.legacy.html`.

---

## Safe archive behavior

- **Done** → immediate archive.
- **Solved** (`remaining === quantity`) → `autoArchivePending`, eligible after 3 months (`archiveEligibleAt`).
- Return buckets (`quantity >= 9000`, e.g. 9999) excluded until Returns DB exists.
- Module: `module/safe_archive.js`.

---

## Git / deploy notes

- Many production UI + safe-archive changes may exist on server **before** they are pushed; check `git status` on server.
- `module/login.js`, `account/`, `db/` are gitignored — configure on server only.
- After `npm` changes on server, verify `npm audit` and restart `tracking.service`.
- Do not force-push `main`.

---

## Fail2ban

- Installed and enabled on production (SSH jail, nftables action).
- Dashboard: left nav **Security / Fail2ban**.
- Operations guide: `docs/FAIL2BAN.md`.
- Live protected whitelist values are server-only in `/etc/fail2ban/orderassist-protected-whitelist.txt`.

## Pending / discussed (not built)

- Returns DB for 9999 return buckets
- UI Phase 2+ polish
- COPY_TO_DESKTOP double-run cleanup

---

## Quick verification commands (on server)

```bash
systemctl is-active tracking.service
systemctl is-active fail2ban
fail2ban-client status sshd
curl -s http://localhost:3000/Downloads/v.txt
curl -s http://localhost:3000/list-scripts | head -c 500
```

---

*Last updated: 2026-07-14 (release 1.0.12, dual-package USB updates, GS v5.1 confirmed)*

## Printing, MS labels & History tab

See **[docs/PRINT_AND_LABELS.md](./docs/PRINT_AND_LABELS.md)**.

Do not remove:

- Device modal History tab / Overview timeline link (`History_API_Local` in `html/index.html`)
- Repair Needed View specs / print cooldown
- `Downloads/OrderAssistPrint/` agent kit (Sumatra must run from local cache, not only from H:)
- Specs sheet builder in `module/ms_label_print.js`

Office agent share is typically `H:\Printer\OrderAssistPrint`. Run the agent on the office PC on the printer LAN.

