// Pricing from TIS's "Client and Inspector Pricing Guide" (rules/pricing.json).
// Works out what the inspector should be paid and what the client should be billed, with the reason for each figure.
// Suggestions only: QC enters the fees in EZ (Set Fees is never touched by the extension).

import { readFileSync } from 'node:fs';
import { firstQ, num, totalSqft } from './snapshot.mjs';

export const GUIDE = JSON.parse(readFileSync(new URL('../rules/pricing.json', import.meta.url), 'utf8'));
const money = n => '$' + (Math.round(n * 100) / 100).toFixed(Number.isInteger(Math.round(n * 100) / 100) ? 0 : 2);

// NYC boroughs: Manhattan 100–102, Staten Island 103, Bronx 104, Brooklyn 112, Queens 111/113/114 and 11004–05
const NYC_ZIP = /^(10[0-4]\d\d|11[1-4]\d\d|1100[45])$/;
const NYC_TEXT = /\b(new york,? ny|manhattan|brooklyn|bronx|queens|staten island|long island city|astoria|flushing|jamaica,? ny)\b/i;

/** What kind of job this is, from the order form, attached forms and location. */
export function classify(snap) {
  const of = snap.order?.orderForm || {};
  const req = String(of.requestType || '');
  const cov = (of.coverages || []).join(' | ');
  const forms = (snap.order?.forms || snap.forms || []).map(f => f.name || '');
  const formText = forms.join(' | ');
  const nob = String(of.natureOfBusiness || '');
  const phone = /telephone|phone/i.test(req);
  const virtual = /virtual/i.test(req);
  const recCheck = /rec(ommendation)?\s*check/i.test(req + ' ' + cov);
  const exterior = /exterior/i.test(req + ' ' + cov);
  const sidewalk = /sidewalk/i.test(req + ' ' + cov);
  const extra = String(of.additionalAddresses || '').split(/\n|;/).map(s => s.trim()).filter(s => s && !/^\*+$/.test(s));
  const zip = snap.order?.geo?.zip || '';
  const supplements = forms.filter(n => /supplement|freeze|wildfire|manufactur|cannabis|\brcv\b|cooking/i.test(n) && !/general form|recommendation/i.test(n));
  return {
    phone, virtual, recCheck, exterior, sidewalk,
    limited: phone || recCheck || exterior || sidewalk,
    nyc: NYC_ZIP.test(zip) || NYC_TEXT.test(snap.order?.location || ''),
    camp: /\bcamp(s|ground)?\b|rv park|resort/i.test(nob + ' ' + formText),
    wildfire: /wildfire/i.test(formText + ' ' + (of.climaticSupplements || []).join(' ')),
    freeze: /freeze/i.test(formText),
    rcv: /\brcv\b|replacement cost/i.test(formText),
    cookingSupplements: forms.filter(n => /cooking/i.test(n)).length,
    otherSupplements: supplements.filter(n => !/cooking|wildfire|freeze|\brcv\b/i.test(n)),
    supplements,
    buildings: 1 + extra.length,
    buildingsKnown: !extra.length ? 'assumed 1 (no additional addresses on the order form)' : `${1 + extra.length} (order form location + ${extra.length} additional address${extra.length > 1 ? 'es' : ''})`,
    sqft: totalSqft(snap),
    requestType: req || 'not stated',
  };
}

/** Pull fee hints out of free text: hours, travel fees and other dollar amounts. */
export function parseFeeText(text = '') {
  const t = String(text).replace(/,(?=\d{3})/g, '');
  const hours = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/gi)].map(m => Number(m[1]));
  const travel = [...t.matchAll(/travel(?:\s*fee)?\D{0,12}?\$?\s*(\d+(?:\.\d{1,2})?)|\$\s*(\d+(?:\.\d{1,2})?)\s*(?:for\s*)?travel/gi)].map(m => Number(m[1] || m[2]));
  const amounts = [...t.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)].map(m => Number(m[1]));
  const bare = /^\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*$/.exec(t);   // a pricing note that is just "125"
  if (bare) amounts.push(Number(bare[1]));
  return { hours, travel, amounts: amounts.filter(a => !travel.includes(a)) };
}

