/* HK Workshop — HK AI (hkai.js)
 * -----------------------------
 * Read-only Q&A over the whole app's data. The app inserts a question into ai_queue;
 * this module (realtime + poll fallback) gathers the relevant slices from Supabase,
 * calls the Anthropic API, and writes the answer back. The API key lives ONLY here
 * (Render env), never in the app.
 *
 * Env:
 *   ANTHROPIC_API_KEY     (required — AI disabled without it)
 *   AI_MODEL              default 'claude-sonnet-4-6'
 *   AI_MAX_TOKENS         default 1200 (answer length)
 *   AI_MONTHLY_CAP_USD    default 20 — questions pause when the month's estimate hits this
 *   AI=off                kill switch
 *
 * Read-only by design: it SELECTs from Supabase and never writes to RaceFacer/RiMO.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

const SB_URL = process.env.SUPABASE_URL || process.env.SB_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SB_SERVICE_KEY;
const supa = (SB_URL && SB_KEY) ? createClient(SB_URL, SB_KEY, { auth: { persistSession: false } }) : null;

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = Math.max(256, parseInt(process.env.AI_MAX_TOKENS || '2000', 10));
const CAP_USD = Math.max(1, parseFloat(process.env.AI_MONTHLY_CAP_USD || '20'));
// Sonnet pricing: $3/M input, $15/M output
const COST = (tin, tout) => tin * 3e-6 + tout * 15e-6;

let _busy = false;

const TZ = 'Australia/Sydney';
function syd(iso){ if (!iso) return ''; try { return new Date(iso).toLocaleString('en-AU', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }); } catch (e){ return String(iso); } }
function sydT(iso){ if (!iso) return ''; try { return new Date(iso).toLocaleString('en-AU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }); } catch (e){ return String(iso); } }
const CELL_NAMES = ['L1','L2','L3','L4','L5','L6','L7','L8','R1','R2','R3','R4','R5','R6','R7','R8'];

/* ── context gathering ─────────────────────────────────────────────────── */
async function q(table, build){
  try { const { data, error } = await build(supa.from(table)); if (error) return []; return data || []; }
  catch (e){ return []; }
}

function kartNumsIn(text){
  const out = new Set(); let m;
  const re = /\bkarts?\s*#?\s*(\d{1,3})\b/gi;
  while ((m = re.exec(text))) out.add(parseInt(m[1], 10));
  return [...out];
}

