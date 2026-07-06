'use strict';
/** The agent's tool catalog: safe, parameterized ZCQL queries over the FIR
 *  schema. The LLM chooses tools + args; it never writes SQL. Every tool returns
 *  its executed queries and touched CrimeNos for the audit trail. */
const { runZCQL, escStr, intList } = require('./zcql');
const { resolveCrimeType, resolveDistrict } = require('./reference');

// ---- Offender name resolution (LIKE needs a search index we don't have, so we
// resolve against a cached distinct-name list and query by exact match) --------
let _names = null;
async function allNames(app) {
  if (_names) return _names;
  const { rows } = await runZCQL(app, 'SELECT AccusedName FROM Accused');
  _names = [...new Set(rows.map((r) => r.AccusedName).filter(Boolean))];
  return _names;
}
async function resolveNames(app, q) {
  const ql = String(q || '').trim();
  if (!ql) return [];
  // Exact match FIRST via a direct query — robust against the cached list being
  // truncated by ZCQL's default row cap.
  const exRows = (await runZCQL(app, `SELECT AccusedName FROM Accused WHERE AccusedName = '${escStr(ql)}'`)).rows;
  if (exRows.length) return [exRows[0].AccusedName];
  // Fuzzy fallback over the (best-effort) cached name list.
  const names = await allNames(app);
  const low = ql.toLowerCase();
  const sub = [...new Set(names.filter((n) => n.toLowerCase().includes(low)))];
  if (sub.length) return sub.slice(0, 8);
  const toks = low.split(/\s+/).filter((t) => t.length > 2);
  return [...new Set(names.filter((n) => toks.some((t) => n.toLowerCase().includes(t))))].slice(0, 8);
}

function inStr(arr) { return arr.map((n) => `'${escStr(n)}'`).join(','); }

// ZCQL ignores SELECT aliases, so COUNT(ROWID) comes back keyed as "COUNT(ROWID)".
function countOf(r) {
  if (!r) return 0;
  const v = r['COUNT(ROWID)'] != null ? r['COUNT(ROWID)']
    : (r.CNT != null ? r.CNT : (Object.entries(r).find(([k]) => /count/i.test(k)) || [])[1]);
  return parseInt(v || 0, 10);
}

function buildWhere(ref, f = {}) {
  const conds = [];
  const applied = {};
  if (f.crime_type) {
    const c = resolveCrimeType(ref, f.crime_type);
    if (c.ids.length) { conds.push(`CrimeMinorHeadID IN (${intList(c.ids).join(',')})`); applied.crime_type = c.label; }
  }
  if (f.district) {
    const d = resolveDistrict(ref, f.district);
    if (d.stations.length) { conds.push(`PoliceStationID IN (${intList(d.stations).join(',')})`); applied.district = d.label; }
  }
  if (f.status) {
    const s = ref.statusByName[String(f.status).toLowerCase()];
    if (s) { conds.push(`CaseStatusID = ${parseInt(s, 10)}`); applied.status = ref.status[s]; }
  }
  if (f.year) {
    const y = parseInt(f.year, 10);
    if (Number.isFinite(y)) { conds.push(`CrimeRegisteredDate >= '${y}-01-01' AND CrimeRegisteredDate < '${y + 1}-01-01'`); applied.year = y; }
  }
  return { clause: conds.length ? ' WHERE ' + conds.join(' AND ') : '', applied };
}

function enrichCase(ref, c) {
  const u = ref.unit[c.PoliceStationID];
  return {
    crime_no: c.CrimeNo, date: c.CrimeRegisteredDate,
    crime: ref.subHead[c.CrimeMinorHeadID] || c.CrimeMinorHeadID,
    status: ref.status[c.CaseStatusID] || c.CaseStatusID,
    district: u ? ref.district[u.district] : null, station: u ? u.name : null,
    lat: c.latitude, lng: c.longitude,
  };
}

// ---------------------------------------------------------------- tools --------
async function offender_cases(app, ref, { name }) {
  const q = [], firIds = [];
  const names = await resolveNames(app, name);
  if (!names.length) return { result: { found: false, message: `No accused matching "${name}".` }, queries: q, firIds };
  const q1 = `SELECT CaseMasterID FROM Accused WHERE AccusedName IN (${inStr(names)})`;
  q.push(q1);
  const ids = intList((await runZCQL(app, q1)).rows.map((r) => r.CaseMasterID));
  if (!ids.length) return { result: { found: false, offender: names }, queries: q, firIds };
  const q2 = `SELECT CaseMasterID, CrimeNo, CrimeRegisteredDate, CrimeMinorHeadID, CaseStatusID, PoliceStationID, latitude, longitude FROM CaseMaster WHERE CaseMasterID IN (${ids.join(',')})`;
  q.push(q2);
  const cases = (await runZCQL(app, q2)).rows.map((c) => { firIds.push(c.CrimeNo); return enrichCase(ref, c); });
  cases.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { result: { offender: names, total_cases: cases.length, cases }, queries: q, firIds };
}

