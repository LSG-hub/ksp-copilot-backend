# KSP Copilot — Backend (Zoho Catalyst)

Catalyst project for **Challenge 1: Intelligent Conversational AI for KSP Crime Database**.
See `../docs/PLAN.md` for full architecture. Own GitHub repo.

## Responsibilities
- **Serverless Functions** — API + agent orchestration (NL → validated query plan → ZCSQL → grounded answer).
- **Data Store** — FIR schema (from `../Police_FIR_ER_Diagram.pdf`).
- **QuickML** — GLM LLM Serving + RAG (over `BriefFacts`).
- **Zia Services** — voice + Kannada pipeline.
- **Audit log** — every query (user/what/when) for explainability.

## Core rule
LLM never receives raw rows. It generates a **validated, whitelisted query** → we execute → ground the answer in results + expose the query and source FIR IDs. (Avoids the workshop's stuff-all-rows antipattern.)

## Constraints
- Functions: **30s timeout** → heavy/multi-step agent chains go to **Job Functions (15 min)**.
- Auth QuickML via CloudScale → Connections (`quickml.deployment_read`).
- Whitelist the frontend URL (CloudScale → Auth → Whitelisting) or CORS fails.

## Setup (once Catalyst account + credits ready)
```
npm install -g zcatalyst-cli
catalyst init      # Functions (Node 24) + Data Store
catalyst deploy
```