async function gatherContext(row){
  const question = row.question || '';
  const site = row.site || 'sydney';
  const S = [];
  const nowIso = new Date().toISOString();
  S.push(`NOW: ${syd(nowIso)} (Sydney time). Site: ${site}.`);

  // Fleet — full list with status
  const karts = await q('rf_karts', b => b.select('rf_id,name,type,status,long_term').eq('site', site).limit(400));
  const byRf = {}; karts.forEach(k => { byRf[k.rf_id] = k; });
  const statusOf = k => k.long_term ? 'LONG-TERM' : (k.status === 'damaged' ? 'DAMAGED' : (k.status === 'maint' || k.status === 'for_maintenance' ? 'FOR-MAINTENANCE' : 'OK'));
  if (karts.length){
    S.push(`FLEET — ${karts.length} karts (number · type · status):`);
    S.push(karts.map(k => `${k.name} ${k.type || ''} ${statusOf(k)}`.trim()).join(' | '));
  }

  // ALL open kart notes (page past PostgREST's 1000-row cap so nothing is missed — this is what
  // makes "how many karts with a WiFi/CPU note" accurate rather than a capped guess).
  let notes = [];
  try {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const chunk = await q('rf_kart_notes', b => b.select('rf_kart_id,note,created_by,created_at').eq('active', true).order('created_at', { ascending: false }).range(from, from + PAGE - 1));
      if (!chunk.length) break; notes = notes.concat(chunk); if (chunk.length < PAGE) break;
    }
  } catch (e) {}
  const notesByKart = {};
  notes.forEach(n => { (notesByKart[n.rf_kart_id] = notesByKart[n.rf_kart_id] || []).push(n); });

  // OUT-OF-ACTION list: every DAMAGED or LONG-TERM kart, each WITH its open notes pre-attached.
  // This is the authoritative set for "how many karts are damaged / have X issue" questions —
  // the model should count from here, not reconstruct it from the fleet + notes fragments.
  const outKarts = karts.filter(k => k.long_term || k.status === 'damaged').sort((a, b) => (parseInt(a.name, 10) || 0) - (parseInt(b.name, 10) || 0));
  if (outKarts.length){
    S.push(`OUT-OF-ACTION KARTS — ${outKarts.length} total (DAMAGED or LONG-TERM). Each kart with its open notes. COUNT FROM THIS LIST for "how many" questions:`);
    S.push(outKarts.map(k => {
      const ns = (notesByKart[k.rf_id] || []).map(n => `"${String(n.note).replace(/\s+/g, ' ').trim()}" (${n.created_by || '?'}, ${syd(n.created_at)})`);
      return `Kart ${k.name} [${statusOf(k)}]${k.type ? ' ' + k.type : ''} — notes: ${ns.length ? ns.join('; ') : 'none'}`;
    }).join('\n'));
  }

  // ALL OTHER karts that have open notes — status-blind, so a note on an "OK" kart is never hidden
  // ("brakes feel soft" on a running kart still surfaces). Every open note in the fleet is visible here.
  const otherNoted = karts.filter(k => !k.long_term && k.status !== 'damaged' && (notesByKart[k.rf_id] || []).length);
  if (otherNoted.length){
    S.push(`OTHER KARTS WITH OPEN NOTES (${otherNoted.length} — these karts are OK/maintenance but HAVE notes; do not ignore):`);
    S.push(otherNoted.map(k => `Kart ${k.name} [${statusOf(k)}]: ${(notesByKart[k.rf_id] || []).map(n => `"${String(n.note).replace(/\s+/g, ' ').trim()}" (${n.created_by || '?'}, ${syd(n.created_at)})`).join('; ')}`).join('\n'));
  }
  S.push(`NOTE TOTALS: ${notes.length} open notes across ${Object.keys(notesByKart).length} karts; ${outKarts.length} karts are DAMAGED or LONG-TERM. Every OPEN note in the fleet is listed above regardless of kart status. For resolved/older notes on a kart, call kart_status.`);
  const byName = {}; karts.forEach(k => { byName[String(k.name)] = k; });

  // Recent repairs (14 days) + full history for any kart the question names
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const recent = await q('rf_repairs', b => b.select('kart_name,kart_type,date_discovered,date_repaired,mechanic,description').or(`date_repaired.gte.${since14},date_discovered.gte.${since14}`).order('id', { ascending: false }).limit(150));
  if (recent.length){
    S.push('REPAIRS — LAST 14 DAYS (kart / date / mechanic / what):');
    S.push(recent.map(r => `Kart ${r.kart_name}${r.kart_type ? ' [' + r.kart_type + ']' : ''} ${r.date_repaired || r.date_discovered || ''} ${r.mechanic || '?'}: ${String(r.description || '').slice(0, 110)}`).join('\n'));
  }
  const asked = kartNumsIn(question);
  for (const num of asked.slice(0, 3)){
    const hist = await q('rf_repairs', b => b.select('kart_type,date_discovered,date_repaired,mechanic,description').eq('kart_name', String(num)).order('id', { ascending: false }).limit(80));
    if (hist.length){
      const types = [...new Set(hist.map(r => r.kart_type).filter(Boolean))];
      // A number is shared across tracks — label each line with its track and warn if more than one track
      // is present, so the model isolates the right kart instead of merging Junior/Adult/etc.
      S.push(`REPAIR HISTORY — KART ${num}${types.length > 1 ? ` (⚠ shared across ${types.length} tracks: ${types.join(', ')} — these are DIFFERENT karts; filter by the track the user asked about)` : (types[0] ? ` [${types[0]}]` : '')} (newest first):`);
      S.push(hist.map(r => `${r.kart_type ? r.kart_type + ' · ' : ''}${r.date_repaired || r.date_discovered || '?'} ${r.mechanic || '?'}: ${String(r.description || '').slice(0, 130)}`).join('\n'));
    }
  }

  // Live RiMO
  const rimo = await q('rimo_karts', b => b.select('kart_no,online,soc,bms_ok,speedset,preset').eq('group_name', 'Moore Park').limit(300));
  if (rimo.length){
    const on = rimo.filter(r => r.online);
    S.push(`RIMO LIVE: ${on.length}/${rimo.length} online. Online karts (no·soc%): ${on.map(r => `${r.kart_no}·${r.soc != null ? r.soc : '?'}%`).join(', ') || 'none'}.`);
    const low = rimo.filter(r => r.online && r.soc != null && r.soc < 30);
    if (low.length) S.push(`LOW BATTERY (<30%): ${low.map(r => `kart ${r.kart_no} ${r.soc}%`).join(', ')}`);
  }

  // Sessions — last 7 days (label matching happens model-side; we hand it the list)
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const sess = await q('rf_sessions', b => b.select('uuid,label,status,track,scheduled_at,ends_at').gte('scheduled_at', since7).order('scheduled_at', { ascending: false }).limit(60));
  let sessRuns = [];
  if (sess.length){
    sessRuns = await q('rf_session_runs', b => b.select('session_uuid,client_name,kart_no,fleet_management_id,total_laps,best_lap').in('session_uuid', sess.map(s => s.uuid)).limit(600));
    const runsBy = {}; sessRuns.forEach(r => { (runsBy[r.session_uuid] = runsBy[r.session_uuid] || []).push(r); });
    S.push('SESSIONS — LAST 7 DAYS (label / track / start / status / karts+drivers):');
    S.push(sess.map(s => {
      const rr = (runsBy[s.uuid] || []).map(r => `K${r.kart_no} ${r.client_name}${r.total_laps ? ' ' + r.total_laps + 'laps' : ''}${r.best_lap ? ' best ' + r.best_lap : ''}`).join('; ');
      return `${s.label} · ${s.track} · ${syd(s.scheduled_at)}–${sydT(s.ends_at)} · ${s.status} · [${rr || 'no karts'}]`;
    }).join('\n'));
  }

  // BMS cell history — only when the question smells like battery/cells/a session+kart moment
  if (/cell|battery|volt|bms|soc|died|dead|sag|drain/i.test(question) && asked.length){
    const target = await resolveBmsTarget(question, asked[0], sess, sessRuns);
    if (target){
      const rows = await q('rimo_bms_history', b => {
        let bb = b.select('at,soc,pack_v,avg_v,current_a,cells,faults').gte('at', target.from).lte('at', target.to).order('at', { ascending: true }).limit(2000);
        return target.serial ? bb.eq('serial_no', target.serial) : bb.eq('kart_no', target.kart);
      });
      if (rows.length){
        S.push(`BMS CELL HISTORY — KART ${target.kart} · ${syd(target.from)} → ${sydT(target.to)} (${rows.length} samples${target.label ? ' · session "' + target.label + '"' : ''}). Cells L1–L8, R1–R8.`);
        S.push(bmsAnalysis(rows));
      } else {
        S.push(`BMS CELL HISTORY: no logged samples for kart ${target.kart} in ${syd(target.from)}–${sydT(target.to)}. (History logs while a kart is in a session, kept 7 days — the logger may not have been running then.)`);
      }
    }
  }

  // Open tasks + low stock (breadth)
  const tasks = await q('tasks', b => b.select('title,assignee,assignees,status,due_date,due_at').eq('site', site).neq('status', 'done').limit(30));
  if (tasks.length) S.push('OPEN TASKS: ' + tasks.map(t => `${t.title} (${(Array.isArray(t.assignees) && t.assignees.join('/')) || t.assignee || 'unassigned'}${t.due_date || t.due_at ? ', due ' + (t.due_date || t.due_at) : ''})`).join(' | '));
  const low = await q('parts', b => b.select('sku,desc,qty,reorder').limit(1000));
  const lows = low.filter(p => Number(p.qty) <= Number(p.reorder || 0)).slice(0, 30);
  if (lows.length) S.push('LOW STOCK (at/below reorder): ' + lows.map(p => `${p.desc || p.sku} (${p.qty})`).join(', '));

  return S.join('\n\n');
}

/* Find the time window + kart serial for a cell-history question. Session label first
   ("10:00", "5pm race"), else a bare time today/yesterday, else the last 2 hours. */
