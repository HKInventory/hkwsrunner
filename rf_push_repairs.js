/* ============================================================================
   HK Workshop — push app-created repairs & notes into RaceFacer
   Drop into the Render runner repo; call startRepairPusher(scrapeKartRepairs)
   once from your entry point. Polls Supabase over REST (FREE against the
   Realtime quota) and submits RaceFacer's forms AS THE MECHANIC.

   STATUS
   ✅ Login — real Laravel CSRF + session flow (creds HKWS/HKWS).
   ✅ Add note   -> POST /ajax/garage/notes/add   (exact fields, from your cURL)
   ✅ Add repair -> POST /ajax/garage/damage       (exact `damage=` blob + used_parts)
   ✅ user_id, kart_type_id, part_id are auto-read from the RaceFacer form page.
   ⚠️ If auto-read ever misses a name, fill the RF_USERS override map below.

   ENV (defaults baked in): RF_BASE=https://103.166.146.163  RF_USER=HKWS  RF_PASS=HKWS
        SUPABASE_URL, SUPABASE_SERVICE_KEY (required).  Node 18.14+.
   ============================================================================ */
const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false }); // self-signed cert on that IP

const RF_BASE = (process.env.RF_BASE || 'https://103.166.146.163').replace(/\/$/, '');
const RF_USER = process.env.RF_USER || 'HKWS';
const RF_PASS = process.env.RF_PASS || 'HKWS';
const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;

/* ---- status name -> RaceFacer id (from captures: repair used 1=ok) ---- */
const RF_STATUS_ID = { ok: 1, for_maintenance: 2, damaged: 3 };

/* ---- OPTIONAL manual override if a name ever fails to auto-match ----
   Fill from RaceFacer's User dropdown, e.g. { 'Harvey Betts': 92, 'Jayden Aginsky': 187 }
   Names are matched case-insensitively and the Aginsky/Aginskey spelling is handled. */
const RF_USERS = {
  // 'Harvey Betts': 92,
};

/* ---------------- cookie jar + helpers ---------------- */
let jar = {}, loggedIn = false;
function absorb(res){ const l = res.headers.getSetCookie ? res.headers.getSetCookie() : []; for (const sc of l){ const p = sc.split(';')[0], i = p.indexOf('='); if (i>0) jar[p.slice(0,i).trim()] = p.slice(i+1).trim(); } }
function cookieHeader(){ return Object.keys(jar).map(k => `${k}=${jar[k]}`).join('; '); }
function rfHeaders(extra={}){ return { Cookie: cookieHeader(), Origin: RF_BASE, 'User-Agent':'HKWorkshopBot/1.0', 'X-Requested-With':'XMLHttpRequest', ...extra }; }
const norm = s => String(s||'').toLowerCase().replace(/aginskey/g,'aginsky').replace(/[^a-z]/g,'');

async function sb(path, opts={}){
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers:{ apikey:SB_KEY, Authorization:`Bearer ${SB_KEY}`, 'Content-Type':'application/json', Prefer:'return=representation', ...(opts.headers||{}) } });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/* ---------------- login (WORKING) ---------------- */
async function rfLogin(){
  jar = {};
  const g = await fetch(`${RF_BASE}/en/auth/login`, { agent, redirect:'manual', headers:{ 'User-Agent':'HKWorkshopBot/1.0' } });
  absorb(g);
  const token = (await g.text()).match(/name="_token"[^>]*value="([^"]+)"/)?.[1] || '';
  const body = new URLSearchParams({ _token: token, pos_station_id:'', username: RF_USER, password: RF_PASS });
  const r = await fetch(`${RF_BASE}/en/auth/login`, { method:'POST', agent, redirect:'manual',
    headers: rfHeaders({ 'Content-Type':'application/x-www-form-urlencoded', Referer:`${RF_BASE}/en/auth/login` }), body });
  absorb(r);
  if (r.status === 200 && /login/i.test((await r.text()) || '')) throw new Error('login rejected — check RF_USER/RF_PASS');
  loggedIn = true;
  console.log('[rf-push] logged into RaceFacer OK');
}