/** Inspector pay per the guide's inspector section. */
export function inspectorPay(snap, k = classify(snap), g = GUIDE) {
  const base = k.limited ? g.inspector.limited : g.inspector.full;
  const fees = snap.order?.fees || {};
  const notes = snap.order?.pricingNotes || {};
  const sources = [['inspector pricing note', notes.inspector], ['comments', snap.order?.comments]].filter(([, v]) => String(v || '').trim());
  const lines = [`${k.limited ? 'Exterior only / rec check' : 'Full inspection'}: minimum ${money(base)}`];
  let hours = num(fees.inspectorHours) || 0, amount = 0, travel = 0;
  for (const [src, text] of sources) {
    const p = parseFeeText(text);
    if (p.hours.length && !hours) { hours = Math.max(...p.hours); lines.push(`${hours} hours in the ${src}`); }
    if (p.travel.length) { const t = Math.max(...p.travel); if (t > travel) { travel = t; lines.push(`travel fee ${money(t)} in the ${src}`); } }
    if (p.amounts.length) { const a = Math.max(...p.amounts); if (a > amount) { amount = a; lines.push(`${money(a)} in the ${src}`); } }
  }
  let pay = base, basis = 'minimum';
  if (hours) { const h = hours * g.inspector.hourly; if (h > pay) { pay = h; basis = 'hourly'; } lines.push(`${hours} h × ${money(g.inspector.hourly)} = ${money(h)}`); }
  if (amount > pay) { pay = amount; basis = 'noted amount'; }
  if (travel) { pay += travel; lines.push(`+ travel ${money(travel)}`); }
  return { amount: Math.round(pay * 100) / 100, base, basis, travel, hours, lines, fromText: sources.length > 0 };
}

const band = (bands, fee) => {
  for (const [max, price] of bands) if (max == null || fee <= max) return { price, max };
  return null;
};
const bandLabel = (bands, hit) => {
  const i = bands.findIndex(b => b === bands.find(([max]) => max === hit.max));
  const lo = i > 0 ? bands[i - 1][0] + 1 : 0;
  return hit.max == null ? `inspector fee over ${money(bands[i - 1][0])}` : i === 0 ? `inspector fee ${money(hit.max)} or less` : `inspector fee ${money(lo)}–${money(hit.max)}`;
};

export function findClient(name = '', g = GUIDE) {
  return g.clients.find(c => new RegExp(c.match, 'i').test(name)) || null;
}

/** Client fee per the client's table. pay = the inspector fee the bands are keyed on. */
export function clientFee(snap, k = classify(snap), pay, g = GUIDE) {
  let c = findClient(snap.order?.client || '', g);
  const lines = [], review = [];
  if (!c) return { amount: null, schedule: null, lines: ['this client is not in the pricing guide'], review: ['Client not in the pricing guide: price by hand or add it to rules/pricing.json.'] };
  for (const u of c.useInstead || []) if (new RegExp(u.when, 'i').test([k.freeze && 'freeze', k.wildfire && 'wildfire', k.camp && 'camp'].filter(Boolean).join(' '))) {
    c = g.clients.find(x => x.name === u.client) || c; lines.push(`${u.client} prices apply: ${u.note}`); break;
  }
  if (c.seneca) return senecaFee(snap, k, c, g);
  if (c.custom) {
    const notes = snap.order?.pricingNotes || {};
    const p = parseFeeText([notes.qc, notes.admin].filter(Boolean).join('\n'));
    if (p.amounts.length) return { amount: Math.max(...p.amounts), schedule: c.name, lines: [`custom pricing from the pricing notes: ${money(Math.max(...p.amounts))}`], review: ['Custom client pricing: check the pricing notes.'] };
    return { amount: null, schedule: c.name, lines: ['no client pricing in the pricing notes'], review: [c.note] };
  }
  let s = c.schedule ? { ...g.schedules[c.schedule], ...c } : c;
  if (k.virtual && s.virtual) { s = { ...s.virtual }; lines.push(s.label || 'virtual inspection'); }
  else if (s.virtualOnly && !k.virtual && !k.phone) review.push(`This client orders virtual inspections only, but this order is "${k.requestType}".`);
  if (k.camp && s.camps) { s = { ...s, bands: s.camps.bands, limited: s.limited }; lines.push(s.camps.label); }

  let amount = null;
  if (k.phone && s.phone != null) { amount = s.phone; lines.push(`phone survey ${money(amount)}`); }
  else if (k.limited && s.exteriorSingle != null && k.exterior) { amount = s.exteriorSingle; lines.push(`single building exterior only ${money(amount)}`); if (k.buildings > 1) review.push('Exterior-only price is for a single building: this order lists more than one.'); }
  else if (k.limited && s.limited != null) { amount = s.limited; lines.push(`${s.limitedLabel || 'exterior / rec check / phone survey'} ${money(amount)}`); }
  else if (k.limited && !s.bands && !s.flat && !s.buildings) review.push('The guide has no exterior / rec check price for this client.');
  if (amount == null && s.flat != null) { amount = s.flat; lines.push(`${s.flatLabel || 'all inspections'} ${money(amount)}`); }
  if (amount == null && s.buildings) {
    const n = k.buildings, list = s.buildings;
    amount = list[Math.min(n, list.length) - 1];
    if (n > list.length && s.extraBuilding) { amount += (n - list.length) * s.extraBuilding; review.push(s.extraBuildingNote); }
    else if (n > list.length && !s.extraBuilding && list.length < 3) review.push(`The guide stops at ${list.length} buildings.`);
    lines.push(`${n} building${n > 1 ? 's' : ''} (${k.buildingsKnown}): ${money(amount)}`);
  }
  if (amount == null && s.bands) {
    const hit = band(s.bands, pay);
    if (hit) { amount = hit.price; lines.push(`${bandLabel(s.bands, hit)} (${money(pay)}): ${money(amount)}`); }
    else review.push(`No band for an inspector fee of ${money(pay)}${c.bandsNote ? ` (${c.bandsNote})` : ''}.`);
  }
  const actions = [];
  for (const a of s.addons || c.addons || []) if (k[a.when]) { if (amount != null) amount += a.add; lines.push(`+ ${money(a.add)} ${a.label}`); if (a.action) actions.push(a.action); }
  if (amount == null && !review.length) review.push('No matching price in the guide for this kind of order.');
  return { amount, schedule: c.name, lines, review, actions };
}

