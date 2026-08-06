# MS email history thread

## Symptom this guards against
Repair Needed notification → **Email history** overlay stuck on **Loading emails…**.

## Cause
`GET /api/ms-email/thread` used to match every inbox record that shared the device **serial** (and stale **order** numbers). Devices with multiple warranty cycles could match **100+** stored `.eml` files. Each message was fully re-parsed, then pending drafts called `buildThreadForTicket` again — the UI never finished.

## Fix (keep these invariants)
1. **Active-case scope for display** — `buildThreadForTicket(ticket, { forDisplay: true })` matches with `recordMatchesTicket(..., { caseOnly: true })` using the ticket’s current `msCaseId` only (multi-device case emails still appear).
2. **Cap** — newest N messages (default 40) after filter.
3. **Cache** — in-memory `MESSAGE_VIEW_CACHE` keyed by uid + `.eml` mtime.
4. **No double build** — `/api/ms-email/thread` and draft refresh pass `threadMessages` into `enrichDraftWithEnvelope`.
5. **UI timeout** — `openEmailHistoryOverlay` aborts after 25s and shows an error instead of spinning forever.

## Key files
- `module/ms_email_replies.js` — thread API, matching, cache
- `js/repair_needed.js` — overlay + manage-sheet thread load

## Manual check
Open notification for a multi-cycle SN (e.g. `0F36FDJ24223HJ` / case `2608030040005591`). Overlay should show the current case’s messages within ~1s, not hang.
