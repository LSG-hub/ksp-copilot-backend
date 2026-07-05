'use strict';
/**
 * KSP Copilot API — Catalyst Advanced I/O function.
 *
 * Serves the backend for Challenge 1 (Intelligent Conversational AI for the KSP
 * crime database). This first cut is a health-checkable skeleton; the NL ->
 * validated-query -> ZCQL-over-DataStore -> grounded-answer agent lands next.
 *
 * Design rule (see ../../docs/PLAN.md §2): the LLM never receives raw rows — it
 * produces a validated query, we execute it against Data Store, and ground the
 * answer in the returned records + expose the query and source FIR IDs.
 */
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const app = express();
app.use(express.json());

// --- Health / readiness -----------------------------------------------------
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'ksp-copilot-api',
    project: 'Project-Rainfall',
    version: '0.1.0',
    time: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => res.status(200).json({ status: 'healthy' }));

// Proves the Catalyst SDK initializes against the project (Data Store etc.).
app.get('/whoami', (req, res) => {
  try {
    const app_ = catalyst.initialize(req);
    res.status(200).json({ initialized: true, project: app_.PROJECT_ID || null });
  } catch (err) {
    res.status(500).json({ initialized: false, error: String(err && err.message || err) });
  }
});

// --- Placeholder for the NL -> grounded-query agent (built next) ------------
app.post('/query', (req, res) => {
  const { question } = req.body || {};
  if (!question) {
    return res.status(400).json({ error: 'Missing "question" in request body.' });
  }
  res.status(200).json({
    question,
    answer: 'Query agent not yet implemented — Data Store schema + loader + NL->ZCQL agent are the next build steps.',
    grounded: false,
    executed_query: null,
    source_fir_ids: [],
  });
});

module.exports = app;
