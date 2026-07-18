// racefacer-parse.js
// Verified RaceFacer (v5.2.1) response parser for the HK Workshop integration.
// Turns RaceFacer's JSON-wrapped HTML into clean data. Tested against real kart-19 data.
// Uses querySelector-style selectors so it ports cleanly from cheerio (Node) to deno-dom
// (Supabase Edge Function). Swap the loader line per environment.

const cheerio = require('cheerio'); // Edge Function: replace with deno-dom DOMParser

const txt = (s) => (s == null ? '' : String(s).replace(/\s+/g, ' ').trim());
const num = (s) => { const n = Number(txt(s).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null; };
const money = (s) => { const t = txt(s); return (!t || t === '-') ? null : t; };

// kart-details -> structured kart record. status codes: 1=OK, 2=DAMAGED, 3=FOR MAINTENANCE
function parseKartDetails(json) {
  const $ = cheerio.load(json.html || '');
  const fields = {};
  $('div').each((_, el) => {
    const label = txt($(el).clone().children('span').remove().end().text()).replace(/:$/, '').trim();
    const val = txt($(el).children('span').text());
    if (label && val) fields[label] = val;
  });
  let status = null, statusCode = null;
  $('a.garage_status_btn').each((_, el) => {
    if (!/\bdisabled\b/.test($(el).attr('class') || '')) {
      status = txt($(el).text());
      const m = ($(el).attr('onclick') || '').match(/toggle_kart_status\([^,]+,\s*'[^']*',\s*'(\d+)'/);
      statusCode = m ? Number(m[1]) : null;
    }
  });
  const spans = $('.fleft .spaced').map((_, el) => txt($(el).text())).get();
  const pick = (p) => { const s = spans.find((x) => x.startsWith(p)); return s ? s.slice(p.length).trim() : null; };
  return {
    id: json.kart?.id ?? null,
    name: json.kart?.name ?? pick('Name:'),
    type: pick('Type:'),
    kartIdLabel: pick('Kart ID:'),
    transponder: pick('Transponder:'),
    status, statusCode,
    totalKm: json.total_km ?? num(fields['Total mileage']),
    totalMi: json.total_mi ?? null,
    totalLaps: num(fields['Total laps']),
    totalHours: num(fields['Total working hours']),
    totalCost: fields['Total cost'] || null,
    brand: fields['Kart Brand'] || null,
    model: fields['Kart Model'] || null,
    engineBrand: fields['Engine brand'] || null,
    exploitationStart: fields['Exploitation start date'] || null,
  };
}

// kart-repairs -> [{description,dateDiscovered,dateRepaired,mileage,cost,user,notes[],parts[]}]
function parseRepairs(json) {
  const $ = cheerio.load(json.html || '');
  const repairs = [];
  let cur = null;
  $('#repairs-list').children('tr').each((_, tr) => {
    const $tr = $(tr);
    if (!$tr.hasClass('sub-section')) {
      const td = $tr.children('td').map((_, e) => txt($(e).text())).get();
      cur = { description: td[0] || '', dateDiscovered: td[1] || '', dateRepaired: td[2] || '',
        mileage: num(td[3]), cost: money(td[4]), user: td[5] || '', notes: [], parts: [] };
      repairs.push(cur);
    } else if (cur) {
      $tr.find('table').each((_, tbl) => {
        const $tbl = $(tbl);
        const headers = $tbl.find('th').map((_, e) => txt($(e).text())).get();
        if (headers[0] === 'Note') {
          $tbl.find('tbody td').each((_, e) => { const n = txt($(e).text()); if (n) cur.notes.push(n); });
        } else if (headers[0] === 'Parts used') {
          $tbl.find('tr').each((_, row) => {
            const c = $(row).children('td').map((_, e) => txt($(e).text())).get();
            if (c.length === 3 && !$(row).hasClass('no-results')) cur.parts.push({ name: c[0], qty: num(c[1]), price: money(c[2]) });
          });
        }
      });
    }
  });
  return { repairs, totalCost: txt($('tfoot td.bold').last().text()) || null };
}

// kart-parts -> [{date,part,hoursSinceRepair,kmSinceRepair}]
function parseParts(json) {
  const $ = cheerio.load(json.html || '');
  const rows = [];
  $('#running-sessions-list').children('tr').each((_, tr) => {
    const c = $(tr).children('td').map((_, e) => txt($(e).text())).get();
    if (c.length >= 4) rows.push({ date: c[0], part: c[1] || null, hoursSinceRepair: num(c[2]), kmSinceRepair: num(c[3]) });
  });
  return rows;
}

// Predictor seed: per-part replacement cadence from parts history.
function analysePartWear(rows) {
  const byPart = {};
  for (const r of rows) { if (r.part) (byPart[r.part] = byPart[r.part] || []).push(r); }
  const out = [];
  for (const [part, list] of Object.entries(byPart)) {
    list.sort((a, b) => a.kmSinceRepair - b.kmSinceRepair);
    const kmSinceLast = list[0].kmSinceRepair;
    const intervals = [];
    for (let i = 1; i < list.length; i++) intervals.push(list[i].kmSinceRepair - list[i - 1].kmSinceRepair);
    const avg = intervals.length ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length) : null;
    out.push({ part, times: list.length, avgKmBetween: avg, kmSinceLast,
      overdue: avg != null && kmSinceLast > avg, remainingKm: avg != null ? avg - kmSinceLast : null });
  }
  out.sort((a, b) => b.times - a.times || (a.avgKmBetween ?? 1e9) - (b.avgKmBetween ?? 1e9));
  return out;
}

// kart-notes -> [{ note, createdIso, createdBy, archivedIso, archivedBy, archived }]
// Each row is 3 <td>: Note, Created, Archived. Created/Archived read like
// "26.05.2026 18:52 - Kai Beeby"; a blank Archived cell means the note is still open.
function parseKartNotes(json) {
  const $ = cheerio.load(json.html || '');
  const when = (s) => {
    const m = txt(s).match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}:\d{2})\s*-\s*(.*)$/);
    if (!m) return { iso: null, by: null };
    return { iso: `${m[3]}-${m[2]}-${m[1]}T${m[4]}:00`, by: txt(m[5]) || null };
  };
  const out = [];
  $('table tbody tr').each((_, tr) => {
    const tds = $(tr).children('td');
    if (tds.length < 3) return;
    const note = txt($(tds[0]).text());
    const c = when($(tds[1]).text());
    const a = when($(tds[2]).text());
    if (!note && !c.iso) return;
    // RaceFacer's KART-NOTE id (distinct from the notification id) — the number the Kart Notes page
    // X sends to /ajax/garage/notes/delete as kart_note_id. It rides on the row's edit + delete
    // anchors as data-id, e.g. <a onclick="delete_kart_note(this)" data-id="30151">. Prefer the id
    // sitting next to one of those handlers; fall back to the first data-id in the row (data-kart-id /
    // data-kart-type never match the literal `data-id="` token).
    const rowHtml = $.html(tr) || '';
    const km = rowHtml.match(/(?:delete_kart_note|show_edit_kart_note)\([^)]*\)"\s*data-id="(\d+)"/)
            || rowHtml.match(/data-id="(\d+)"/);
    const kartNoteId = km ? Number(km[1]) : null;
    out.push({ note, createdIso: c.iso, createdBy: c.by, archivedIso: a.iso, archivedBy: a.by, archived: !!a.iso, kartNoteId });
  });
  return out;
}

