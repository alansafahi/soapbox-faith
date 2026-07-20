#!/usr/bin/env -S deno run --allow-net --allow-env
// faith-research-assistant.ts — a minimal, runnable reference agent that uses the
// SoapBox Faith MCP server end-to-end. It shows the pattern any AI app should follow:
// verify Scripture before quoting it, then research with ORA + real sermons, and cite.
//
// Run it (no install beyond Deno):
//   deno run --allow-net --allow-env examples/faith-research-assistant.ts
//
// Optional — exercise the keyed path too (and create a real free API key):
//   SOAPBOX_SIGNUP_EMAIL="you@example.com" deno run --allow-net --allow-env examples/faith-research-assistant.ts
//   # or bring your own key:  SOAPBOX_API_KEY="..." deno run ...
//
// Everything here uses the FREE, keyless read tools by default — no account required.

const MCP_URL = Deno.env.get("SOAPBOX_MCP_URL") ??
  "https://foyekanoxpnkydoibaas.supabase.co/functions/v1/faith-mcp";
const SIGNUP_URL = MCP_URL.replace(/\/faith-mcp$/, "/faith-api-signup");

let apiKey = Deno.env.get("SOAPBOX_API_KEY") ?? "";

// --- tiny MCP (JSON-RPC 2.0 over Streamable HTTP) client -------------------
let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

// tools/call returns { content: [{ type: "text", text: "<json>" }], isError }.
// The tool's real result is JSON encoded in that text field.
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(`tool ${name} failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

// --- optional: self-serve a free API key (creates a real faith_api_keys row) ---
async function maybeSignUp() {
  const email = Deno.env.get("SOAPBOX_SIGNUP_EMAIL");
  if (apiKey || !email) return;
  const res = await fetch(SIGNUP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.api_key) { apiKey = data.api_key; console.log(`🔑 Got a free API key for ${email}\n`); }
  else console.log(`(signup skipped: ${data.error ?? res.status})\n`);
}

// --------------------------------------------------------------------------
async function main() {
  await maybeSignUp();

  const info = await rpc("initialize", {});
  console.log(`Connected to ${info.serverInfo.name} v${info.serverInfo.version} — ${(await rpc("tools/list", {})).tools.length} tools\n`);

  // 1) ALWAYS verify a quote before presenting it (anti-hallucination).
  const quote = "For God so loved the world";
  const v = await callTool("verify_scripture", { quote, reference: "John 3:16" });
  console.log(`✔ verify_scripture("${quote}") → verified=${v.verified}, ref=${v.match?.reference}`);

  // 2) Research a topic with ORA (grounded, KJV-cited study aid).
  const ora = await callTool("ask_ora", { question: "What does Romans 8 teach about suffering and hope?" });
  console.log(`\n🤖 ask_ora →\n${String(ora.answer).slice(0, 320)}...`);
  console.log(`   citations: ${(ora.citations ?? []).map((c: { reference?: string }) => c.reference).join(", ")}`);

  // 3) Find what real churches are preaching on the topic (consented sermons only).
  const sermons = await callTool("search_sermons", { query: "hope in suffering", match_count: 3 });
  console.log(`\n📖 search_sermons → ${sermons.count} results`);
  for (const r of (sermons.results ?? [])) {
    const at = (r.start_sec ?? null) !== null ? ` @ ${r.start_sec}s` : "";
    console.log(`   • "${r.title}" — ${r.church} (${r.scripture_ref ?? "n/a"})${at}`);
  }

  console.log(`\nDone. This whole flow used only free, keyless tools. Docs: https://soapboxsuperapp.com/developers`);
}

main().catch((e) => { console.error("Error:", e.message); Deno.exit(1); });
