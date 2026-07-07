# HK Workshop — RaceFacer runner

Pushes repairs & notes created in the app into RaceFacer.

## Files
- `index.js` — entry point (start with `npm start`)
- `rf_push_repairs.js` — login + queue drain + form submitters
- `package.json` / `.node-version` — pins Node 20

## Environment variables (set these on Render)
| Key | Value |
| --- | --- |
| `SUPABASE_URL` | `https://jnxdjzewfrcrexyscxul.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → **service_role** secret |
| `RF_BASE` | `https://103.166.146.163` (optional — this is the default) |
| `RF_USER` | `HKWS` (optional — default) |
| `RF_PASS` | `HKWS` (optional — default) |

No `npm install` dependencies — it uses built-in `fetch`/`https`.

## What it does
Every 45s it reads `rf_repair_queue` and `rf_note_queue` (pending rows) over
Supabase REST (free against the Realtime quota), logs into RaceFacer, and submits
the Add-damage / Add-note forms as the mechanic named on the row. Rows are marked
`sent` or `error` (with the reason) so you can watch progress in the table.
