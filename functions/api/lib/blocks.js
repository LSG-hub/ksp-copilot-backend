'use strict';
/**
 * blocks.js — presentation layer.
 *
 * Maps a tool's grounded result → typed UI blocks the frontend renders
 * (see ../../../docs/FRONTEND_SPEC.md §3). Kept separate from tools.js so tools
 * stay pure data and presentation is swappable. Block DATA is always the real
 * query result — never fabricated.
 */

function offenderBlocks(r) {
  if (!r || r.found === false) return [];
  const cases = r.cases || [];
  const name = (r.offender && r.offender[0]) || 'Unknown';
  const districts = [...new Set(cases.map((c) => c.district).filter(Boolean))];
  const crimes = [...new Set(cases.map((c) => c.crime).filter(Boolean))];
  const dates = cases.map((c) => c.date).filter(Boolean).sort();
  const blocks = [{
    type: 'offender_profile', name,
    flags: ['Repeat offender'], base: districts[0] || null, first_seen: dates[0] || null,
    stats: [
      { label: 'Linked cases', value: cases.length },
      { label: 'Districts', value: districts.length },
      { label: 'Crime types', value: crimes.length },
    ],
  }, {
    type: 'fir_documents',
    cases: cases.map((c) => ({
      crime_no: c.crime_no, crime: c.crime, date: c.date,
      station: c.station, district: c.district, status: c.status, sections: c.sections || [],
    })),
  }, {
    type: 'timeline', title: 'Offender history',
    events: cases.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((c) => ({ date: c.date, label: c.crime, crime_no: c.crime_no })),
  }];
  const points = cases.filter((c) => c.lat && c.lng)
    .map((c) => ({ lat: c.lat, lng: c.lng, label: c.crime, crime_no: c.crime_no }));
  if (points.length) blocks.push({ type: 'map', title: 'Crime locations', points });
  return blocks;
}

function networkBlocks(r) {
  if (!r || r.found === false) return [];
  const tgt = (r.offender && r.offender[0]) || 'target';
  const assoc = r.associates || [];
  const maxW = assoc.reduce((m, a) => Math.max(m, a.shared_cases), 0) || 1;
  const nodes = [{ id: tgt, label: tgt, group: 'target', weight: maxW }];
  const edges = [];
  assoc.forEach((a) => {
    nodes.push({ id: a.name, label: a.name, group: 'associate', weight: a.shared_cases });
    edges.push({ source: tgt, target: a.name, weight: a.shared_cases });
  });
  return [{ type: 'network_graph', title: `${tgt} — co-offender network`, nodes, edges }];
}

function hotspotBlocks(r) {
  const dc = r.top_districts || [];
  if (!dc.length) return [];
  return [
    { type: 'map', title: 'Crime hotspots', district_counts: dc.map((d) => ({ district: d.district, count: d.cases })) },
    { type: 'bar_chart', title: 'Top districts by cases', items: dc.map((d) => ({ label: d.district, value: d.cases })) },
  ];
}

function statsBlocks(r) {
  const b = r.breakdown || [];
  if (!b.length) return [];
  if (r.group_by === 'year') {
    return [{ type: 'line_chart', title: 'Cases by year', x: b.map((x) => x.key), series: [{ name: 'cases', data: b.map((x) => x.count) }] }];
  }
  if (r.group_by === 'status') {
    return [{ type: 'donut', title: 'Case status', items: b.map((x) => ({ label: x.key, value: x.count })) }];
  }
  return [{ type: 'bar_chart', title: `Cases by ${r.group_by}`, items: b.map((x) => ({ label: x.key, value: x.count })) }];
}

function caseBlocks(r) {
  if (!r || r.found === false) return [];
  return [{ type: 'case_card', ...r }];
}

function listBlocks(r) {
  const cs = r.cases || [];
  if (!cs.length) return [];
  const blocks = [{
    type: 'case_table', columns: ['CrimeNo', 'Crime', 'District', 'Status'],
    rows: cs.map((c) => ({ crime_no: c.crime_no, crime: c.crime, district: c.district, status: c.status })),
  }];
  const points = cs.filter((c) => c.lat && c.lng).map((c) => ({ lat: c.lat, lng: c.lng, label: c.crime, crime_no: c.crime_no }));
  if (points.length) blocks.push({ type: 'map', title: 'Matching cases', points });
  return blocks;
}

function searchBlocks(r) {
  const m = r.matches || [];
  if (!m.length) return [];
  return [{ type: 'bar_chart', title: 'Matching offenders (cases each)', items: m.map((x) => ({ label: x.name, value: x.case_count })) }];
}

const BUILDERS = {
  offender_cases: offenderBlocks,
  co_offenders: networkBlocks,
  hotspots: hotspotBlocks,
  crime_stats: statsBlocks,
  case_details: caseBlocks,
  list_cases: listBlocks,
  search_offenders: searchBlocks,
};

function blocksForTool(toolName, result) {
  const fn = BUILDERS[toolName];
  if (!fn) return [];
  try { return fn(result) || []; } catch (e) { return []; }
}

module.exports = { blocksForTool };