async function co_offenders(app, ref, { name }) {
  const q = [];
  const names = await resolveNames(app, name);
  if (!names.length) return { result: { found: false, message: `No accused matching "${name}".` }, queries: q, firIds: [] };
  const q1 = `SELECT CaseMasterID FROM Accused WHERE AccusedName IN (${inStr(names)})`;
  q.push(q1);
  const ids = intList((await runZCQL(app, q1)).rows.map((r) => r.CaseMasterID));
  if (!ids.length) return { result: { found: false }, queries: q, firIds: [] };
  const q2 = `SELECT AccusedName, CaseMasterID FROM Accused WHERE CaseMasterID IN (${ids.join(',')})`;
  q.push(q2);
  const counts = {};
  (await runZCQL(app, q2)).rows.forEach((r) => {
    if (names.includes(r.AccusedName)) return;
    counts[r.AccusedName] = (counts[r.AccusedName] || 0) + 1;
  });
  const network = Object.entries(counts).map(([n, c]) => ({ name: n, shared_cases: c }))
    .sort((a, b) => b.shared_cases - a.shared_cases);
  return { result: { offender: names, network_size: network.length, associates: network }, queries: q, firIds: [] };
}

async function search_offenders(app, ref, { name }) {
  const names = await resolveNames(app, name);
  if (!names.length) return { result: { matches: [] }, queries: [], firIds: [] };
  const q1 = `SELECT AccusedName, CaseMasterID FROM Accused WHERE AccusedName IN (${inStr(names)})`;
  const counts = {};
  (await runZCQL(app, q1)).rows.forEach((r) => { counts[r.AccusedName] = (counts[r.AccusedName] || 0) + 1; });
  const matches = Object.entries(counts).map(([n, c]) => ({ name: n, case_count: c })).sort((a, b) => b.case_count - a.case_count);
  return { result: { matches }, queries: [q1], firIds: [] };
}

async function case_details(app, ref, { crime_no }) {
  const q = [];
  const cq = `SELECT CaseMasterID, CrimeNo, CrimeRegisteredDate, CrimeMajorHeadID, CrimeMinorHeadID, CaseStatusID, GravityOffenceID, PoliceStationID, latitude, longitude, BriefFacts FROM CaseMaster WHERE CrimeNo = '${escStr(crime_no)}'`;
  q.push(cq);
  const crows = (await runZCQL(app, cq)).rows;
  if (!crows.length) return { result: { found: false, message: `No case with CrimeNo ${crime_no}.` }, queries: q, firIds: [] };
  const c = crows[0]; const id = parseInt(c.CaseMasterID, 10);
  const [vic, acc, sec] = await Promise.all([
    runZCQL(app, `SELECT VictimName, AgeYear, GenderID FROM Victim WHERE CaseMasterID = ${id}`),
    runZCQL(app, `SELECT AccusedName, AgeYear, GenderID, PersonID FROM Accused WHERE CaseMasterID = ${id}`),
    runZCQL(app, `SELECT ActID, SectionID FROM ActSectionAssociation WHERE CaseMasterID = ${id}`),
  ]);
  q.push(`... +victims/accused/sections for case ${id}`);
  const u = ref.unit[c.PoliceStationID];
  return {
    result: {
      found: true, crime_no: c.CrimeNo, date: c.CrimeRegisteredDate,
      crime_head: ref.head[c.CrimeMajorHeadID], crime_type: ref.subHead[c.CrimeMinorHeadID],
      gravity: ref.gravity[c.GravityOffenceID], status: ref.status[c.CaseStatusID],
      district: u ? ref.district[u.district] : null, station: u ? u.name : null,
      location: { lat: c.latitude, lng: c.longitude }, brief_facts: c.BriefFacts,
      victims: vic.rows, accused: acc.rows,
      sections: sec.rows.map((s) => `${s.ActID} ${s.SectionID}`),
    }, queries: q, firIds: [c.CrimeNo],
  };
}

