'use strict';
/**
 * KSP Copilot API — Catalyst Advanced I/O function.
 *
 * Backend for Challenge 1 (Intelligent Conversational AI for the KSP crime
 * database). Health endpoints + a guarded bulk-load endpoint used to seed the
 * Data Store; the NL -> validated-query -> ZCQL -> grounded-answer agent lands next.
 *
 * Design rule (../../docs/PLAN.md §2): the LLM never receives raw rows — it
 * produces a validated query, we execute it against Data Store, and ground the
 * answer in the returned records + expose the query and source FIR IDs.
 */
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const { runAgent } = require('./lib/agent');

const app = express();
app.use(express.json({ limit: '8mb' }));

const SEED_TOKEN = process.env.SEED_TOKEN || '';

// --- Health / readiness -----------------------------------------------------
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok', service: 'ksp-copilot-api', project: 'KSP-Crime-DB',
    version: '0.2.0', time: new Date().toISOString(),
  });
});
app.get('/health', (req, res) => res.status(200).json({ status: 'healthy' }));

app.get('/whoami', (req, res) => {
  try {
    const app_ = catalyst.initialize(req);
    res.status(200).json({ initialized: true, project: app_.PROJECT_ID || null });
  } catch (err) {
    res.status(500).json({ initialized: false, error: String((err && err.message) || err) });
  }
});

// --- Guarded bulk loader (used to seed Data Store; removed after loading) ----
function checkSeedAuth(req, res) {
  if (!SEED_TOKEN || req.get('x-seed-token') !== SEED_TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// POST /admin/load  { "table": "State", "rows": [ {..}, ... ] }
app.post('/admin/load', async (req, res) => {
  if (!checkSeedAuth(req, res)) return;
  const { table, rows } = req.body || {};
  if (!table || !Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Provide { table, rows: [...] }' });
  }
  try {
    const capp = catalyst.initialize(req);
    const ds = capp.datastore();
    const t = ds.table(table);
    const inserted = await t.insertRows(rows);
    res.status(200).json({ table, requested: rows.length, inserted: (inserted || []).length });
  } catch (err) {
    res.status(500).json({ table, error: String((err && err.message) || err) });
  }
});

// GET /admin/count?table=CaseMaster  -> row count via ZCQL (verify load)
app.get('/admin/count', async (req, res) => {
  if (!checkSeedAuth(req, res)) return;
  const table = req.query.table;
  if (!table) return res.status(400).json({ error: 'table query param required' });
  try {
    const capp = catalyst.initialize(req);
    const zcql = capp.zcql();
    const out = await zcql.executeZCQLQuery(`SELECT COUNT(ROWID) AS c FROM ${table}`);
    res.status(200).json({ table, result: out });
  } catch (err) {
    res.status(500).json({ table, error: String((err && err.message) || err) });
  }
});

// POST /admin/zcql  { "query": "SELECT ..." }  -> raw ZCQL (guarded; verification)
app.post('/admin/zcql', async (req, res) => {
  if (!checkSeedAuth(req, res)) return;
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const capp = catalyst.initialize(req);
    const rows = await capp.zcql().executeZCQLQuery(query);
    res.status(200).json({ query, count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ query, error: String((err && err.message) || err) });
  }
});

// --- NL -> grounded-query agent (GLM tool-loop over the FIR Data Store) ------
app.post('/query', async (req, res) => {
  const { question } = req.body || {};
  if (!question) return res.status(400).json({ error: 'Missing "question" in request body.' });
  try {
    const capp = catalyst.initialize(req);
    const out = await runAgent(capp, question);
    res.status(200).json(Object.assign({ question }, out));
  } catch (err) {
    res.status(500).json({ question, error: String((err && err.message) || err) });
  }
});

module.exports = app;
