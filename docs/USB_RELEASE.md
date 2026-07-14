# USB release process

For AI agents and maintainers publishing a new USB update.

## Package types

| Package | When to bump | Typical size |
|---------|--------------|--------------|
| `tracking.core.{version}.zip` | Script/logic changes (COPY_TO_DESKTOP, updater, GS, RunOnce) | ~200 KB |
| `tracking.big.{version}.zip` | Large tools (Heaven, color tests, Surface MSIs, etc.) | ~500 MB |
| `tracking.{version}.zip` | Full bootstrap for legacy USBs | ~500 MB |

## v.txt format (example: 1.0.12)

```
v=1.0.12
BootstrapZip=tracking.1.0.12.zip
BootstrapSHA256=<sha256>
CoreVersion=1.0.12
CoreZip=tracking.core.1.0.12.zip
CoreSHA256=<sha256>
BigVersion=1.0.11
BigZip=tracking.big.1.0.11.zip
BigSHA256=<sha256>
VUpdate_1.0.12="Human-readable release notes."
```

- **`v=`** — legacy single-zip updater reads this and downloads `tracking.{v}.zip`.
- **`CoreVersion` / `BigVersion`** — new dual updater compares against `.orderassist-core.version` and `.orderassist-big.version` on `D:\`.

## Publish order (critical)

1. Build packages (server has `build_split_release.py` pattern under `/tmp/`).
2. Upload zip file(s) to `/root/ssl/tracking_5.7/Downloads/`.
3. Verify HTTP: `curl -I http://localhost:3000/Downloads/<zip>`.
4. **Update `Downloads/v.txt` last** — this triggers USB auto-update on next `online_script_Update.ps1` run.
5. Optionally refresh `/root/ssl/tracking_5.7/workstation/` extracts for the Scripts & Tools page.

## What triggers downloads on USB

| Local marker | Remote field | Action if mismatch |
|--------------|--------------|-------------------|
| `.orderassist-big.version` | `BigVersion` | Download + extract `BigZip` to `D:\` |
| `.orderassist-core.version` | `CoreVersion` | Download + extract `CoreZip` to `D:\` |
| `D:\v.txt` → `v=` only (legacy) | `v=` | Download `tracking.{v}.zip` to Desktop, extract to `D:\` |

If **both** core and big versions change, **both** zips download.

## Build notes

- Server has limited RAM (~1 GB); build packages **sequentially** with unzip/zip on disk, not three zips in memory at once.
- Archive old full zips to `/root/ssl/backups_tracking/downloads_archive/` before publishing new 500 MB files.
- Large zips are **not** committed to git (`Downloads/*.zip` in `.gitignore`).

## Scanner rule

Production Desktop launcher:

```
gs Windows Envierment.bat → gs2_server_v5.1_Print.ps1
```

Do not swap in `ps/gs2_server_v2.3_*` without explicit user approval and real-PC testing.