// Parse a garage LIST page (one per kart type) and pull each kart's id, number and status
// straight from the status icon — far cheaper than fetching every kart's detail endpoint.
// A block looks like:
//   <span class="pointer kart-detail-block" v-on:click="select_kart(47)"> ...
//     <i class="... red fa-exclamation-circle" title="The kart is damaged."></i> ...
//     Name: <span class="bold">19</span> ...  data-kart_id="47" ...
//   </span>
function parseGarageStatuses(html) {
  const $ = cheerio.load(html || '');
  const out = [];
  $('.kart-detail-block').each((_, el) => {
    const $el = $(el);
    const outer = $.html(el) || '';                       // robust id read (Vue's v-on:click attr can be awkward via attr())
    let rfId = (outer.match(/select_kart\w*\((\d+)/) || [])[1] || (outer.match(/data-kart_id="(\d+)"/) || [])[1];
    rfId = rfId ? Number(rfId) : null;
    let name = null;                                       // the kart number is the numeric bold span
    $el.find('span.bold').each((__, b) => { const t = txt($(b).text()); if (/^\d{1,3}$/.test(t)) name = t; });
    const $i = $el.find('i[title]').first();               // the status icon carries class + a human title
    const cls = ($i.attr('class') || '').toLowerCase();
    const title = ($i.attr('title') || '').toLowerCase();
    let statusCode = null;
    if (/damag/.test(title) || /\bred\b/.test(cls)) statusCode = 2;                                                 // DAMAGED
    else if (/mainten|service|repair/.test(title) || /\b(yellow|orange|amber|warning)\b/.test(cls)) statusCode = 3; // FOR MAINTENANCE
    else if (/\bok\b|good|working|available|fine|operational|ready|active/.test(title) || /\bgreen\b/.test(cls)) statusCode = 1; // OK
    const status = statusCode === 2 ? 'DAMAGED' : statusCode === 3 ? 'FOR MAINTENANCE' : statusCode === 1 ? 'OK' : null;
    // NOTE INDICATOR: RaceFacer marks a kart card when it has an open note (a note/notification/star
    // icon or a count badge). We read that flag off this cheap list page so the fast notes pass can
    // fetch a kart's detail page ONLY when its note-flag flips — instead of sweeping the whole fleet.
    // Match broadly: a false positive just costs one harmless extra fetch; a miss falls back to the
    // rotating sweep, so this can only ever help. (If your list markup differs, send one kart card's
    // HTML and this pattern gets pinned exactly.)
    let hasNote = false;
    $el.find('i,span,a,button').each((__, n) => {
      const c = ($(n).attr('class') || '').toLowerCase();
      const t = ($(n).attr('title') || '').toLowerCase();
      const dt = ($(n).attr('data-original-title') || '').toLowerCase();   // Bootstrap tooltip title
      if (/sticky[-_ ]?note|fa-note|note-icon|has[-_ ]?note|notif|comment/.test(c) ||
          /\bnote\b|\bnotes\b|notification/.test(t + ' ' + dt)) hasNote = true;
    });
    if (!hasNote && /data-(?:has[-_]?notes?|note[-_]?count|notes?)=["']?[1-9]/.test(outer.toLowerCase())) hasNote = true;
    if (rfId) out.push({ rfId, name, statusCode, status, hasNote });
  });
  return out;
}

// The "active notes" list shown at the TOP of a kart's detail page (the starred notes with the
// red X). RaceFacer renders it inside kart-details html as `table.dataTable` rows of class
// "notification": td[0]=date, td[1]=star icon + note text, td[2]=the X. Clicking the X clears a
// note from THIS list without archiving it, so this is the only place that distinguishes a live
// note from one that's been X'd away. Returns {createdIso, note} whose fingerprint (rfId|createdIso|note)
// matches the same note's row in the Kart Notes table, so callers can flag which stored notes are active.
function parseActiveNotes(detailsHtml) {
  const $ = cheerio.load(detailsHtml || '');
  const out = [];
  $('table.dataTable tr.notification').each((_, tr) => {
    const tds = $(tr).children('td');
    if (tds.length < 2) return;
    const m = txt($(tds[0]).text()).match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}:\d{2})/);
    const createdIso = m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:00` : null;
    const note = txt($(tds[1]).clone().find('i').remove().end().text());   // drop the star icon, keep the text
    if (!note) return;
    // RaceFacer's NOTIFICATION id (the ?note_id=26653 number) — needed for a repair to CLEAR its
    // note. It rides in this row's markup, almost certainly on the X button. Try, in order:
    //  1. an explicit note_id / notification_id anywhere in the row
    //  2. a function-call number in the X cell's onclick, e.g. delete_notification(26653)
    //  3. a data-id / data-note-id on the row
    //  4. any 5+ digit number in the X cell (5+ so a bare year like 2026 can't match)
    let notifId = null;
    const rowHtml = $.html(tr) || '';
    const xHtml = tds.length > 2 ? ($.html(tds[2]) || '') : '';
    let idm = rowHtml.match(/(?:note[_-]?id|notification[_-]?id)\D{0,6}(\d{3,})/i)
           || xHtml.match(/\(\s*(\d{4,})\s*[,)]/)
           || (() => { const d = $(tr).attr('data-id') || $(tr).attr('data-note-id'); return d && /^\d+$/.test(d) ? [null, d] : null; })()
           || xHtml.match(/(\d{5,})/);
    if (idm) notifId = Number(idm[1]);
    out.push({ createdIso, note, notifId });
  });
  return out;
}

// The GLOBAL notifications page (/en/administration/garage/notifications) — a fleet-wide list of every
// note, newest first. ONE fetch of this tells us which karts got a NEW note, so we can pull just those
// karts' details instead of blind-rotating the whole fleet. Best-effort/defensive parse: columns are
// [checkbox, Date, Title, Kart, Kart type, Name]; we find the date by pattern, the kart number as the
// bare-numeric cell, the kart type as the "… Track" cell, and the notification id off the row checkbox
// (its value is what "Delete selected" posts). Returns [] if the table is empty (e.g. rendered via a
// client-side AJAX source) so the caller can fall back and capture the real source.
function parseNotificationsList(html) {
  const $ = cheerio.load(html || '');
  const out = [];
  $('table tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const rowText = txt($tr.text());
    const dm = rowText.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
    if (!dm) return;                                   // header / spacer / non-note row
    const dateIso = `${dm[3]}-${dm[2]}-${dm[1]}T${dm[4]}:${dm[5]}:00`;
    const rowHtml = $.html(tr) || '';
    const notifId = Number(
      (rowHtml.match(/<input[^>]*type=["']checkbox["'][^>]*value=["'](\d+)["']/i) || [])[1] ||
      (rowHtml.match(/value=["'](\d+)["'][^>]*type=["']checkbox["']/i) || [])[1] ||
      (rowHtml.match(/data-id=["'](\d+)["']/) || [])[1] || 0) || null;
    let kartNumber = null, kartType = null;
    $tr.children('td').each((__, td) => {
      const t = txt($(td).text());
      if (kartNumber == null && /^\d{1,3}$/.test(t)) kartNumber = t;
      if (kartType == null && /track/i.test(t)) kartType = t;
    });
    out.push({ dateIso, kartNumber, kartType, notifId });
  });
  return out;
}

// The GLOBAL Kart Notes page (/en/administration/garage/kart-notes) carries each note's kart_note_id on
// its edit/delete buttons — the per-kart /ajax/garage/kart-notes?id= endpoint the sync reads does NOT, so
// this is where we source the id the notes/delete call needs. The edit anchor conveniently holds all of:
//   data-id        = kart_note_id  (what notes/delete uses)
//   data-kart-id   = RaceFacer kart id
//   data-message   = the note text
// e.g. <a onclick="show_edit_kart_note(this)" data-id="30151" data-kart-id="47" data-message="timing">
function parseKartNoteButtons(html) {
  const $ = cheerio.load(html || '');
  const out = [];
  $('a[onclick*="show_edit_kart_note"], a[onclick*="delete_kart_note"]').each((_, a) => {
    const $a = $(a);
    const id = $a.attr('data-id');
    if (!id || !/^\d+$/.test(id)) return;
    const kid = $a.attr('data-kart-id');
    const msg = $a.attr('data-message');
    out.push({ kartNoteId: Number(id), rfKartId: (kid != null && /^\d+$/.test(kid)) ? Number(kid) : null, note: msg != null ? msg : null });
  });
  return out;
}

// ROW-AWARE version of the above: parses whole <tr> rows so each note carries its ARCHIVED state.
// The global Kart Notes table lists the FULL history (open AND archived notes) — diffing it against the
// DB's active set without this flag makes every historical note look "new" and storms the fleet.
// A row shows one date-time (created) when open, two (created + archived) when archived.
function parseKartNotesTableRows(html) {
  const $ = cheerio.load(html || '');
  const out = [];
  $('tr').each((_, tr) => {
    const $tr = $(tr);
    const $edit = $tr.find('a[onclick*="show_edit_kart_note"]').first();
    const $del  = $tr.find('a[onclick*="delete_kart_note"]').first();
    const id = ($edit.attr('data-id') || $del.attr('data-id') || '').trim();
    if (!/^\d+$/.test(id)) return;
    const kid = ($edit.attr('data-kart-id') || '').trim();
    let note = $edit.attr('data-message');
    if (note == null || note === '') {
      $tr.children('td').each((__, td) => { if (note) return; const t = txt($(td).text()); if (t && !/^\d{2}\.\d{2}\.\d{4}/.test(t) && !/^\d{1,3}$/.test(t)) note = t; });
    }
    const dates = (txt($tr.text()).match(/\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/g) || []).length;
    out.push({ kartNoteId: Number(id), rfKartId: /^\d+$/.test(kid) ? Number(kid) : null, note: note != null ? String(note) : null, archived: dates >= 2 });
  });
  return out;
}

module.exports = { parseKartDetails, parseRepairs, parseParts, parseKartNotes, parseActiveNotes, parseGarageStatuses, parseNotificationsList, parseKartNoteButtons, parseKartNotesTableRows, analysePartWear };
