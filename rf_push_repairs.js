/* ============================================================================
   HK Workshop — INSTANT push of app-created repairs & notes into RaceFacer.
   Drop into the runner repo; call startRepairPusher(scrapeKartRepairs) once.

   SPEED MODEL (inside the 5M/mo Realtime cap)
   - Realtime trigger: subscribes to rf_repair_queue + rf_note_queue and fires the
     instant a row lands. Only THIS runner listens -> ~1 message per repair/note,
     a few thousand a month = negligible vs 5M.
   - Warm RaceFacer session: logs in once, keeps the cookie hot with a 4-min ping,
     re-logs only on an actual expiry. So each repair is just get-token + submit.
   - Safety net: a slow 25s poll still runs, to catch anything queued while the
     worker was down or any missed realtime event. Belt and braces.
   Result: a logged repair reaches RaceFacer in ~1.5–3s.

   ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY (required).
        RF_BASE=https://103.166.146.163  RF_USER=HKWS  RF_PASS=HKWS  (defaults).
        SAFETY_POLL_MS default 25000.   Node 20 + `npm install`.
   ============================================================================ */
const https = require('https');
const { createClient } = require('@supabase/supabase-js');
const agent = new https.Agent({ rejectUnauthorized: false }); // self-signed cert on that IP

const RF_BASE = (process.env.RF_BASE || 'https://103.166.146.163').replace(/\/$/, '');
const RF_USER = process.env.RF_USER || 'HKWS';
const RF_PASS = process.env.RF_PASS || 'HKWS';
const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
const SAFETY_POLL_MS = Number(process.env.SAFETY_POLL_MS) || 25000;