function senecaFee(snap, k, c, g) {
  const s = g.seneca, lines = [], review = [];   // c.note (why Boost AI uses Seneca) stays in pricing.json; the schedule name says it
  let amount;
  if (k.limited) { amount = s.limited; lines.push(`${s.limitedLabel}: ${money(amount)}`); }
  else if (k.nyc) { amount = s.nyc; lines.push(`Tier 1 - NYC metro risk: ${money(amount)}`); }
  else if (k.sqft == null) { review.push('No total square footage on the form: the tier cannot be worked out.'); return { amount: null, schedule: c.name, lines, review }; }
  else { const i = s.tiers.findIndex(([max]) => max == null || k.sqft <= max); amount = s.tiers[i][1]; lines.push(`${s.tierNames[i]} (${k.sqft.toLocaleString('en-US')} sf outside NYC): ${money(amount)}`); }
  const base = amount;   // the Order Fee Type drop-down holds the tier; supplements are billed on top
  if (!k.limited) {
    for (const n of k.otherSupplements.concat(k.freeze ? ['Freeze'] : [], k.wildfire ? ['Wildfire'] : [])) { amount += s.supplement; lines.push(`+ ${money(s.supplement)} supplement: ${n}`); }
    if (k.otherSupplements.length + (k.freeze ? 1 : 0) + (k.wildfire ? 1 : 0) > 1) review.push(s.supplementNote);
    const free = k.nyc ? s.cooking.nycFree : s.cooking.otherFree, paid = Math.max(0, k.cookingSupplements - free);
    if (k.cookingSupplements) lines.push(`${k.cookingSupplements} cooking supplement${k.cookingSupplements > 1 ? 's' : ''}, first ${free} free${paid ? `: + ${money(paid * s.cooking.each)}` : ''}`);
    amount += paid * s.cooking.each;
  }
  return { amount, base, schedule: c.name, lines, review, actions: [], travelFee: s.travel };
}

/** Full pricing check for an order: expected figures, what EZ has, and the matching fee-type option. */
export function price(snap, g = GUIDE) {
  const k = classify(snap);
  const pay = inspectorPay(snap, k, g);
  const fees = snap.order?.fees || {};
  const enteredPay = num(fees.inspector) || 0;
  const keyedOn = enteredPay > 0 ? enteredPay : pay.amount;
  const client = clientFee(snap, k, keyedOn, g);
  if (client.travelFee && pay.travel) { client.amount = client.amount != null ? client.amount + client.travelFee : null; client.lines.push(`+ $${client.travelFee} travel fee (inspector billed travel)`); client.review.push(g.seneca.travelNote); }
  const opts = snap.order?.pricing?.feeOptions || [];
  const optFee = client.base ?? client.amount;
  const option = optFee != null ? opts.find(o => new RegExp('^\\$' + optFee + '(\\b|\\D)').test(o.trim()))
    || (k.limited ? opts.find(o => /exterior|rec check/i.test(o)) : null) : null;
  return { kind: k, inspector: { ...pay, entered: enteredPay || null }, client: { ...client, entered: num(fees.client) || null, keyedOn, keyedOnEntered: enteredPay > 0 },
    feeType: { selected: snap.order?.pricing?.selectedFeeType || null, expected: option || null, options: opts.length } };
}