async function crime_stats(app, ref, args = {}) {
  const group_by = (args.group_by || 'crime_type').toLowerCase();
  const { clause, applied } = buildWhere(ref, args);
  const q = [];
  let stats = [];
  if (group_by === 'year') {
    for (let y = 2022; y <= 2026; y++) {
      const wc = clause ? clause + ` AND CrimeRegisteredDate >= '${y}-01-01' AND CrimeRegisteredDate < '${y + 1}-01-01'`
        : ` WHERE CrimeRegisteredDate >= '${y}-01-01' AND CrimeRegisteredDate < '${y + 1}-01-01'`;
      const qq = `SELECT COUNT(ROWID) FROM CaseMaster${wc}`; q.push(qq);
      stats.push({ key: String(y), count: countOf((await runZCQL(app, qq)).rows[0]) });
    }
  } else {
    const col = { crime_type: 'CrimeMinorHeadID', district: 'PoliceStationID', status: 'CaseStatusID', gravity: 'GravityOffenceID' }[group_by] || 'CrimeMinorHeadID';
    const qq = `SELECT ${col}, COUNT(ROWID) FROM CaseMaster${clause} GROUP BY ${col}`; q.push(qq);
    const rows = (await runZCQL(app, qq)).rows;
    const agg = {};
    rows.forEach((r) => {
      let key;
      if (group_by === 'crime_type') key = ref.subHead[r[col]] || r[col];
      else if (group_by === 'district') { const u = ref.unit[r[col]]; key = u ? ref.district[u.district] : `Unit ${r[col]}`; }
      else if (group_by === 'status') key = ref.status[r[col]] || r[col];
      else key = ref.gravity[r[col]] || r[col];
      agg[key] = (agg[key] || 0) + countOf(r);
    });
    stats = Object.entries(agg).map(([k, c]) => ({ key: k, count: c }));
  }
  stats.sort((a, b) => b.count - a.count);
  return { result: { group_by, filters: applied, total: stats.reduce((s, x) => s + x.count, 0), breakdown: stats.slice(0, 20) }, queries: q, firIds: [] };
}

async function hotspots(app, ref, args = {}) {
  const { clause, applied } = buildWhere(ref, { crime_type: args.crime_type });
  const qq = `SELECT PoliceStationID, COUNT(ROWID) FROM CaseMaster${clause} GROUP BY PoliceStationID`;
  const rows = (await runZCQL(app, qq)).rows;
  const byDist = {};
  const stations = rows.map((r) => {
    const u = ref.unit[r.PoliceStationID]; const n = countOf(r);
    const dist = u ? ref.district[u.district] : null;
    if (dist) byDist[dist] = (byDist[dist] || 0) + n;
    return { station: u ? u.name : `Unit ${r.PoliceStationID}`, district: dist, cases: n };
  }).sort((a, b) => b.cases - a.cases).slice(0, 10);
  const districts = Object.entries(byDist).map(([d, c]) => ({ district: d, cases: c })).sort((a, b) => b.cases - a.cases).slice(0, 10);
  return { result: { filters: applied, top_districts: districts, top_stations: stations }, queries: [qq], firIds: [] };
}

async function list_cases(app, ref, args = {}) {
  const { clause, applied } = buildWhere(ref, args);
  const lim = Math.min(parseInt(args.limit, 10) || 25, 50);
  const qq = `SELECT CaseMasterID, CrimeNo, CrimeRegisteredDate, CrimeMinorHeadID, CaseStatusID, PoliceStationID, latitude, longitude FROM CaseMaster${clause} LIMIT ${lim}`;
  const cases = (await runZCQL(app, qq)).rows.map((c) => enrichCase(ref, c));
  return { result: { filters: applied, count: cases.length, cases }, queries: [qq], firIds: cases.map((c) => c.crime_no) };
}

// ---- OpenAI-style tool schemas advertised to GLM -----------------------------
const TOOL_SCHEMAS = [
  { type: 'function', function: { name: 'search_offenders', description: 'Find accused persons by (partial) name and how many cases each appears in.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'offender_cases', description: 'List every case an accused person is linked to (crime type, date, district, status, coordinates). Use to build an offender history.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'co_offenders', description: 'Reconstruct an offender\'s criminal network: who else was accused alongside them, ranked by shared cases.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'case_details', description: 'Full dossier for one FIR by its CrimeNo: victims, accused, legal sections, status, location, brief facts.', parameters: { type: 'object', properties: { crime_no: { type: 'string' } }, required: ['crime_no'] } } },
  { type: 'function', function: { name: 'crime_stats', description: 'Aggregate case counts grouped by crime_type | district | year | status | gravity, with optional filters.', parameters: { type: 'object', properties: { group_by: { type: 'string', enum: ['crime_type', 'district', 'year', 'status', 'gravity'] }, crime_type: { type: 'string' }, district: { type: 'string' }, year: { type: 'integer' }, status: { type: 'string' } }, required: ['group_by'] } } },
  { type: 'function', function: { name: 'hotspots', description: 'Top crime hotspot districts and police stations by case volume, optionally for a crime type.', parameters: { type: 'object', properties: { crime_type: { type: 'string' } } } } },
  { type: 'function', function: { name: 'list_cases', description: 'List individual cases matching filters (crime_type, district, year, status).', parameters: { type: 'object', properties: { crime_type: { type: 'string' }, district: { type: 'string' }, year: { type: 'integer' }, status: { type: 'string' }, limit: { type: 'integer' } } } } },
];

const DISPATCH = { search_offenders, offender_cases, co_offenders, case_details, crime_stats, hotspots, list_cases };

module.exports = { TOOL_SCHEMAS, DISPATCH };