if (!SB_URL || !SB_KEY) { console.error('[rf-push] missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const supa = createClient(SB_URL, SB_KEY, { auth: { persistSession: false }, realtime: { params: { eventsPerSecond: 5 } } });

const RF_STATUS_ID = { ok: 1, for_maintenance: 2, damaged: 3 };
const RF_USERS = { /* optional overrides, e.g. 'Harvey Betts': 92 */ };

/* ---------------- cookie jar + helpers ---------------- */
let jar = {}, loggedIn = false;
function absorb(res){ const l = res.headers.getSetCookie ? res.headers.getSetCookie() : []; for (const sc of l){ const p = sc.split(';')[0], i = p.indexOf('='); if (i>0) jar[p.slice(0,i).trim()] = p.slice(i+1).trim(); } }
function cookieHeader(){ return Object.keys(jar).map(k => `${k}=${jar[k]}`).join('; '); }
function rfHeaders(extra={}){ return { Cookie: cookieHeader(), Origin: RF_BASE, 'User-Agent':'HKWorkshopBot/1.0', 'X-Requested-With':'XMLHttpRequest', ...extra }; }
const norm = s => String(s||'').toLowerCase().replace(/aginskey/g,'aginsky').replace(/[^a-z]/g,'');

/* ---------------- RaceFacer login + warm session ---------------- */
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
async function keepWarm(){ // hit an authed page so the session never goes cold between repairs
  if (!loggedIn) return;
  try { const r = await fetch(`${RF_BASE}/en/administration/garage/garage`, { agent, headers: rfHeaders(), redirect:'manual' });
    absorb(r); if (r.status===302 || /login/i.test(r.headers.get('location')||'')) loggedIn=false; } catch { loggedIn=false; }
}

/* ---------------- read the form page: token, users, parts, kart type ---------------- */
function parseOptions(html, selectNameRegex){
  const out = {}; const sel = html.match(new RegExp(`<select[^>]*${selectNameRegex}[^>]*>([\\s\\S]*?)</select>`, 'i'));
  if (!sel) return out;
  const re = /<option[^>]*value="(\d+)"[^>]*>([\s\S]*?)<\/option>/gi; let m;
  while ((m = re.exec(sel[1]))) out[norm(m[2].replace(/<[^>]+>/g,'').trim())] = { id: Number(m[1]) };
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
  const parts = {};
  const psel = html.match(/<select[^>]*(?:used_parts|part)[^>]*>([\s\S]*?)<\/select>/i);
  if (psel){ const re = /<option([^>]*)>([\s\S]*?)<\/option>/gi; let m; while ((m = re.exec(psel[1]))){ const a = m[1];
    const g = n => (a.match(new RegExp(n+'="([^"]+)"','i'))||[])[1];
    const pid = g('data-part[_-]?id') || g('value'); if (!pid) continue;
    const nm = m[2].replace(/<[^>]+>/g,'').trim();
    parts[norm(nm)] = { part_id:Number(pid), id:Number(g('data-id')||pid), max_qty:Number(g('data-max[_-]?qty')||99), price:Number(g('data-price')||0), name:nm }; } }
  const kart_type_id = Number(html.match(/kart_type_id["']?\s*[:=]\s*["']?(\d+)/i)?.[1] || html.match(/name="kart_type"[^>]*value="(\d+)"/i)?.[1] || 0);
  return { token, users, parts, kart_type_id };
}
function resolveUser(name, users){
  const key = norm(name);
  for (const n in RF_USERS) if (norm(n) === key) return RF_USERS[n];
  if (users[key]) return users[key].id;
  for (const k in users) if (k.includes(key) || key.includes(k)) return users[k].id;
  return null;
}
function resolvePart(p, parts){
  if (p.part_id) return { part_id:Number(p.part_id), id:Number(p.id||p.part_id), max_qty:Number(p.max_qty||99), price:(p.price!=null?Number(p.price):0) }; // exact ids from the synced warehouse
  const byName = parts[norm(p.name)]; if (byName) return byName;
  for (const k in parts) if (p.name && (k.includes(norm(p.name)) || norm(p.name).includes(k))) return parts[k];
  return null;
}

/* ---------------- submitters ---------------- */
async function rfCreateNote(row){
  const ctx = await formContext(row.rf_kart_id);
  const user_id = resolveUser(row.user_name, ctx.users);
  if (!user_id) throw new Error(`no RaceFacer user_id for "${row.user_name}" — add to RF_USERS`);
  const body = new URLSearchParams({ url:`${RF_BASE}/en/administration/garage/garage?kart_id=${row.rf_kart_id}`,
    status_change:'1', kart_status_id:String(RF_STATUS_ID[row.rf_status]||1), kart_note_id:'',
    kart_type:String(ctx.kart_type_id||''), kart_id:String(row.rf_kart_id), message:row.note||'', user_id:String(user_id) });
  const r = await fetch(`${RF_BASE}/ajax/garage/notes/add`, { method:'POST', agent, redirect:'manual',
    headers: rfHeaders({ 'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8',
      Referer:`${RF_BASE}/en/administration/garage/garage?kart_id=${row.rf_kart_id}&action=maintenances` }), body });
  absorb(r);
  if (r.status===401 || /login/i.test(r.headers.get('location')||'')) { loggedIn=false; throw new Error('session expired'); }
  if (r.status>=400) throw new Error(`notes/add: ${r.status}`);
}
async function rfCreateDamage(row){
  const ctx = await formContext(row.rf_kart_id);
  const user_id = resolveUser(row.user_name, ctx.users);
  if (!user_id) throw new Error(`no RaceFacer user_id for "${row.user_name}" — add to RF_USERS`);
  const inner = new URLSearchParams({ notification_id:String(row.notification_id||''), kart_id:String(row.rf_kart_id),
    damage_discovery_date:row.date_discovered||'', repair_date:row.date_repaired||'', hours_spent:String(parseFloat(row.working_hours)||0),
    kart_status_id:String(RF_STATUS_ID[row.rf_status]||1), user_id:String(user_id), annotation:row.note||'',
    repair_km:String(row.repair_km||0), _token:ctx.token }).toString();
  const body = new URLSearchParams(); body.set('damage', inner);
  (row.parts||[]).forEach((p,i)=>{ const rp = resolvePart(p, ctx.parts); if(!rp) return;
    body.append(`used_parts[${i}][id]`, String(rp.id)); body.append(`used_parts[${i}][price]`, String(p.price!=null?p.price:rp.price));
    body.append(`used_parts[${i}][qty]`, String(p.qty||1)); body.append(`used_parts[${i}][part_id]`, String(rp.part_id));
    body.append(`used_parts[${i}][max_qty]`, String(rp.max_qty||99)); });
  const r = await fetch(`${RF_BASE}/ajax/garage/damage`, { method:'POST', agent, redirect:'manual',
    headers: rfHeaders({ 'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8', 'X-CSRF-Token':ctx.token,
      Referer:`${RF_BASE}/en/administration/garage/damage?kart_id=${row.rf_kart_id}&referer=repairs` }), body });
  absorb(r);
  if (r.status===401 || /login/i.test(r.headers.get('location')||'')) { loggedIn=false; throw new Error('session expired'); }
  if (r.status>=400) throw new Error(`garage/damage: ${r.status}`);
}

/* ---------------- queue drain (locked so realtime + poll never overlap) ---------------- */
let draining = false;
async function drainTable(table, submit, scrape){
  const { data: rows, error } = await supa.from(table).select('*').eq('status','pending').order('id',{ascending:true}).limit(10);
  if (error) { console.error(`[rf-push] read ${table}:`, error.message); return; }
  if (!rows || !rows.length) return;
  if (!loggedIn) await rfLogin();
  for (const row of rows){
    try {
      await submit(row);
      if (typeof scrape === 'function') await scrape(row.rf_kart_id); // land real id, no dupes
      await supa.from(table).update({ status:'sent', sent_at:new Date().toISOString(), error:null }).eq('id', row.id);
      console.log(`[rf-push] ${table} #${row.id} by ${row.user_name} (kart ${row.kart_name}) -> sent`);
    } catch (e){
      loggedIn = false;
      await supa.from(table).update({ status:'error', error:String(e).slice(0,500) }).eq('id', row.id);
      console.error(`[rf-push] ${table} #${row.id} failed:`, e.message || e);
    }
  }
}
async function drainAll(scrape){
  if (draining) return; draining = true;
  try { await drainTable('rf_repair_queue', rfCreateDamage, scrape); await drainTable('rf_note_queue', rfCreateNote, scrape); }
  finally { draining = false; }
}

async function syncWarehouse(){ // publish RaceFacer's parts list so the app dropdown uses REAL ids
  try{
    if (!loggedIn) await rfLogin();
    const kartId = Number(process.env.RF_SAMPLE_KART) || 26;
    const ctx = await formContext(kartId);
    const rows = Object.values(ctx.parts).filter(p => p.part_id).map(p => ({ part_id:p.part_id, rf_id:p.id, name:p.name||'', price:p.price||0, max_qty:p.max_qty||99, updated_at:new Date().toISOString() }));
    if (!rows.length){ console.log('[rf-push] warehouse: no parts parsed (send me the parts <select> HTML)'); return; }
    const { error } = await supa.from('rf_warehouse').upsert(rows, { onConflict:'part_id' });
    if (error) console.error('[rf-push] warehouse upsert:', error.message);
    else console.log(`[rf-push] warehouse synced: ${rows.length} parts`);
  }catch(e){ console.error('[rf-push] warehouse:', e.message || e); }
}
function startRepairPusher(scrape){
  // 1) instant trigger — fire the moment a row is inserted (only this runner listens)
  supa.channel('hk-rf-queue')
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'rf_repair_queue' }, () => drainAll(scrape))
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'rf_note_queue'   }, () => drainAll(scrape))
    .subscribe((status) => console.log('[rf-push] realtime:', status));
  // 2) catch anything queued while we were down, right now
  drainAll(scrape);
  // 3) safety net + keep the RaceFacer session warm
  setInterval(() => drainAll(scrape), SAFETY_POLL_MS);
  setInterval(keepWarm, 4 * 60 * 1000);
  syncWarehouse();
  setInterval(syncWarehouse, 6 * 60 * 60 * 1000);   // refresh the parts list every 6h
}
module.exports = { startRepairPusher, rfLogin };
