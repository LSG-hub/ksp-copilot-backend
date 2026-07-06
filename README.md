<div align="center">

# 🛡️ KSP Investigator Copilot — Backend

**Grounded, agentic conversational AI over a First Information Report (FIR) crime database.**
Built for the Karnataka State Police **Datathon 2026 · Challenge 1**.

`Zoho Catalyst` · `Node.js 24` · `GLM-4.7-Flash` · `ZCQL Data Store`

</div>

---

## What it does

An investigator asks a question in natural language — *"What other crimes and associates is Harish
Shetty linked to?"* — and the API responds with a **grounded briefing document**: a narrative plus
typed UI blocks (offender profile, prior-case documents, co-offender network, hotspot map, trends),
**every fact backed by the exact query that produced it**.

> **The core principle:** the LLM never sees raw rows and never writes SQL. It selects from a set of
> **safe, parameterized query tools**; the visual data is bound from real results. That makes the
> system *impossible to hallucinate* and *fully auditable* — every response ships the queries it ran
> and the source FIR numbers.

## Architecture

```
POST /query { question }
      │
      ▼
┌───────────────┐   plans tool calls   ┌──────────────┐
│  GLM-4.7-Flash │ ───────────────────▶ │  agent loop  │  (lib/agent.js)
│  (QuickML)     │ ◀─────────────────── │              │
└───────────────┘   grounded results   └──────┬───────┘
      ▲                                        │ executes
      │ narrative                              ▼
      │                                 ┌──────────────┐   chained ZCQL   ┌──────────────┐
      └──────────  briefing document ◀──│ query tools  │ ───────────────▶ │  Data Store  │
                   { narrative,         │ (lib/tools)  │                  │  28 FIR tbls │
                     blocks[],          └──────┬───────┘                  └──────────────┘
                     reasoning_trace,          │ maps results → UI blocks
                     audit }            ┌──────▼───────┐
                                        │  lib/blocks  │
                                        └──────────────┘
```

### Module layout (`functions/api/`)
| File | Responsibility |
|---|---|
| `index.js` | Express Advanced I/O function — routes; `/query` → agent. Admin routes are token-gated. |
| `lib/agent.js` | The agentic loop: plan → execute tools → feed results back → grounded answer + audit. |
| `lib/tools.js` | 7 safe, parameterized **query tools** (data only). Never lets the LLM write SQL. |
| `lib/blocks.js` | **Presentation layer** — maps each tool result → typed UI blocks. |
| `lib/reference.js` | Cached lookup tables (crime / district / status) for ID→name enrichment. |
| `lib/glm.js` | GLM-4.7-Flash chat client (auth via the `quickml_conn` connection). |
| `lib/zcql.js` | ZCQL helpers — run, flatten, escape. |
| `datastore/build_iac.py` | The 28-table FIR schema as Catalyst Infrastructure-as-Code. |
| `datastore/load_data.py` | Bulk loader (CSV → Data Store via the guarded `/admin/load`). |

### Query tools
`search_offenders` · `offender_cases` · `co_offenders` · `case_details` · `crime_stats` · `hotspots` · `list_cases`

## API

| Method | Route | Description |
|---|---|---|
| `GET` | `/` `/health` `/whoami` | Health / readiness |
| `POST` | `/query` | **The product.** `{ question }` → grounded briefing document |
| `POST` | `/admin/{load,count,zcql}` | Seeding/ops — token-gated, disabled by default |

<details><summary><b>Example <code>/query</code> response (abridged)</b></summary>

```jsonc
{
  "question": "What other crimes and associates is Harish Shetty linked to?",
  "narrative": "Harish Shetty is a repeat offender linked to 15 cases across 3 districts...",
  "blocks": [
    { "type": "offender_profile", "name": "Harish Shetty", "stats": [{ "label": "Linked cases", "value": 15 }] },
    { "type": "fir_documents", "cases": [ /* 15 */ ] },
    { "type": "timeline", "events": [ /* 15 */ ] },
    { "type": "map", "points": [ /* 15 */ ] },
    { "type": "network_graph", "nodes": [ /* 7 */ ], "edges": [ /* 6 */ ] }
  ],
  "grounded": true,
  "reasoning_trace": [ { "step": "query", "text": "SELECT CaseMasterID FROM Accused WHERE ..." } ],
  "audit": { "executed_queries": [ ... ], "source_fir_ids": ["143011003202600001", ...] }
}
```
See the frontend spec (`docs/FRONTEND_SPEC.md`) for the full block vocabulary.
</details>

## Develop & deploy

Prerequisites: Node 18+, the Catalyst CLI (`npm i -g zcatalyst-cli`), and access to the Catalyst
project. All CLI commands target the **India** data center.

```bash
cd functions/api && npm install          # install function deps
catalyst --dc in deploy --only functions:api
```

### Seeding the Data Store (one-time / on data refresh)
```bash
# 1. set a token in functions/api/catalyst-config.json (SEED_TOKEN) and deploy
# 2. load all 28 tables:
cd datastore && KSP_SEED_TOKEN=<token> python3 load_data.py
# 3. reset SEED_TOKEN to "" and redeploy — never commit the token (public repo)
```

## Notes & constraints
- **GLM shape** is custom (`{ response, tool_calls }`, not OpenAI's `choices`); its `messages` accept
  only `{ role, content }`. The agent drives the tool loop manually and feeds results back as text.
- **ZCQL**: no JOINs without a `foreignkey` column → chained single-table queries; `LIKE` needs a
  search index → exact-match resolution; SELECT aliases are ignored; can't `ORDER BY` an aggregate.
- **Dev Data Store caps**: 5,000 rows/table, 25,000/project (Production is unlimited).

## License
MIT