async function resolveBmsTarget(question, kartNum, sess, sessRuns){
  const ql = question.toLowerCase();
  const yday = /yesterday/.test(ql);
  let win = null, label = '', serial = null;
  const tm = ql.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  // 1) match a session by label containing the mentioned time, on the right day, ideally containing this kart
  if (tm && sess && sess.length){
    const hh = tm[1], mm = tm[2] || '00';
    const dayStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - (yday ? 86400000 : 0)));
    const cands = sess.filter(s => {
      if (!s.scheduled_at) return false;
      const d = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(s.scheduled_at));
      if (d !== dayStr) return false;
      const lbl = (s.label || '').toLowerCase();
      return lbl.includes(`${hh}:${mm}`) || (mm === '00' && (lbl.includes(`${hh}:00`) || lbl.startsWith(`${hh}`) || lbl.includes(`${hh}${tm[3] || ''}`)));
    });
    let pick = cands.find(s => (sessRuns || []).some(r => r.session_uuid === s.uuid && String(r.kart_no) === String(kartNum))) || cands[0];
    if (pick){
      win = { from: pick.scheduled_at, to: pick.ends_at || new Date(Date.parse(pick.scheduled_at) + 15 * 60000).toISOString() };
      label = pick.label;
      const run = (sessRuns || []).find(r => r.session_uuid === pick.uuid && String(r.kart_no) === String(kartNum));
      if (run && run.fleet_management_id) serial = run.fleet_management_id;
    }
    // 2) bare clock time (no matching session): ±20 min around it on that day, both am/pm guesses if unspecified
    if (!win){
      const mk = (h) => {
        const base = new Date(); if (yday) base.setDate(base.getDate() - 1);
        const ds = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(base);
        const guess = Date.parse(`${ds}T${String(h).padStart(2, '0')}:${mm}:00+10:00`);
        return isNaN(guess) ? null : guess;
      };
      let h = parseInt(hh, 10);
      if (tm[3] === 'pm' && h < 12) h += 12; if (tm[3] === 'am' && h === 12) h = 0;
      const t = mk(h);
      if (t) win = { from: new Date(t - 20 * 60000).toISOString(), to: new Date(t + 25 * 60000).toISOString() };
    }
  }
  if (!win) win = { from: new Date(Date.now() - 2 * 3600000).toISOString(), to: new Date().toISOString() };
  // Serial fallback: the kart's live RiMO row
  if (!serial){
    const rk = await q('rimo_karts', b => b.select('serial_no,online').eq('kart_no', kartNum).limit(5));
    const best = rk.find(r => r.online) || rk[0];
    if (best) serial = best.serial_no;
  }
  return { kart: kartNum, serial, from: win.from, to: win.to, label };
}

/* Turn raw samples into a compact per-cell analysis + a few timeline points. */
function bmsAnalysis(rows){
  const per = CELL_NAMES.map(() => ({ min: Infinity, max: -Infinity, first: null, last: null, minAt: null }));
  for (const r of rows){
    const cells = Array.isArray(r.cells) ? r.cells : [];
    cells.forEach((v, i) => {
      if (v == null || i > 15) return; const p = per[i];
      if (p.first == null) p.first = v; p.last = v;
      if (v < p.min){ p.min = v; p.minAt = r.at; }
      if (v > p.max) p.max = v;
    });
  }
  const lines = per.map((p, i) => p.first == null ? null :
    `${CELL_NAMES[i]}: ${p.first.toFixed(3)}→${p.last.toFixed(3)}V (min ${p.min.toFixed(3)} @ ${sydT(p.minAt)}, drop ${(p.max - p.min).toFixed(3)}V)`
  ).filter(Boolean);
  // biggest sag first so the model sees the culprit immediately
  const ranked = per.map((p, i) => ({ i, drop: p.first == null ? -1 : p.max - p.min })).sort((a, b) => b.drop - a.drop);
  const worst = ranked[0] && ranked[0].drop >= 0 ? `WORST SAG: cell ${CELL_NAMES[ranked[0].i]} (drop ${ranked[0].drop.toFixed(3)}V)` : '';
  const faults = rows.filter(r => r.faults).slice(0, 6).map(r => `${sydT(r.at)}: ${JSON.stringify(r.faults)}`);
  const spar = Math.max(1, Math.floor(rows.length / 10));
  const timeline = rows.filter((_, i) => i % spar === 0 || i === rows.length - 1).map(r => `${sydT(r.at)} soc ${r.soc != null ? r.soc : '?'}% pack ${r.pack_v != null ? r.pack_v : '?'}V cur ${r.current_a != null ? r.current_a : '?'}A`);
  return [worst, 'PER CELL: ' + lines.join(' · '), faults.length ? 'FAULT FLAGS: ' + faults.join(' | ') : '', 'TIMELINE: ' + timeline.join(' | ')].filter(Boolean).join('\n');
}

/* ── the answer path ───────────────────────────────────────────────────── */
/* ── TOOLS the AI can call on demand ────────────────────────────────────────
   The always-on context (fleet + out-of-action list) covers status questions cheaply.
   For anything deeper — repairs by a person, a date range, full history, session cell data —
   the model calls these tools and the runner runs the query. Repairs/notes/sessions return full
   history (text, cheap). BMS returns a SUMMARY, never thousands of raw rows (the Session Data
   screen is where raw 0.5s traces are browsed). */
