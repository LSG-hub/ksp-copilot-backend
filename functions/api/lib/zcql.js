'use strict';
/** ZCQL helpers: run a query, flatten Catalyst's {Table:{col:val}} rows, and
 *  escape values. The agent NEVER lets the LLM emit raw SQL — tools build
 *  parameterized queries here with escaped, type-checked inputs. */

function flatten(rows) {
  // Catalyst returns [{TableName: {col: val, ...}, OtherTable: {...}}]
  return (rows || []).map((r) => Object.assign({}, ...Object.values(r)));
}

async function runZCQL(app, query) {
  const raw = await app.zcql().executeZCQLQuery(query);
  return { query, rows: flatten(raw) };
}

// Escape a string literal for a ZCQL WHERE clause (single quotes doubled; drop
// backslashes/semicolons; length-capped). Only ever used for values, never identifiers.
function escStr(s) {
  return String(s == null ? '' : s).replace(/[\\;]/g, '').replace(/'/g, "''").slice(0, 150);
}

// Coerce to a safe integer list for IN (...) clauses.
function intList(arr) {
  const xs = (arr || []).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n));
  return [...new Set(xs)];
}

module.exports = { runZCQL, flatten, escStr, intList };
