'use strict';
/** GLM-4.7-Flash chat client (QuickML LLM Serving, OpenAI-compatible).
 *  Auth flows through the console-created `quickml_conn` Connection. */
const GLM_URL = process.env.GLM_URL
  || 'https://api.catalyst.zoho.in/quickml/v1/project/48172000000034002/glm/chat';
const ORG = process.env.CATALYST_ORG || '60074558778';
const MODEL = process.env.GLM_MODEL || 'crm-di-glm47b_30b_it';
const CONNECTION = process.env.QUICKML_CONNECTION || 'quickml_conn';

async function authHeaders(app) {
  const creds = await app.connections().getConnectionCredentials(CONNECTION);
  const headers = Object.assign({}, creds && creds.headers ? creds.headers : {});
  let auth = headers.Authorization || headers.authorization;
  if (!auth && creds && creds.parameters) {
    const tok = creds.parameters.access_token || creds.parameters.oauthtoken || creds.parameters.token;
    if (tok) auth = `Zoho-oauthtoken ${tok}`;
  }
  return { 'Content-Type': 'application/json', 'CATALYST-ORG': ORG, ...(auth ? { Authorization: auth } : {}) };
}

async function chat(app, { messages, tools, temperature = 0.2, max_tokens = 800 }) {
  const headers = await authHeaders(app);
  const body = { model: MODEL, messages, temperature, max_tokens, stream: false };
  if (tools) body.tools = tools;
  const resp = await fetch(GLM_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`GLM ${resp.status}: ${text.slice(0, 400)}`);
  const raw = JSON.parse(text);
  // QuickML GLM shape: { response: "<text>", tool_calls: [...], usage, model }
  // (fall back to OpenAI shape just in case).
  const oai = raw.choices && raw.choices[0] && raw.choices[0].message;
  return {
    content: (oai && oai.content) || raw.response || '',
    tool_calls: (oai && oai.tool_calls) || raw.tool_calls || [],
    usage: raw.usage,
    raw,
  };
}

module.exports = { chat, MODEL };