const TOOLS = [
  { name: 'query_stock', description: 'Search parts/warehouse inventory. Filter by keyword (name/SKU), or low_only to get parts at/below their reorder level. Returns SKU, description, quantity on hand, reorder level, price and location. Use for "how many X do we have", "what\'s low on stock", "do we have brake pads".',
    input_schema: { type: 'object', properties: {
      keyword: { type: 'string', description: 'Word in the part name or SKU, e.g. "brake", "tyre", "chain"' },
      low_only: { type: 'boolean', description: 'Only parts at/below reorder level' },
    } } },
  { name: 'query_activity', description: 'Search the stock activity log (parts taken and restocked). Filter by staff member, part keyword/SKU, action (TAKEN or RESTOCK), and date range. Returns who did what, when, and quantity. Use for "who took the last set of tyres", "what did X take this week", "restocks in June".',
    input_schema: { type: 'object', properties: {
      staff: { type: 'string', description: 'Staff member name or part of it' },
      keyword: { type: 'string', description: 'Word in the part SKU/name' },
      action: { type: 'string', description: '"TAKEN" or "RESTOCK"' },
      from: { type: 'string', description: 'Start date YYYY-MM-DD' },
      to: { type: 'string', description: 'End date YYYY-MM-DD' },
    } } },
  { name: 'repair_parts', description: 'List the parts used in repairs for a given kart (and/or keyword). Returns each part name, quantity and price against its repair. Use for "what parts went into kart N\'s repairs", "how many X have we fitted".',
    input_schema: { type: 'object', properties: {
      kart_no: { type: 'string', description: 'Kart number' },
      track_type: { type: 'string', description: 'Track/kart type to disambiguate a number shared across tracks — e.g. "Junior", "Adult", "Mini", "Intermediate", "BattleKart". Kart numbers repeat across tracks; pass this whenever the user names a track.' },
      keyword: { type: 'string', description: 'Word in the part name' },
    } } },
  { name: 'staff_roster', description: 'The staff roster: names and roles. Use to answer "who works here", "who are the mechanics", or to resolve a first name to a full name.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'repair_leaderboard', description: 'All-time repair totals per mechanic (the workshop leaderboard). Returns each mechanic and their total repair count. Use for "who has done the most repairs", "how many repairs has X done all-time".',
    input_schema: { type: 'object', properties: {} } },
  { name: 'kart_status', description: 'Get the COMPLETE current picture for ONE kart: its status (OK/For-Maintenance/Damaged/Long-Term), ALL its notes newest-first (open and resolved), and its recent repairs. ALWAYS call this when the user asks about a specific kart\'s condition/state/issue — it is the authoritative source for "what\'s wrong with kart N" and "is kart N ok". The newest note is the current word on the kart.',
    input_schema: { type: 'object', properties: {
      kart_no: { type: 'string', description: 'Kart number, required' },
      track_type: { type: 'string', description: 'Track/kart type to disambiguate a number shared across tracks — e.g. "Junior", "Adult", "Mini", "Intermediate", "BattleKart". Kart numbers repeat across tracks; pass this whenever the user names a track.' },
    }, required: ['kart_no'] } },
  { name: 'query_repairs', description: 'Search repair records across ALL history. Filter by mechanic name, kart number, date range, and/or a keyword in the description. Returns the EXACT total match count (complete across all history) plus up to 300 example rows (newest first) with date, kart, mechanic and description — the count is exact even though only 300 lines are listed. Use for "how many repairs did X do", "repairs in <month>", cross-kart searches. For "most in a single day/week/month/year" or per-mechanic breakdowns use repair_stats. For one kart\'s full condition use kart_status instead.',
    input_schema: { type: 'object', properties: {
      mechanic: { type: 'string', description: 'Mechanic name or part of it (case-insensitive), e.g. "Jayden"' },
      kart_no: { type: 'string', description: 'Kart number, e.g. "43"' },
      track_type: { type: 'string', description: 'Track/kart type to disambiguate a number shared across tracks — e.g. "Junior", "Adult", "Mini", "Intermediate", "BattleKart". A kart NUMBER repeats across tracks (Junior 16, Adult 16, …), each a different physical kart; pass this whenever the user names a track so different karts are not merged.' },
      from: { type: 'string', description: 'Start date inclusive, YYYY-MM-DD' },
      to: { type: 'string', description: 'End date inclusive, YYYY-MM-DD' },
      keyword: { type: 'string', description: 'Word to find in the repair description, e.g. "tyre", "wifi", "brake"' },
      count_only: { type: 'boolean', description: 'If true, return just the total count (use for "how many")' },
    } } },
  { name: 'search_notes', description: 'Search kart notes (open by default) across the fleet by keyword and/or kart number. Returns matching notes with kart, text, author and date.',
    input_schema: { type: 'object', properties: {
      keyword: { type: 'string', description: 'Word to find in the note text, e.g. "wifi", "cpu", "tyre"' },
      kart_no: { type: 'string', description: 'Kart number' },
      include_archived: { type: 'boolean', description: 'Also search resolved/archived notes (default false)' },
    } } },
  { name: 'list_sessions', description: 'List recent sessions (last 7 days) with their time, track, status and the karts+drivers that were in each. Use to find a session before asking about its karts or cell data.',
    input_schema: { type: 'object', properties: {
      day: { type: 'string', description: '"today", "yesterday", or a date YYYY-MM-DD (optional)' },
      kart_no: { type: 'string', description: 'Only sessions that included this kart (optional)' },
    } } },
  { name: 'bms_session_summary', description: 'Battery/cell health SUMMARY for one kart in one session (or a time window). Returns per-cell first→last/min voltages, the worst-sagging cell, any fault flags, and a short SOC/pack timeline. Does NOT return every 0.5s row — for the full raw trace, tell the user to open the Session Data screen. Use for "which cell died", "was kart N\'s battery ok in the X session".',
    input_schema: { type: 'object', properties: {
      kart_no: { type: 'string', description: 'Kart number, required' },
      session_time: { type: 'string', description: 'Session label/time like "10:00" or "5pm" (optional if you give from/to)' },
      day: { type: 'string', description: '"today" or "yesterday" (default today)' },
      from: { type: 'string', description: 'ISO start of window (optional alternative to session_time)' },
      to: { type: 'string', description: 'ISO end of window (optional)' },
    }, required: ['kart_no'] } },
  { name: 'repair_stats', description: 'AGGREGATE repair counts across ALL history, bucketed by mechanic and by time period, computed server-side over every matching repair (not a 300-row sample). Use THIS — not query_repairs — for any "who did the MOST repairs in a single day / week / month / year", "busiest day/week", "record holder", or per-mechanic breakdown question. Returns the record holder for each period (day/week/month/year) plus every mechanic\'s total and their personal-best day/week/month/year. Optional mechanic filter and date range.',
    input_schema: { type: 'object', properties: {
      mechanic: { type: 'string', description: 'Limit to one mechanic (name or part of it), optional' },
      from: { type: 'string', description: 'Start date inclusive YYYY-MM-DD, optional' },
      to: { type: 'string', description: 'End date inclusive YYYY-MM-DD, optional' },
    } } },
];

async function pageAll(table, apply, cap){
  // page past PostgREST's 1000-row cap up to `cap` rows
  let out = [], from = 0; const PAGE = 1000;
  while (out.length < (cap || 20000)){
    const rows = await q(table, b => apply(b).range(from, from + PAGE - 1));
    if (!rows.length) break; out = out.concat(rows); if (rows.length < PAGE) break; from += PAGE;
  }
  return out;
}

