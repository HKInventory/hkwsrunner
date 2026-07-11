// racefacer-reconcile.js
// End-of-day reconciliation: RaceFacer repairs (parts used) vs HK app stock scan-outs.
// Produces the notification lines shown to Ross & Harvey.
//
// app scan-outs come from the `logs` table rows where action='TAKEN':
//   { staff_name, sku, desc, qty, ts }
// RaceFacer repairs come from rf_repairs + rf_repair_parts:
//   { kartName, mechanic, date, repairedAt, parts:[{name, qty}] }
// aliases: Map rf_part_name -> sku  (null/absent = not mapped yet)

function hhmmss(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d) ? null : d.toTimeString().slice(0, 8);
}
function when(rep) {
  const t = hhmmss(rep.repairedAt);
  return t ? `at ${t}` : `on ${rep.date}`;
}

function reconcileDay({ day, rfRepairs, appTakes, aliases }) {
  const alias = (n) => (aliases instanceof Map ? aliases.get(n) : aliases[n]);
  const out = [];

  // 1) Aggregate app scan-outs for the day, per sku
  const takenBySku = {};         // sku -> { qty, events:[{staff,ts,qty}] }
  for (const t of appTakes) {
    const e = (takenBySku[t.sku] = takenBySku[t.sku] || { qty: 0, events: [] });
    e.qty += Number(t.qty) || 0;
    e.events.push(t);
  }

  // 2) Aggregate RaceFacer usage for the day, per sku (carry attribution)
  const usedBySku = {};          // sku -> { qty, uses:[{rep, part, qty}] }
  for (const rep of rfRepairs) {
    for (const p of rep.parts) {
      const sku = alias(p.name);
      if (sku === undefined || sku === null) {
        out.push({
          day, kind: 'UNMAPPED', rf_kart_name: rep.kartName, mechanic: rep.mechanic,
          part_name: p.name, sku: null, rf_qty: p.qty, app_qty: null, at: rep.repairedAt || null,
          message: `${rep.mechanic} – Kart ${rep.kartName} repair ${when(rep)}: used “${p.name}” which isn’t linked to an app stock item yet — needs mapping.`,
        });
        continue;
      }
      const u = (usedBySku[sku] = usedBySku[sku] || { qty: 0, uses: [] });
      u.qty += Number(p.qty) || 0;
      u.uses.push({ rep, part: p.name, qty: Number(p.qty) || 0 });
    }
  }

  // 3) RaceFacer used vs app scanned, per sku
  for (const [sku, u] of Object.entries(usedBySku)) {
    const taken = takenBySku[sku]?.qty || 0;
    if (taken >= u.qty) continue;                       // fully covered — no issue
    const short = u.qty - taken;
    const main = u.uses[0].rep;                          // attribute to the repair that used it
    const kind = taken === 0 ? 'USED_NOT_SCANNED' : 'QTY_MISMATCH';
    const partName = u.uses.map((x) => x.part)[0];
    const tail = taken === 0
      ? `but it was never scanned out of stock`
      : `but only ${taken} scanned out of stock (used ${u.qty})`;
    out.push({
      day, kind, rf_kart_name: main.kartName, mechanic: main.mechanic,
      part_name: partName, sku, rf_qty: u.qty, app_qty: taken, at: main.repairedAt || null,
      message: `${main.mechanic} – Kart ${main.kartName} repair ${when(main)}: used ${u.qty}× ${partName} ${tail}. Stock is short ${short}.`,
    });
  }

  // 4) Scanned in app but no matching RaceFacer usage
  for (const [sku, e] of Object.entries(takenBySku)) {
    const used = usedBySku[sku]?.qty || 0;
    if (used >= e.qty) continue;
    const extra = e.qty - used;
    const ev = e.events[0];
    out.push({
      day, kind: 'SCANNED_NOT_USED', rf_kart_name: null, mechanic: ev.staff_name,
      part_name: ev.desc || sku, sku, rf_qty: used, app_qty: e.qty, at: ev.ts,
      message: `${ev.staff_name} scanned out ${extra}× ${ev.desc || sku} ${hhmmss(ev.ts) ? 'at ' + hhmmss(ev.ts) : ''}— no matching RaceFacer repair found.`,
    });
  }
  return out;
}

module.exports = { reconcileDay };

// ----------------------------------------------------------------
// DEMO: a realistic day, run when called directly (node racefacer-reconcile.js)
// ----------------------------------------------------------------
if (require.main === module) {
  const aliases = {
    'ARROWY 50mm Silent Block': 'SB-50',
    'DFM Rear Tyre': 'TY-DFM-R',
    'Kart Antenna Cable': 'ANT-CBL',
    'Brake Disc': 'BRK-DISC',
    // 'Sacrificial Right' deliberately NOT mapped yet -> shows the "needs mapping" case
  };

  const rfRepairs = [
    { kartName: '19', mechanic: 'Jayden Aginsky', date: '01.06.2026', repairedAt: '2026-06-01T14:34:35',
      parts: [{ name: 'ARROWY 50mm Silent Block', qty: 2 }] },                 // used 2, scanned 1 -> QTY_MISMATCH
    { kartName: '22', mechanic: 'Will Webster', date: '01.06.2026', repairedAt: '2026-06-01T16:10:02',
      parts: [{ name: 'DFM Rear Tyre', qty: 1 }] },                            // used 1, scanned 0 -> USED_NOT_SCANNED
    { kartName: '19', mechanic: 'Rafael Hewitt', date: '01.06.2026', repairedAt: '2026-06-01T11:02:50',
      parts: [{ name: 'Kart Antenna Cable', qty: 1 }] },                       // used 1, scanned 1 -> OK (no line)
    { kartName: '34', mechanic: 'Alex Harper', date: '01.06.2026', repairedAt: '2026-06-01T17:45:00',
      parts: [{ name: 'Sacrificial Right', qty: 1 }] },                        // unmapped -> UNMAPPED
  ];

  const appTakes = [
    { staff_name: 'Jayden Aginsky', sku: 'SB-50',   desc: 'ARROWY 50mm Silent Block', qty: 1, ts: '2026-06-01T14:33:10' },
    { staff_name: 'Rafael Hewitt',  sku: 'ANT-CBL', desc: 'Kart Antenna Cable',       qty: 1, ts: '2026-06-01T11:01:30' },
    { staff_name: 'Sam Lally',      sku: 'BRK-DISC',desc: 'Brake Disc',               qty: 1, ts: '2026-06-01T09:15:44' }, // scanned, no repair
  ];

  const lines = reconcileDay({ day: '2026-06-01', rfRepairs, appTakes, aliases });
  console.log(`End-of-day discrepancies for 01 Jun 2026 — ${lines.length} to review:\n`);
  for (const d of lines) console.log(`• [${d.kind}] ${d.message}`);
}
