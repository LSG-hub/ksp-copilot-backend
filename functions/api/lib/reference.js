'use strict';
/** Loads small lookup tables once (cached on the warm instance) so tool results
 *  can be shown with human names (crime types, districts, statuses) instead of
 *  raw IDs — without needing SQL joins (which ZCQL can't do on our schema). */
const { runZCQL } = require('./zcql');

let _cache = null;

async function loadReference(app) {
  if (_cache) return _cache;
  const q = (s) => runZCQL(app, s).then((r) => r.rows);
  const [subs, heads, dists, stats, units, cats, gravs] = await Promise.all([
    q('SELECT CrimeSubHeadID, CrimeHeadName, CrimeHeadID FROM CrimeSubHead'),
    q('SELECT CrimeHeadID, CrimeGroupName FROM CrimeHead'),
    q('SELECT DistrictID, DistrictName FROM District'),
    q('SELECT CaseStatusID, CaseStatusName FROM CaseStatusMaster'),
    q('SELECT UnitID, UnitName, DistrictID FROM Unit'),
    q('SELECT CaseCategoryID, LookupValue FROM CaseCategory'),
    q('SELECT GravityOffenceID, LookupValue FROM GravityOffence'),
  ]);

  const ref = {
    subHead: {}, subHeadByName: {}, headOfSub: {},
    head: {}, headByName: {}, subsOfHead: {},
    district: {}, districtByName: {}, stationsOfDistrict: {},
    unit: {}, status: {}, statusByName: {}, category: {}, gravity: {},
  };
  heads.forEach((h) => {
    ref.head[h.CrimeHeadID] = h.CrimeGroupName;
    ref.headByName[String(h.CrimeGroupName).toLowerCase()] = h.CrimeHeadID;
    ref.subsOfHead[h.CrimeHeadID] = [];
  });
  subs.forEach((s) => {
    ref.subHead[s.CrimeSubHeadID] = s.CrimeHeadName;
    ref.subHeadByName[String(s.CrimeHeadName).toLowerCase()] = s.CrimeSubHeadID;
    ref.headOfSub[s.CrimeSubHeadID] = s.CrimeHeadID;
    (ref.subsOfHead[s.CrimeHeadID] = ref.subsOfHead[s.CrimeHeadID] || []).push(s.CrimeSubHeadID);
  });
  dists.forEach((d) => {
    ref.district[d.DistrictID] = d.DistrictName;
    ref.districtByName[String(d.DistrictName).toLowerCase()] = d.DistrictID;
    ref.stationsOfDistrict[d.DistrictID] = [];
  });
  units.forEach((u) => {
    ref.unit[u.UnitID] = { name: u.UnitName, district: u.DistrictID };
    if (ref.stationsOfDistrict[u.DistrictID]) ref.stationsOfDistrict[u.DistrictID].push(u.UnitID);
  });
  stats.forEach((s) => {
    ref.status[s.CaseStatusID] = s.CaseStatusName;
    ref.statusByName[String(s.CaseStatusName).toLowerCase()] = s.CaseStatusID;
  });
  cats.forEach((c) => { ref.category[c.CaseCategoryID] = c.LookupValue; });
  gravs.forEach((g) => { ref.gravity[g.GravityOffenceID] = g.LookupValue; });

  _cache = ref;
  return ref;
}

// Resolve a free-text crime term to CrimeSubHead IDs (matches a sub-head name,
// or a crime-head/group name -> all its sub-heads). Returns {ids, label}.
function resolveCrimeType(ref, term) {
  if (!term) return { ids: [], label: null };
  const t = String(term).toLowerCase().trim();
  for (const [name, id] of Object.entries(ref.subHeadByName)) {
    if (name === t) return { ids: [id], label: ref.subHead[id] };
  }
  for (const [name, id] of Object.entries(ref.headByName)) {
    if (name === t || name.includes(t) || t.includes(name.split(' ')[0])) {
      return { ids: ref.subsOfHead[id] || [], label: ref.head[id] };
    }
  }
  // partial sub-head match
  const hits = Object.keys(ref.subHeadByName).filter((n) => n.includes(t) || t.includes(n));
  if (hits.length) return { ids: hits.map((n) => ref.subHeadByName[n]), label: hits.join(', ') };
  return { ids: [], label: null };
}

function resolveDistrict(ref, term) {
  if (!term) return { id: null, stations: [], label: null };
  const t = String(term).toLowerCase().trim();
  let id = ref.districtByName[t];
  if (!id) {
    const hit = Object.keys(ref.districtByName).find((n) => n.includes(t) || t.includes(n));
    if (hit) id = ref.districtByName[hit];
  }
  if (!id) return { id: null, stations: [], label: null };
  return { id, stations: ref.stationsOfDistrict[id] || [], label: ref.district[id] };
}

function clearReferenceCache() { _cache = null; }

module.exports = { loadReference, resolveCrimeType, resolveDistrict, clearReferenceCache };