async function runTool(name, args, site){
  args = args || {};
  if (name === 'query_stock'){
    const parts = await pageAll('parts', b => b.select('sku,desc,qty,min_stock,reorder,price,cost,category,loc,location'), 6000);
    let rows = parts;
    if (args.keyword){ const k = args.keyword.toLowerCase(); rows = rows.filter(p => (String(p.desc || '') + ' ' + String(p.sku || '') + ' ' + String(p.category || '')).toLowerCase().includes(k)); }
    const reorderOf = p => (p.reorder != null ? p.reorder : (p.min_stock != null ? p.min_stock : 0));
    if (args.low_only) rows = rows.filter(p => Number(p.qty) <= Number(reorderOf(p)));
    if (!rows.length) return 'No matching stock.';
    return `${rows.length} part(s):\n` + rows.slice(0, 200).map(p => `${p.desc || p.sku} (SKU ${p.sku}) — qty ${p.qty}${reorderOf(p) ? ', reorder ' + reorderOf(p) : ''}${(p.price || p.cost) ? ', $' + (p.price || p.cost) : ''}${(p.loc || p.location) ? ', @' + (p.loc || p.location) : ''}`).join('\n');
  }
  if (name === 'query_activity'){
    const logs = await pageAll('logs', b => {
      let bb = b.select('action,sku,qty,ts,staff_name,title,note,site').eq('site', site);
      if (args.action) bb = bb.eq('action', String(args.action).toUpperCase());
      return bb.order('ts', { ascending: false });
    }, 12000);
    let rows = logs;
    if (args.staff){ const s = args.staff.toLowerCase(); rows = rows.filter(l => String(l.staff_name || '').toLowerCase().includes(s)); }
    if (args.keyword){ const k = args.keyword.toLowerCase(); rows = rows.filter(l => (String(l.sku || '') + ' ' + String(l.title || '')).toLowerCase().includes(k)); }
    if (args.from) rows = rows.filter(l => (l.ts || '') >= args.from);
    if (args.to) rows = rows.filter(l => (l.ts || '') <= args.to + 'T23:59:59Z');
    if (!rows.length) return 'No matching activity.';
    return `${rows.length} log entr(y/ies):\n` + rows.slice(0, 200).map(l => `${syd(l.ts)} · ${l.action} · ${l.staff_name || '?'} · ${l.sku || l.title || ''}${l.qty ? ' ×' + l.qty : ''}`).join('\n');
  }
  if (name === 'repair_parts'){
    // repairs (filtered by kart) -> their parts
    let repIds = null;
    if (args.kart_no){
      const reps = await q('rf_repairs', b => {
        let bb = b.select('id').eq('kart_name', String(args.kart_no));
        if (args.track_type) bb = bb.ilike('kart_type', `%${String(args.track_type).trim()}%`);   // disambiguate a number shared across tracks
        return bb.limit(400);
      });
      repIds = reps.map(r => r.id);
      if (!repIds.length) return `No repairs found for kart ${args.kart_no}${args.track_type ? ' (' + args.track_type + ')' : ''}.`;
    }
    const parts = await pageAll('rf_repair_parts', b => {
      let bb = b.select('repair_id,part_name,qty,price');
      if (repIds) bb = bb.in('repair_id', repIds.slice(0, 300));
      return bb;
    }, 8000);
    let rows = parts;
    if (args.keyword){ const k = args.keyword.toLowerCase(); rows = rows.filter(p => String(p.part_name || '').toLowerCase().includes(k)); }
    if (!rows.length) return 'No matching repair parts.';
    // tally by part name
    const tally = {}; rows.forEach(p => { const nm = p.part_name || '?'; tally[nm] = (tally[nm] || 0) + (Number(p.qty) || 1); });
    const top = Object.keys(tally).sort((a, b) => tally[b] - tally[a]).slice(0, 40);
    return `${rows.length} part line(s)${args.kart_no ? ' for kart ' + args.kart_no : ''}. Totals by part:\n` + top.map(nm => `${nm}: ${tally[nm]}`).join('\n');
  }
  if (name === 'staff_roster'){
    const staff = await q('staff_public', b => b.select('name,role').order('name').limit(200));
    if (!staff.length) return 'No staff on record.';
    return 'STAFF:\n' + staff.map(s => `${s.name}${s.role ? ' — ' + s.role : ''}`).join('\n');
  }
  if (name === 'repair_leaderboard'){
    const tot = await q('repair_totals_public', b => b.select('name,total,last_at').order('total', { ascending: false }).limit(100));
    if (!tot.length) return 'No leaderboard data.';
    return 'ALL-TIME REPAIR TOTALS:\n' + tot.map(t => `${t.name}: ${t.total}${t.last_at ? ' (last ' + syd(t.last_at) + ')' : ''}`).join('\n');
  }
  if (name === 'kart_status'){
    if (!args.kart_no) return 'kart_no is required.';
    const kn = String(args.kart_no);
    let karts = await q('rf_karts', b => b.select('rf_id,name,type,status,long_term').eq('site', site).eq('name', kn).limit(8));
    if (!karts.length) return `No kart numbered ${kn} found for this site.`;
    // A number repeats across tracks (Junior 16, Adult 16, …), each a DIFFERENT physical kart. Narrow by
    // the requested track; if still ambiguous, ask which track rather than silently picking one.
    if (args.track_type){ const t = String(args.track_type).toLowerCase().trim(); const m = karts.filter(x => String(x.type || '').toLowerCase().includes(t)); if (m.length) karts = m; }
    if (karts.length > 1) return `Kart ${kn} exists on ${karts.length} tracks — ${karts.map(x => x.type || '?').join(', ')} — each a different physical kart with its own history. Which track do you mean? (pass track_type)`;
    const k = karts[0];
    const statusTxt = k.long_term ? 'LONG-TERM (out of active fleet)' : (k.status === 'damaged' ? 'DAMAGED' : (k.status === 'maint' || k.status === 'for_maintenance' ? 'FOR-MAINTENANCE' : 'OK'));
    // ALL notes for this kart, newest first (open + resolved), across all history
    const notes = await pageAll('rf_kart_notes', b => b.select('note,created_by,created_at,active').eq('rf_kart_id', k.rf_id).order('created_at', { ascending: false }), 2000);
    // recent repairs for THIS physical kart — keyed on rf_kart_id (exact), not the shared number
    const reps = await q('rf_repairs', b => b.select('date_discovered,date_repaired,mechanic,description').eq('rf_kart_id', k.rf_id).order('id', { ascending: false }).limit(40));
    let out = `KART ${kn} [${k.type || ''}] — STATUS: ${statusTxt}.\n`;
    if (notes.length){
      const open = notes.filter(n => n.active), closed = notes.filter(n => !n.active);
      out += `\nNEWEST NOTE (current word on this kart): "${String(notes[0].note).replace(/\s+/g, ' ').trim()}" — ${notes[0].created_by || '?'}, ${syd(notes[0].created_at)}${notes[0].active ? '' : ' [resolved]'}\n`;
      if (open.length){ out += `\nALL OPEN NOTES (${open.length}, newest first):\n` + open.map(n => `• ${syd(n.created_at)} — ${n.created_by || '?'}: "${String(n.note).replace(/\s+/g, ' ').trim()}"`).join('\n') + '\n'; }
      if (closed.length){ out += `\nRESOLVED NOTES (${closed.length}, newest first):\n` + closed.slice(0, 15).map(n => `• ${syd(n.created_at)} — ${n.created_by || '?'}: "${String(n.note).replace(/\s+/g, ' ').trim()}"`).join('\n') + '\n'; }
    } else { out += '\nNo notes on record for this kart.\n'; }
    if (reps.length){
      out += `\nRECENT REPAIRS (newest first):\n` + reps.slice(0, 20).map(r => `• ${r.date_repaired || r.date_discovered || '?'} — ${r.mechanic || '?'}: ${String(r.description || '').slice(0, 150)}`).join('\n');
    } else { out += '\nNo repairs on record for this kart.'; }
    return out;
  }
  if (name === 'query_repairs'){
    const rows = await pageAll('rf_repairs', b => {
      let bb = b.select('kart_name,kart_type,date_discovered,date_repaired,mechanic,description');
      if (args.mechanic) bb = bb.ilike('mechanic', `%${args.mechanic}%`);
      if (args.kart_no) bb = bb.eq('kart_name', String(args.kart_no));
      if (args.track_type) bb = bb.ilike('kart_type', `%${String(args.track_type).trim()}%`);   // disambiguate a number shared across tracks
      if (args.from) bb = bb.or(`date_repaired.gte.${args.from},date_discovered.gte.${args.from}`);
      if (args.to) bb = bb.or(`date_repaired.lte.${args.to},date_discovered.lte.${args.to}`);
      return bb.order('id', { ascending: false });
    }, 5000);
    let filtered = rows;
    if (args.keyword){ const k = args.keyword.toLowerCase(); filtered = rows.filter(r => String(r.description || '').toLowerCase().includes(k)); }
    if (args.from){ filtered = filtered.filter(r => (r.date_repaired || r.date_discovered || '') >= args.from); }
    if (args.to){ filtered = filtered.filter(r => (r.date_repaired || r.date_discovered || '9999') <= args.to); }
    if (args.count_only) return `COUNT: ${filtered.length} repair(s) match${args.kart_no && !args.track_type ? ` (kart ${args.kart_no} ACROSS ALL TRACKS — Junior/Adult/Mini/etc. combined; pass track_type to isolate one)` : ''}.`;
    // Show kart_type on every line so a number shared across tracks is never silently merged.
    const list = filtered.slice(0, 300).map(r => `${r.date_repaired || r.date_discovered || '?'} · Kart ${r.kart_name}${r.kart_type ? ' [' + r.kart_type + ']' : ''} · ${r.mechanic || '?'}: ${String(r.description || '').slice(0, 140)}`);
    const ambig = args.kart_no && !args.track_type ? [...new Set(filtered.map(r => r.kart_type).filter(Boolean))] : [];
    const note = ambig.length > 1 ? `\nNOTE: kart ${args.kart_no} exists on ${ambig.length} tracks (${ambig.join(', ')}) — these are DIFFERENT physical karts. Re-call with track_type to isolate one, or break the answer down by track.` : '';
    return `${filtered.length} repair(s) match${filtered.length > 300 ? ' (showing first 300)' : ''}:\n` + list.join('\n') + note;
  }
  if (name === 'repair_stats'){
    // Aggregate the WHOLE repair history server-side so the model can answer "most repairs in a
    // single day/week/month/year" and per-mechanic breakdowns accurately (query_repairs only
    // shows a 300-row sample). Fetch just date + mechanic (compact) across all matching rows.
    const rows = await pageAll('rf_repairs', b => {
      let bb = b.select('date_repaired,date_discovered,mechanic');
      if (args.mechanic) bb = bb.ilike('mechanic', `%${args.mechanic}%`);
      if (args.from) bb = bb.or(`date_repaired.gte.${args.from},date_discovered.gte.${args.from}`);
      if (args.to) bb = bb.or(`date_repaired.lte.${args.to},date_discovered.lte.${args.to}`);
      return bb.order('id', { ascending: false });
    }, 60000);
    const isoWeek = (dateStr) => {
      const d = new Date(dateStr + 'T00:00:00Z');
      const dayNum = (d.getUTCDay() + 6) % 7;                 // Mon=0..Sun=6
      d.setUTCDate(d.getUTCDate() - dayNum + 3);              // Thursday of this week
      const ft = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
      ft.setUTCDate(ft.getUTCDate() - ((ft.getUTCDay() + 6) % 7) + 3);
      const week = 1 + Math.round((d - ft) / (7 * 86400000));
      return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
    };
    const M = {};   // mechanic -> { total, day{}, week{}, month{}, year{} }
    let counted = 0;
    for (const r of rows){
      const date = String(r.date_repaired || r.date_discovered || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (args.from && date < args.from) continue;
      if (args.to && date > args.to) continue;
      const mech = (String(r.mechanic || '').trim()) || 'Unknown';
      const m = M[mech] || (M[mech] = { total: 0, day: {}, week: {}, month: {}, year: {} });
      m.total++; counted++;
      m.day[date] = (m.day[date] || 0) + 1;
      const wk = isoWeek(date); m.week[wk] = (m.week[wk] || 0) + 1;
      const mo = date.slice(0, 7); m.month[mo] = (m.month[mo] || 0) + 1;
      const yr = date.slice(0, 4); m.year[yr] = (m.year[yr] || 0) + 1;
    }
    if (!counted) return 'No dated repairs matched.';
    const bestOf = (obj) => { let k = null, v = 0; for (const kk in obj) if (obj[kk] > v){ v = obj[kk]; k = kk; } return k ? { k, v } : null; };
    const globalBest = (period) => { let who = null, bucket = null, cnt = 0; for (const mech in M){ const b = bestOf(M[mech][period]); if (b && b.v > cnt){ cnt = b.v; who = mech; bucket = b.k; } } return who ? { who, bucket, cnt } : null; };
    const line = (label, g) => `  ${label}: ${g ? `${g.who} — ${g.cnt} (${g.bucket})` : 'no data'}`;
    let out = `Repair stats over ${counted} dated repair(s)${args.mechanic ? ` for "${args.mechanic}"` : ''}${(args.from || args.to) ? ` [${args.from || '…'} → ${args.to || '…'}]` : ''}.\n`;
    out += `\nRecord holders — most repairs in a single…\n`;
    out += line('Day', globalBest('day')) + '\n';
    out += line('Week (ISO Mon–Sun)', globalBest('week')) + '\n';
    out += line('Month', globalBest('month')) + '\n';
    out += line('Year', globalBest('year')) + '\n';
    const mechs = Object.keys(M).sort((a, b) => M[b].total - M[a].total);
    out += `\nPer mechanic (total · best day · best week · best month · best year):\n`;
    for (const mech of mechs.slice(0, 14)){
      const m = M[mech], bd = bestOf(m.day), bw = bestOf(m.week), bm = bestOf(m.month), by = bestOf(m.year);
      out += `  ${mech}: ${m.total} · ${bd ? bd.v + ' (' + bd.k + ')' : '-'} · ${bw ? bw.v + ' (' + bw.k + ')' : '-'} · ${bm ? bm.v + ' (' + bm.k + ')' : '-'} · ${by ? by.v + ' (' + by.k + ')' : '-'}\n`;
    }
    return out;
  }
  if (name === 'search_notes'){
    const rows = await pageAll('rf_kart_notes', b => {
      let bb = b.select('rf_kart_id,note,created_by,created_at,active');
      if (!args.include_archived) bb = bb.eq('active', true);
      return bb.order('created_at', { ascending: false });
    }, 8000);
    // map kart id -> number
    const karts = await q('rf_karts', b => b.select('rf_id,name').eq('site', site).limit(400));
    const numOf = {}; karts.forEach(k => { numOf[k.rf_id] = k.name; });
    let filtered = rows;
    if (args.kart_no) filtered = filtered.filter(r => String(numOf[r.rf_kart_id]) === String(args.kart_no));
    if (args.keyword){ const k = args.keyword.toLowerCase(); filtered = filtered.filter(r => String(r.note || '').toLowerCase().includes(k)); }
    if (!filtered.length) return 'No matching notes.';
    return `${filtered.length} note(s) match:\n` + filtered.slice(0, 200).map(r => `Kart ${numOf[r.rf_kart_id] || r.rf_kart_id}${r.active ? '' : ' [resolved]'}: "${String(r.note).replace(/\s+/g, ' ').trim()}" — ${r.created_by || '?'}, ${syd(r.created_at)}`).join('\n');
  }
  if (name === 'list_sessions'){
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    let sess = await q('rf_sessions', b => b.select('uuid,label,status,track,scheduled_at,ends_at').gte('scheduled_at', since).order('scheduled_at', { ascending: false }).limit(80));
    if (args.day === 'today' || args.day === 'yesterday'){
      const d = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - (args.day === 'yesterday' ? 86400000 : 0)));
      sess = sess.filter(s => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(s.scheduled_at)) === d);
    } else if (args.day && /^\d{4}-\d{2}-\d{2}$/.test(args.day)){
      sess = sess.filter(s => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(s.scheduled_at)) === args.day);
    }
    if (!sess.length) return 'No sessions found in that range.';
    const runs = await q('rf_session_runs', b => b.select('session_uuid,client_name,kart_no,total_laps,best_lap').in('session_uuid', sess.map(s => s.uuid)).limit(800));
    const by = {}; runs.forEach(r => { (by[r.session_uuid] = by[r.session_uuid] || []).push(r); });
    let list = sess;
    if (args.kart_no) list = sess.filter(s => (by[s.uuid] || []).some(r => String(r.kart_no) === String(args.kart_no)));
    return list.map(s => {
      const rr = (by[s.uuid] || []).map(r => `K${r.kart_no} ${r.client_name}`).join(', ');
      return `${s.label} · ${s.track} · ${syd(s.scheduled_at)}–${sydT(s.ends_at)} · ${s.status} · karts: ${rr || 'none'}`;
    }).join('\n');
  }
  if (name === 'bms_session_summary'){
    if (!args.kart_no) return 'kart_no is required.';
    // find sessions for the day, match by time, get window + serial
    const since = new Date(Date.now() - 8 * 86400000).toISOString();
    const sess = await q('rf_sessions', b => b.select('uuid,label,scheduled_at,ends_at').gte('scheduled_at', since).order('scheduled_at', { ascending: false }).limit(80));
    const sessRuns = sess.length ? await q('rf_session_runs', b => b.select('session_uuid,kart_no,fleet_management_id').in('session_uuid', sess.map(s => s.uuid)).limit(800)) : [];
    const q2 = `${args.session_time || ''} kart ${args.kart_no}`;
    let target;
    if (args.from) target = { kart: args.kart_no, serial: null, from: args.from, to: args.to || new Date().toISOString(), label: '' };
    else target = await resolveBmsTarget(q2, parseInt(args.kart_no, 10), sess, sessRuns);
    if (!target) return `Couldn't find a session matching that for kart ${args.kart_no}.`;
    const rows = await q('rimo_bms_history', b => {
      let bb = b.select('at,soc,pack_v,avg_v,current_a,cells,faults').gte('at', target.from).lte('at', target.to).order('at', { ascending: true }).limit(4000);
      return target.serial ? bb.eq('serial_no', target.serial) : bb.eq('kart_no', parseInt(args.kart_no, 10));
    });
    if (!rows.length) return `No BMS cell data logged for kart ${args.kart_no} in that window (${syd(target.from)}–${sydT(target.to)}). The logger records while a kart is in a session and keeps 7 days — there may be no session then, or the logger wasn't running.`;
    return `Kart ${args.kart_no}${target.label ? ' · session "' + target.label + '"' : ''} · ${syd(target.from)}–${sydT(target.to)} · ${rows.length} samples:\n` + bmsAnalysis(rows) + `\n(For the full 0.5s trace of every cell, open the Session Data screen.)`;
  }
  return 'Unknown tool.';
}

