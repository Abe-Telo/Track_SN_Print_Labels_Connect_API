# OrderAssist Print Kit, Labels & Specs Sheet

Documentation for the office print agent, MS shipping-label printing, specs sheet, and device History tab.  
Live path: `/root/ssl/tracking_5.7/` · Production: `https://orderassistnow.com:3000`

## Do not break

These features are intentional. Do **not** remove or “simplify away”:

| Feature | Where |
|--------|--------|
| Device modal **History** tab | `html/index.html` (`History_API_Local` button + panel) |
| Overview **Open full history timeline** | `js/model_ShowAPILocalDetails.js` → `openTab(..., 'History_API_Local')` |
| Repair Needed **View specs** / **Print specs** / **Print label** | `js/repair_needed.js` |
| Print **success message + 15s cooldown** | `js/repair_needed.js`, `js/model_ShowAPILocalDetails.js`, `module/printers.js` |
| One-page **MS specs sheet** (Overview-style cards) | `module/ms_label_print.js` → `buildDetailsSheetPdf` |
| 4×6 label crop | `module/ms_label_print.js` → `buildCroppedLabelPdf` |
| Office **print agent kit** | `Downloads/OrderAssistPrint/` (and office share `H:\Printer\OrderAssistPrint`) |
| Agent stop helpers | `stop_background_services.bat` / `stop_agent.bat` |

`html/html_index.html` may also contain History markup; **`html/index.html` is what the app serves**.

---

## Office print agent (`OrderAssistPrint`)

### Location

- Server kit: `Downloads/OrderAssistPrint/`
- Office share (typical): `H:\Printer\OrderAssistPrint`
- Run the agent on the **office PC that can reach the printer**, not a laptop off the LAN.

### Start / stop

| File | Purpose |
|------|---------|
| `start_agent.bat` | Visible agent console; kills prior agents; caches Sumatra locally |
| `start_agent_hidden.bat` | Silent / Startup-friendly |
| `stop_background_services.bat` | Stops print_agent + leftover SumatraPDF |
| `stop_agent.bat` | Alias for stop |

Banner should show version e.g. `v2026-08-06e` (or newer).

### SumatraPDF “Run” prompt from `H:`

Windows treats executables on network/WebDAV drives as untrusted. The agent **copies** `SumatraPDF.exe` to:

`%LOCALAPPDATA%\OrderAssistPrint\SumatraPDF.exe`

and prints from that local path (`cache_sumatra_local.ps1`). Do not force-run Sumatra from `H:` every job.

### Config

- `config.json` — `BaseUrl` (e.g. `https://orderassistnow.com:3000`), `PollSeconds`
- `token.txt` — agent token from **Printers → Agent** (never commit real tokens; use `token.example.txt`)

### Printers

- Windows queue name must match `windowsPrinterName` in OrderAssist (e.g. `HP4B5CF1 (HP ENVY 5660 series)`).
- Letter/A4 office printers can print label PDFs (layout may be small on the page). True 4×6 needs a label printer when available.
- Jobs stuck in the Windows queue with **Out of Paper** are a printer/supply issue, not OrderAssist.

### Scripts encoding

PowerShell 5.1 on Windows can break on UTF-8 files **without BOM** that contain Unicode dashes. Keep kit `.ps1` files ASCII-safe or UTF-8 **with BOM**.

---

## Repair Needed — labels modal

Buttons per label card:

1. **View PDF** — original MS label PDF  
2. **Download**  
3. **View specs** — builds one-page specs sheet (`mode: view-sheet`), opens it (no print queue)  
4. **Print label** — queues cropped 4×6 (or mapped shipping printer)  
5. **Print specs** — queues the specs sheet to the office/regular printer  

After a successful queue:

- Green **success** status (“Print queued successfully…”)
- Button locked ~**15 seconds** with countdown (`Print label (12s)`)
- Server also returns **429** cooldown for the same user/printer/PDF (`module/printers.js` `enqueuePrintJob`)

---

## Specs sheet (1 page)

`buildDetailsSheetPdf` layout (letter, single page):

- Header: SN + model  
- Cards (2×2): **Specs** | **MS Warranty** · **MS Case/Order** | **Tracking**  
- Issue strip  
- **Device history (compact)** — warranty snapshot, inbound/return TN, short MS milestones; points to History tab for the full timeline  

Warranty comes from `db/warrantyCache.json` (filled when a repair case is started) plus device fields.  
Lifecycle history uses `collectSerialHistory` (`module/device_lifecycle.js`) against in-memory `global.trackingData` / archived data.

API: `POST /api/repair-needed/print-ms-label` with `mode`: `label` | `sheet` | `queue` | `prepare` | `view-sheet`.

---

## Device Information — History tab

Restored in `html/index.html`:

```html
<button ... onclick="openTab(event, 'History_API_Local')">History</button>
...
<div id="History_API_Local" class="tabcontent tabcontent_API_Local"></div>
```

Overview link **Open full history timeline →** calls `openTab(null, 'History_API_Local')`.  
If that link “does nothing”, confirm both the button and the panel exist in **`html/index.html`** (not only in `html_index.html`).

---

## Related modules (source of truth on server)

| Module | Role |
|--------|------|
| `module/printers.js` | Printer registry, job queue, agent poll/complete, enqueue cooldown |
| `module/ms_label_print.js` | 4×6 crop + specs PDF |
| `module/warranty_repair.js` | Repair tickets + `print-ms-label` API |
| `module/device_lifecycle.js` | Tracking cycles / timeline events |
| `js/repair_needed.js` | Repair Needed UI |
| `js/model_ShowAPILocalDetails.js` | Device modal tabs (Overview, History, Print, …) |
| `Downloads/OrderAssistPrint/` | Portable Windows agent kit |

`db/` and `account/` stay **out of git** (credentials + live data).

## Return shipping label = source of truth (outbound)

For **same-unit repair**, Microsoft’s return-label PDF includes **Order**, **SN**, and **UPS tracking** (outbound: you → MS).
Prefer OCR/`extractShippingLabelIds` from that PDF over email-body parsing when filling `msOrderNumber`, `outboundTracking`, and label metadata.
**Case ID is not on the label** — it still comes from email `TrackingID` / case fields.
Inbound tracking (MS → you) comes from “service order has been shipped/delivered” emails, not the return label.