/* ---------------- read the form page: _token, user map, part map, kart type ----------------
   The Add-damage page contains <select name="user_id">, the parts <select>, and the kart's
   type id. We parse them so we never hardcode ids. */
function parseOptions(html, selectNameRegex){
  const out = {};
  const sel = html.match(new RegExp(`<select[^>]*${selectNameRegex}[^>]*>([\\s\\S]*?)</select>`, 'i'));
  if (!sel) return out;
  const re = /<option[^>]*value="(\d+)"[^>]*>([\s\S]*?)<\/option>/gi; let m;
  while ((m = re.exec(sel[1]))) out[norm(m[2].replace(/<[^>]+>/g,'').trim())] = { id: Number(m[1]), label: m[2].replace(/<[^>]+>/g,'').trim() };
  return out;
}
async function formContext(kartId){
  const url = `${RF_BASE}/en/administration/garage/damage?kart_id=${kartId}`;
  const r = await fetch(url, { agent, headers: rfHeaders({ Referer: url }), redirect:'manual' });
  absorb(r);
  if (r.status === 302 || /login/i.test(r.headers.get('location')||'')) { loggedIn = false; throw new Error('session expired'); }
  const html = await r.text();
  const token = html.match(/name="_token"[^>]*value="([^"]+)"/)?.[1] || html.match(/csrf-token"[^>]*content="([^"]+)"/)?.[1] || '';
  const users = parseOptions(html, 'name="user_id"');
  // parts: <select> whose options carry data-* for id / part_id / max_qty / price
  const parts = {};
  const psel = html.match(/<select[^>]*(?:used_parts|part)[^>]*>([\s\S]*?)<\/select>/i);
  if (psel){ const re = /<option([^>]*)>([\s\S]*?)<\/option>/gi; let m; while ((m = re.exec(psel[1]))){ const a = m[1];
    const g = n => (a.match(new RegExp(n+'="([^"]+)"','i'))||[])[1];
    const pid = g('data-part[_-]?id') || g('value'); if (!pid) continue;
    parts[norm(m[2].replace(/<[^>]+>/g,'').trim())] = { part_id:Number(pid), id:Number(g('data-id')||pid), max_qty:Number(g('data-max[_-]?qty')||99), price:Number(g('data-price')||0), label:m[2].replace(/<[^>]+>/g,'').trim() }; } }
  const kart_type_id = Number(html.match(/kart_type_id["']?\s*[:=]\s*["']?(\d+)/i)?.[1] || html.match(/name="kart_type"[^>]*value="(\d+)"/i)?.[1] || 0);
  return { token, users, parts, kart_type_id };
}
function resolveUser(name, users){
  const key = norm(name);
  for (const n in RF_USERS) if (norm(n) === key) return RF_USERS[n];   // manual override wins
  if (users[key]) return users[key].id;
  for (const k in users) if (k.includes(key) || key.includes(k)) return users[k].id; // loose match
  return null;
}
function resolvePart(p, parts){
  const byName = parts[norm(p.name)];
  if (byName) return byName;
  for (const k in parts) if (p.name && (k.includes(norm(p.name)) || norm(p.name).includes(k))) return parts[k];
  return null; // unknown part -> skipped (repair still submits)
}

/* ---------------- submit: NOTE ---------------- */
async function rfCreateNote(row){
  const ctx = await formContext(row.rf_kart_id);
  const user_id = resolveUser(row.user_name, ctx.users);
  if (!user_id) throw new Error(`no RaceFacer user_id for "${row.user_name}" — add to RF_USERS`);
  const body = new URLSearchParams({
    url: `${RF_BASE}/en/administration/garage/garage?kart_id=${row.rf_kart_id}`,
    status_change: '1',
    kart_status_id: String(RF_STATUS_ID[row.rf_status] || 1),
    kart_note_id: '',
    kart_type: String(ctx.kart_type_id || ''),
    kart_id: String(row.rf_kart_id),
    message: row.note || '',
    user_id: String(user_id)
  });
  const r = await fetch(`${RF_BASE}/ajax/garage/notes/add`, { method:'POST', agent, redirect:'manual',
    headers: rfHeaders({ 'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
      Referer:`${RF_BASE}/en/administration/garage/garage?kart_id=${row.rf_kart_id}&action=maintenances` }), body });
  absorb(r);
  if (r.status===401 || /login/i.test(r.headers.get('location')||'')) { loggedIn=false; throw new Error('session expired'); }
  if (r.status>=400) throw new Error(`notes/add: ${r.status} ${await r.text().catch(()=> '')}`);
}

/* ---------------- submit: REPAIR / DAMAGE ---------------- */
async function rfCreateDamage(row){
  const ctx = await formContext(row.rf_kart_id);
  const user_id = resolveUser(row.user_name, ctx.users);
  if (!user_id) throw new Error(`no RaceFacer user_id for "${row.user_name}" — add to RF_USERS`);
  // inner blob (exactly the fields from your capture, in the same shape)
  const inner = new URLSearchParams({
    notification_id: String(row.notification_id || ''),   // app repairs are standalone -> empty
    kart_id: String(row.rf_kart_id),
    damage_discovery_date: row.date_discovered || '',
    repair_date: row.date_repaired || '',
    hours_spent: String(parseFloat(row.working_hours) || 0),
    kart_status_id: String(RF_STATUS_ID[row.rf_status] || 1),
    user_id: String(user_id),
    annotation: row.note || '',
    repair_km: String(row.repair_km || 0),
    _token: ctx.token
  }).toString();
  const body = new URLSearchParams();
  body.set('damage', inner);
  (row.parts || []).forEach((p, i) => {
    const rp = resolvePart(p, ctx.parts);
    if (!rp) return; // skip unmapped parts rather than fail the whole repair
    body.append(`used_parts[${i}][id]`, String(rp.id));
    body.append(`used_parts[${i}][price]`, String(p.price != null ? p.price : rp.price));
    body.append(`used_parts[${i}][qty]`, String(p.qty || 1));
    body.append(`used_parts[${i}][part_id]`, String(rp.part_id));
    body.append(`used_parts[${i}][max_qty]`, String(rp.max_qty || 99));
  });
  const r = await fetch(`${RF_BASE}/ajax/garage/damage`, { method:'POST', agent, redirect:'manual',
    headers: rfHeaders({ 'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
      'X-CSRF-Token': ctx.token,
      Referer:`${RF_BASE}/en/administration/garage/damage?kart_id=${row.rf_kart_id}&referer=repairs` }), body });
  absorb(r);
  if (r.status===401 || /login/i.test(r.headers.get('location')||'')) { loggedIn=false; throw new Error('session expired'); }
  if (r.status>=400) throw new Error(`garage/damage: ${r.status} ${await r.text().catch(()=> '')}`);
}

/* ---------------- queue drain ---------------- */
async function drain(table, submit, scrapeKartRepairs){
  const rows = await sb(`${table}?status=eq.pending&order=id.asc&limit=10`);
  if (!rows.length) return;
  if (!loggedIn) await rfLogin();
  for (const row of rows){
    try {
      await submit(row);
      if (typeof scrapeKartRepairs === 'function') await scrapeKartRepairs(row.rf_kart_id); // land real id, no dupes
      await sb(`${table}?id=eq.${row.id}`, { method:'PATCH', body: JSON.stringify({ status:'sent', sent_at:new Date().toISOString(), error:null }) });
      console.log(`[rf-push] ${table} #${row.id} by ${row.user_name} (kart ${row.kart_name}) -> sent`);
    } catch (e){
      loggedIn = false;
      await sb(`${table}?id=eq.${row.id}`, { method:'PATCH', body: JSON.stringify({ status:'error', error:String(e).slice(0,500) }) });
      console.error(`[rf-push] ${table} #${row.id} failed:`, e.message || e);
    }
  }
}
function startRepairPusher(scrapeKartRepairs){
  const tick = () => {
    drain('rf_repair_queue', rfCreateDamage, scrapeKartRepairs).catch(e => console.error('[rf-push]', e.message || e));
    drain('rf_note_queue',   rfCreateNote,   scrapeKartRepairs).catch(e => console.error('[rf-push note]', e.message || e));
  };
  tick();
  setInterval(tick, 45_000);
}
module.exports = { startRepairPusher, rfLogin };