async function monthUsage(){
  const month = new Date().toISOString().slice(0, 7);
  try { const { data } = await supa.from('ai_usage').select('*').eq('month', month).limit(1); return (data && data[0]) || { month, questions: 0, tokens_in: 0, tokens_out: 0, est_cost_usd: 0 }; }
  catch (e){ return { month, questions: 0, tokens_in: 0, tokens_out: 0, est_cost_usd: 0 }; }
}

async function processRow(row){
  // claim it (guards against double-processing between realtime + poll)
  const { data: claimed } = await supa.from('ai_queue').update({ status: 'working' }).eq('id', row.id).eq('status', 'pending').select('id');
  if (!claimed || !claimed.length) return;

  const finish = (fields) => supa.from('ai_queue').update({ ...fields, answered_at: new Date().toISOString() }).eq('id', row.id);

  if (!API_KEY){ await finish({ status: 'error', error: 'ANTHROPIC_API_KEY is not set on the runner — add it in Render env vars.' }); return; }
  const usage = await monthUsage();
  if (usage.est_cost_usd >= CAP_USD){
    await finish({ status: 'done', answer: `HK AI has hit this month's budget cap ($${CAP_USD}). It resumes automatically on the 1st — or a manager can raise AI_MONTHLY_CAP_USD on Render.` });
    return;
  }

  try {
    const context = await gatherContext(row);
    // conversation memory: last few answered turns in this convo
    const { data: prior } = await supa.from('ai_queue').select('question,answer').eq('convo_id', row.convo_id || '').eq('status', 'done').lt('id', row.id).order('id', { ascending: false }).limit(4);
    const messages = [];
    (prior || []).reverse().forEach(p => { if (p.answer){ messages.push({ role: 'user', content: p.question }); messages.push({ role: 'assistant', content: p.answer }); } });
    messages.push({ role: 'user', content: row.question });

    const system = `You are HK AI, the Hyper Karting Sydney workshop assistant, answering questions for staff inside the HK Workshop app. You answer from live workshop data (RaceFacer, RiMO, the app's own tables).

You have an always-on snapshot below (fleet + ALL open kart notes regardless of status + out-of-action karts + live RiMO + low stock). For ANYTHING it doesn't cover, CALL A TOOL — you can reach essentially everything in the workshop's data:
- repairs (any person/kart/date/keyword, all history) → query_repairs
- one kart's full condition (status + all notes + repairs) → kart_status
- kart notes search (open or resolved, any keyword) → search_notes
- sessions and who was in them → list_sessions
- battery/cell health for a kart in a session → bms_session_summary
- parts & warehouse stock levels → query_stock
- stock activity log, who took/restocked what → query_activity
- parts used in a kart's repairs → repair_parts
- staff roster → staff_roster
- all-time repair leaderboard → repair_leaderboard
- repair COUNTS, records, busiest day/week/month/year, or per-mechanic breakdowns → repair_stats
Never answer "I don't have that data" without first trying the relevant tool. The tools cover ALL history.

RULES:
- Never invent karts, repairs, people, sessions or readings. If a tool returns nothing, say so plainly.
- When the question is about ONE specific kart's condition/state/issue/status ("what's wrong with kart N", "is kart N ok", "does kart N have a X problem"), you MUST call kart_status for that kart. Do not answer a single-kart condition question from the snapshot or from repairs alone.
- Kart NUMBERS repeat across track types: there is a Junior 16, an Adult 16, a Mini 16, etc. — each a DIFFERENT physical kart with its own repairs and notes. When the user names a track (Junior/Adult/Mini/Intermediate/BattleKart/Twin), ALWAYS pass track_type to kart_status / query_repairs / repair_parts so you isolate that one kart and never merge different karts' histories. If the user gives a number with NO track and the number exists on more than one track, do NOT combine them — say which tracks have that number and ask which one they mean (or break the answer down per track). kart_type is shown on repair lines and in the snapshot; use it.
- The NEWEST note is the current word on a kart. Lead with it. If the newest note says the kart was taken out of rotation / still faulty / not fixed, say that is the current status — even if an earlier repair said "tested fine". A later note about the same fault OVERRIDES an earlier "fixed" repair. Never conclude a kart is "running okay" if a more recent note contradicts it.
- For "how many" questions, use the tool (query_repairs with count_only, or search_notes) rather than eyeballing — then state the number, then list. query_repairs returns the EXACT total across all history (the count is complete even though only 300 example lines are shown), so never say a count is approximate or "capped" — the number is exact.
- For "who did the MOST in a single day / week / month / year", "busiest day", "record holder", or any per-mechanic time breakdown, call repair_stats (ONE call answers it precisely over the whole history). Do NOT try to reconstruct this by paging query_repairs date-by-date, and never give a "~approx" answer or an "I can't without iterating" caveat — repair_stats gives the exact figures.
- A kart is "out of action" if DAMAGED or LONG-TERM; treat both as out of action unless asked otherwise. A kart with no note is still out of action if its status says so — never imply it's fine.
- For battery/cell questions, bms_session_summary gives the diagnosis (worst-sagging cell etc.). For a full 0.5s trace of every cell, tell the user to open the Session Data screen — don't try to list thousands of readings.
- Be concise and direct — a busy mechanic is reading on a phone. Use Sydney time. Cells are L1–L8 (left) / R1–R8 (right); healthy ~3.2–3.6V, a dead cell sags well below the others under load. You are read-only.

WORKSHOP SHORTHAND — staff type fast, abbreviated and misspelt, in both the repairs/notes they write AND the questions they ask you. INTERPRET their shorthand and match LOOSELY: when you search (query_repairs/search_notes/query_stock/repair_parts), try the shorthand AND its full form, tolerate misspellings, and treat plural/singular as the same. If a search returns little, RETRY with the expanded (or abbreviated) term before concluding there's nothing.
- Positions: FR = front right, FL = front left, RR = rear right, RL = rear left, F = front, R = rear, N/S = nearside, O/S = offside.
- "sac" / "sacc" / "sacrificial" = sacrificial part (block/bearing/spacer).
- A bare size like "50" or "50mm" almost always means the 50mm silent block; "25" = 25mm silent block; "SB" = silent block. "bush"/"bushing" ~ silent block region too.
- Common terms: susp = suspension, brk/brakes = brake, trans/tpr = transponder, chg/charger = charger, batt = battery, str = steering, acc/accel/throttle = accelerator, brng/brg = bearing, wshr = washer, cbl = cable, pad(s) = brake pads, disc/rotor = brake disc.
- Numbers written next to a part are usually a size in mm; "x2/x3" is a quantity. Kart numbers are separate (a bare number ALONE, in a kart context, is a kart — use judgement from the sentence).
Example: "how many 50s went on FR this week" = repairs mentioning the 50mm silent block on the front-right this week — search "50", "50mm", "silent block" and read the annotations for FR/front right.

ALWAYS-ON SNAPSHOT:
${context}`;

    let tin = 0, tout = 0, answer = '', guard = 0;
    while (guard++ < 8){
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, tools: TOOLS, messages }),
        signal: AbortSignal.timeout(90000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !j.content){
        const msg = (j && j.error && j.error.message) || `API error ${r.status}`;
        await finish({ status: 'error', error: String(msg).slice(0, 300) });
        return;
      }
      tin += (j.usage && j.usage.input_tokens) || 0;
      tout += (j.usage && j.usage.output_tokens) || 0;
      answer = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      const toolUses = (j.content || []).filter(c => c.type === 'tool_use');
      if (!toolUses.length || j.stop_reason !== 'tool_use') break;   // done — no more tools requested
      // run each requested tool, feed results back
      messages.push({ role: 'assistant', content: j.content });
      const results = [];
      for (const tu of toolUses){
        let out;
        try { out = await runTool(tu.name, tu.input, row.site || 'sydney'); }
        catch (e){ out = `Tool error: ${(e.message || e)}`.slice(0, 300); }
        console.log(`[ai] #${row.id} tool ${tu.name}(${JSON.stringify(tu.input).slice(0, 80)}) -> ${String(out).length} chars`);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out).slice(0, 12000) });
      }
      messages.push({ role: 'user', content: results });
    }
    answer = answer || '(no answer)';
    await finish({ status: 'done', answer, tokens_in: tin, tokens_out: tout });
    // usage counter (read-modify-write is fine at this volume)
    const u = await monthUsage();
    await supa.from('ai_usage').upsert({
      month: u.month,
      questions: (u.questions || 0) + 1,
      tokens_in: (Number(u.tokens_in) || 0) + tin,
      tokens_out: (Number(u.tokens_out) || 0) + tout,
      est_cost_usd: Math.round(((Number(u.est_cost_usd) || 0) + COST(tin, tout)) * 10000) / 10000,
    }, { onConflict: 'month' });
    console.log(`[ai] #${row.id} answered (${tin}in/${tout}out, ~$${COST(tin, tout).toFixed(4)}, ${guard - 1} round(s)) — "${String(row.question).slice(0, 60)}"`);
  } catch (e){
    await finish({ status: 'error', error: String(e.message || e).slice(0, 300) });
    console.error('[ai]', e.message || e);
  }
}

async function drain(){
  if (_busy || !supa) return;
  _busy = true;
  try {
    const { data } = await supa.from('ai_queue').select('*').eq('status', 'pending').order('id', { ascending: true }).limit(5);
    for (const row of (data || [])) await processRow(row);
  } catch (e){} finally { _busy = false; }
}

function startAI(){
  if (!supa){ console.log('[ai] missing Supabase env — HK AI disabled'); return; }
  if (process.env.AI === 'off'){ console.log('[ai] AI=off — HK AI disabled'); return; }
  if (!API_KEY) console.log('[ai] WARNING: ANTHROPIC_API_KEY not set — questions will error until it is added.');
  try {
    supa.channel('ai-rt').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ai_queue' }, () => { drain(); }).subscribe();
  } catch (e){}
  setInterval(drain, 5000);   // poll fallback if realtime drops
  drain();
  console.log(`[ai] HK AI up — model ${MODEL}, cap $${CAP_USD}/month, max ${MAX_TOKENS} answer tokens`);
}

module.exports = { startAI };
