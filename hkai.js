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

  // Open notes on OK/maintenance karts too (so nothing is hidden), briefer
  const otherNoted = karts.filter(k => !k.long_term && k.status !== 'damaged' && (notesByKart[k.rf_id] || []).length);
  if (otherNoted.length){
    S.push(`OTHER KARTS WITH OPEN NOTES (${otherNoted.length}, status OK/maintenance):`);
    S.push(otherNoted.map(k => `Kart ${k.name} [${statusOf(k)}]: ${(notesByKart[k.rf_id] || []).map(n => `"${String(n.note).replace(/\s+/g, ' ').trim()}"`).join('; ')}`).join('\n'));
  }
  S.push(`NOTE TOTALS: ${notes.length} open notes across ${Object.keys(notesByKart).length} karts; ${outKarts.length} karts are DAMAGED or LONG-TERM.`);
  const byName = {}; karts.forEach(k => { byName[String(k.name)] = k; });

  // Recent repairs (14 days) + full history for any kart the question names
  const since14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const recent = await q('rf_repairs', b => b.select('kart_name,kart_type,date_discovered,date_repaired,mechanic,description').or(`date_repaired.gte.${since14},date_discovered.gte.${since14}`).order('id', { ascending: false }).limit(150));
  if (recent.length){
    S.push('REPAIRS — LAST 14 DAYS (kart / date / mechanic / what):');
    S.push(recent.map(r => `Kart ${r.kart_name} ${r.date_repaired || r.date_discovered || ''} ${r.mechanic || '?'}: ${String(r.description || '').slice(0, 110)}`).join('\n'));
  }
  const asked = kartNumsIn(question);
  for (const num of asked.slice(0, 3)){
    const hist = await q('rf_repairs', b => b.select('date_discovered,date_repaired,mechanic,description').eq('kart_name', String(num)).order('id', { ascending: false }).limit(80));
    if (hist.length){
      S.push(`FULL REPAIR HISTORY — KART ${num} (newest first):`);
      S.push(hist.map(r => `${r.date_repaired || r.date_discovered || '?'} ${r.mechanic || '?'}: ${String(r.description || '').slice(0, 130)}`).join('\n'));
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

    const system = `You are HK AI, the Hyper Karting Sydney workshop assistant, answering questions for staff inside the HK Workshop app. Answer ONLY from the CONTEXT below — it is live data from the workshop's systems (RaceFacer, RiMO, the app's own tables). If the context doesn't contain the answer, say so plainly and say what data would be needed; never invent karts, repairs, people, sessions or readings.

COUNTING & COMPLETENESS RULES (important — do not undercount):
- For "how many karts" questions, count EVERY matching kart in the OUT-OF-ACTION KARTS list (and OTHER KARTS WITH OPEN NOTES if relevant). Read the WHOLE list to the end before answering — do not stop early or summarise a subset.
- A kart is "out of action" if its status is DAMAGED or LONG-TERM. Treat both as out of action unless the user asks for one specifically.
- For "karts with a WiFi chip / CPU issue" (or any issue type), scan the notes text of every OUT-OF-ACTION kart for that topic and count all matches. WiFi-chip and CPU/motherboard wording ("wifi chip", "wifi stack", "cpu", "motherboard", "no lap times", "both LEDs") often describe the same class of fault — include them all.
- If a kart appears in the OUT-OF-ACTION list with "notes: none", it is still DAMAGED/LONG-TERM — its status counts even without a note. Only say "no notes" about the NOTES, never imply the kart is fine.
- When giving a count, state the number first, then list the karts. Re-check your list length matches your stated count.

Be concise and direct — a busy mechanic is reading on a phone. Use Sydney time. Cell names are L1–L8 (left) and R1–R8 (right); a healthy cell sits ~3.2–3.6V, a dead/sagging cell drops well below the others under load. You are read-only: you cannot change anything, only answer.

CONTEXT:
${context}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system, messages }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.content){
      const msg = (j && j.error && j.error.message) || `API error ${r.status}`;
      await finish({ status: 'error', error: String(msg).slice(0, 300) });
      return;
    }
    const answer = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim() || '(no answer)';
    const tin = (j.usage && j.usage.input_tokens) || 0, tout = (j.usage && j.usage.output_tokens) || 0;
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
    console.log(`[ai] #${row.id} answered (${tin}in/${tout}out, ~$${COST(tin, tout).toFixed(4)}) — "${String(row.question).slice(0, 60)}"`);
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
