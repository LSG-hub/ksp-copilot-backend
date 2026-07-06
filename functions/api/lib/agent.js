'use strict';
/** The agentic loop: GLM plans tool calls, we execute them against the FIR
 *  Data Store, feed results back, and iterate until GLM produces a grounded
 *  answer. Collects every executed ZCQL + source CrimeNos for the audit trail. */
const { chat } = require('./glm');
const { loadReference } = require('./reference');
const { TOOL_SCHEMAS, DISPATCH } = require('./tools');

const SYSTEM = `You are the KSP Investigator Copilot — an AI assistant for Karnataka State Police investigators querying a First Information Report (FIR) crime database.

Rules:
- ALWAYS use the provided tools to obtain facts. NEVER invent names, CrimeNos, counts, dates, or locations.
- Ground every statement strictly in tool results. When you mention specific cases, cite their CrimeNo.
- For a question about a person, use offender_cases AND co_offenders to reveal their case history and criminal network.
- For "where"/"hotspot"/"trend"/"how many" questions, use hotspots or crime_stats.
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

  for (let i = 0; i < maxIters; i++) {
    const r = await chat(app, { messages, tools: TOOL_SCHEMAS, max_tokens: 1300 });
    const calls = r.tool_calls || [];

    if (!calls.length) {
      return {
        answer: r.content || '', grounded: executed.length > 0, iterations: i + 1,
        executed_queries: executed, source_fir_ids: [...firIds], tool_trace: trace,
      };
    }

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
  return {
    answer: fin.content || '(no answer produced)', grounded: executed.length > 0, iterations: maxIters,
    executed_queries: executed, source_fir_ids: [...firIds], tool_trace: trace,
  };
}

module.exports = { runAgent };
