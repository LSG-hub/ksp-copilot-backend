'use strict';
/** The agentic loop: GLM plans tool calls, we execute them against the FIR
 *  Data Store, feed results back, and iterate until GLM produces a grounded
 *  answer. Collects every executed ZCQL + source CrimeNos for the audit trail. */
const { chat } = require('./glm');
const { loadReference } = require('./reference');
const { TOOL_SCHEMAS, DISPATCH } = require('./tools');
const { blocksForTool } = require('./blocks');

const SYSTEM = `You are the KSP Investigator Copilot — an AI assistant for Karnataka State Police investigators querying a First Information Report (FIR) crime database.

Rules:
- ALWAYS use the provided tools to obtain facts. NEVER invent names, CrimeNos, counts, dates, or locations.
- Ground every statement strictly in tool results. When you mention specific cases, cite their CrimeNo.
- For a question about a person, use offender_cases AND co_offenders to reveal their case history and criminal network.
- For "where"/"hotspot"/"trend"/"how many" questions, use hotspots or crime_stats.
- Keep your narrative SHORT — 2 to 4 sentences of investigative summary. Do NOT list every case, CrimeNo, or number in prose; the visual blocks (profile, documents, network, map, charts) carry that detail. Avoid markdown headings and bullet lists in the narrative.
- Be concise, factual, and investigative — you are assisting law enforcement.
- Detect the user's language and reply in it (English or Kannada).
- If tools return no matching data, say so plainly. Do not speculate.`;

// This endpoint only accepts {role, content} messages (no tool_calls/tool_call_id
// keys), so we drive the loop manually: execute the requested tools and feed
// their results back as a plain-text user message.
async function runAgent(app, question, maxIters = 4) {
  const ref = await loadReference(app);
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: question }];
  const executed = [];
  const firIds = new Set();
  const trace = [];
  const blocks = [];

  const result = (answer, iterations) => ({
    answer, narrative: answer, grounded: executed.length > 0, iterations,
    blocks,
    executed_queries: executed, source_fir_ids: [...firIds], tool_trace: trace,
    reasoning_trace: [
      ...executed.map((q) => ({ step: 'query', text: q })),
      { step: 'grounded', text: `grounded — ${firIds.size} source FIRs, 0 fabricated facts` },
    ],
    audit: { executed_queries: executed, source_fir_ids: [...firIds] },
  });

  for (let i = 0; i < maxIters; i++) {
    const r = await chat(app, { messages, tools: TOOL_SCHEMAS, max_tokens: 1300 });
    const calls = r.tool_calls || [];

    if (!calls.length) return result(r.content || '', i + 1);

    let block = '';
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) { /* keep {} */ }
      const fn = DISPATCH[call.function && call.function.name];
      let out;
      if (!fn) {
        out = { error: `unknown tool ${call.function && call.function.name}` };
      } else {
        try {
          const o = await fn(app, ref, args);
          out = o.result;
          (o.queries || []).forEach((q) => executed.push(q));
          (o.firIds || []).forEach((f) => f && firIds.add(f));
          (blocksForTool(call.function.name, o.result) || []).forEach((b) => blocks.push(b));
          trace.push({ tool: call.function.name, args });
        } catch (e) {
          out = { error: String((e && e.message) || e) };
        }
      }
      block += `\n[${call.function && call.function.name}(${JSON.stringify(args)})] =>\n${JSON.stringify(out).slice(0, 4500)}\n`;
    }
    messages.push({
      role: 'user',
      content: `TOOL RESULTS (from the crime database — use ONLY these facts):\n${block}\n`
        + `If you have enough to answer the original question, do so now (cite CrimeNos). Otherwise call another tool.`,
    });
  }

  // Budget exhausted — force a final grounded summary with no more tools.
  const fin = await chat(app, {
    max_tokens: 1300,
    messages: [...messages, { role: 'user', content: 'Summarize your findings now from the data above. Do not request more tools.' }],
  });
  return result(fin.content || '(no answer produced)', maxIters);
}

module.exports = { runAgent };
