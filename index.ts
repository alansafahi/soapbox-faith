// faith-mcp Edge Function — Model Context Protocol (MCP) server for the Faith
// Content API. Lets any Claude/agent add SoapBox as a faith-content tool
// (discovery + the agent channel; see docs/agent-products-build-plan.md #2).
//
// Thin protocol adapter: speaks MCP (JSON-RPC 2.0 over the Streamable-HTTP
// transport, JSON responses) and forwards each tools/call to the deployed
// faith-content-api, which owns auth, metering, and the content logic. One
// source of truth.
//
// Auth: the agent passes its SoapBox API key as `Authorization: Bearer <key>`
// or `x-api-key`; we forward it to faith-content-api (which validates + meters).
//
// Connect from Claude (remote MCP): add this function's URL with the key header.

// (Standalone public build: the deployed SoapBox server additionally wraps the
// handler with internal request metrics; that observability shim is omitted here.)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const PROTOCOL_VERSION = "2025-06-18";
const SERVER = { name: "soapbox-faith", version: "1.1.1" };
// Defaults to the public production host so this server works out of the box
// (all forwarded read tools are keyless); override SUPABASE_URL to point elsewhere.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://foyekanoxpnkydoibaas.supabase.co";
const API_URL = `${SUPABASE_URL}/functions/v1/faith-content-api`;
const X402_URL = `${SUPABASE_URL}/functions/v1/x402-faith`;

// MCP tool annotations — required for the Anthropic Claude Connectors Directory
// review (per-tool annotations). Schema (modelcontextprotocol.io ToolAnnotations):
//   title           human-friendly display name
//   readOnlyHint     true = tool does not modify its environment
//   destructiveHint  true = may perform irreversible/destructive updates (none here)
//   idempotentHint   true = repeated calls with same args have no additional effect
//   openWorldHint    true = interacts with external/dynamic data beyond a closed set
// Injected into tools/list below (keyed by tool name).
type ToolAnnotations = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};
const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // --- READ-ONLY (readOnlyHint: true, destructiveHint: false) ---
  ask_ora:              { title: "Ask ORA", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  verify_scripture:     { title: "Verify Scripture", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_verse:            { title: "Get Bible Verse", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  lookup_strongs:       { title: "Look Up Strong's Lexicon", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  browse_catalog:       { title: "Browse Catalog", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  search_sermons:       { title: "Search Sermons", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_sermon:           { title: "Get Sermon", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  find_churches:        { title: "Find Churches", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  score_doctrinal_fit:  { title: "Score Doctrinal Fit", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_lectionary:       { title: "Get Lectionary Readings", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_credit_balance:   { title: "Get Credit Balance", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  check_prayer_status:  { title: "Check Prayer Status", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_faith_context:    { title: "Get Faith Context", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  // --- WRITE / ACTION (readOnlyHint: false, destructiveHint: false — none destructive) ---
  purchase_sermon:      { title: "Purchase a Sermon", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  purchase_bundle:      { title: "Purchase a Bundle", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  submit_prayer_request:{ title: "Submit Prayer Request", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  give_to_church:       { title: "Give to a Church", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  synthesize_speech:    { title: "Synthesize Speech", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // --- x402 keyless payment (agent-native; also a write/action) ---
  pay_with_x402:        { title: "Pay with x402 (USDC on Base)", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

const TOOLS = [
  {
    name: "verify_scripture",
    description:
      "Verify whether a quote is real Scripture and cited correctly (anti-hallucination). " +
      "Returns whether it matches a real verse, the canonical KJV reference + text, a confidence " +
      "score, and — if you pass a claimed reference — whether the attribution is correct. " +
      "Use this before presenting any Bible quote to avoid misquotes/fabrications.",
    inputSchema: {
      type: "object",
      properties: {
        quote: { type: "string", description: "The quote to verify." },
        reference: { type: "string", description: "Optional claimed reference, e.g. 'John 3:16'." },
      },
      required: ["quote"],
    },
  },
  {
    name: "get_verse",
    description: "Look up a public-domain KJV Bible verse by book, chapter, and verse.",
    inputSchema: {
      type: "object",
      properties: {
        book: { type: "string", description: "Book name, e.g. 'John' or 'Psalms'." },
        chapter: { type: "integer" },
        verse: { type: "integer" },
      },
      required: ["book", "chapter", "verse"],
    },
  },
  {
    name: "lookup_strongs",
    description: "Look up a Strong's Greek/Hebrew lexicon entry (lemma, transliteration, gloss, definition).",
    inputSchema: {
      type: "object",
      properties: { strongs_number: { type: "string", description: "e.g. 'G26' or 'H7225'." } },
      required: ["strongs_number"],
    },
  },
  {
    name: "find_churches",
    description:
      "Find churches near a location from SoapBox's public church directory. Given latitude/longitude " +
      "(and optional radius, denomination filter), returns nearby churches with name, denomination, " +
      "city/state/country, website, distance in miles, and whether the church is on SoapBox (with its " +
      "community id for deep-linking). Public directory data only — no personal contact info.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Latitude of the search center." },
        lng: { type: "number", description: "Longitude of the search center." },
        radius_miles: { type: "number", description: "Search radius in miles (default 25, max 100)." },
        denomination: { type: "string", description: "Optional denomination filter, e.g. 'Baptist'." },
        limit: { type: "integer", description: "Max results (default 10, max 25)." },
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "submit_prayer_request",
    description:
      "Post a prayer request to SoapBox's prayer wall ON BEHALF OF A USER, so their community can pray " +
      "for it. Requires the user's consent_token (which they generate in the SoapBox app and which must " +
      "include the 'prayer:write' scope) — an API key alone is not enough to act for a user. Returns the " +
      "new prayer_id; use check_prayer_status to see how many are praying.",
    inputSchema: {
      type: "object",
      properties: {
        consent_token: { type: "string", description: "The user's SoapBox consent token (scope prayer:write)." },
        content: { type: "string", description: "The prayer request text." },
        is_private: { type: "boolean", description: "If true, keep it private to the user (default false = shared so others can pray)." },
      },
      required: ["consent_token", "content"],
    },
  },
  {
    name: "check_prayer_status",
    description:
      "Check how many people are praying for a prayer request previously submitted for a user (and whether " +
      "it's been marked answered). Requires the same user's consent_token; only returns status for that " +
      "user's own prayers.",
    inputSchema: {
      type: "object",
      properties: {
        consent_token: { type: "string", description: "The user's SoapBox consent token (scope prayer:write)." },
        prayer_id: { type: "string", description: "The prayer_id returned by submit_prayer_request." },
      },
      required: ["consent_token", "prayer_id"],
    },
  },
  {
    name: "give_to_church",
    description:
      "Make a one-time donation to a church ON BEHALF OF A USER, within the spending caps they pre-authorized. " +
      "Requires the user's consent_token with the 'giving:write' scope (bound to this agent) and a card they " +
      "saved in the SoapBox app. The gift goes straight to the church (passthrough — SoapBox takes no cut). " +
      "Rejected if the amount exceeds the per-gift or monthly cap. Pass a stable idempotency_key to avoid " +
      "double-charging on retries. Amounts are in the smallest currency unit (cents).",
    inputSchema: {
      type: "object",
      properties: {
        consent_token: { type: "string", description: "The user's SoapBox consent token (scope giving:write, bound to this agent)." },
        community_id: { type: "string", description: "The church's SoapBox community id (e.g. from find_churches' soapbox_community_id)." },
        amount_cents: { type: "integer", description: "Gift amount in cents (e.g. 2500 = $25). Must be within the user's caps." },
        currency: { type: "string", description: "Optional ISO currency (defaults to the church's currency)." },
        note: { type: "string", description: "Optional note to the church." },
        idempotency_key: { type: "string", description: "Stable key to make retries safe (no double-charge)." },
      },
      required: ["consent_token", "community_id", "amount_cents"],
    },
  },
  {
    name: "ask_ora",
    description:
      "Ask ORA, SoapBox's Scripture study aid, a Bible or faith question. Returns a grounded answer that cites " +
      "public-domain (KJV) passages, plus the citations used. ORA is a STUDY AID — not a pastor, counselor, or " +
      "therapist; for personal crises or pastoral/medical needs it points to a trusted pastor or professional. " +
      "Use this for explanatory/study questions ('what does Romans 8 teach about...', 'where does the Bible " +
      "discuss...'); use get_verse when you just need a verse's text.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The Bible or faith question to ask ORA (max 1000 chars)." },
      },
      required: ["question"],
    },
  },
  {
    name: "search_sermons",
    description:
      "Semantically search real sermons on SoapBox that pastors have explicitly opted in to share with AI agents. " +
      "Returns ranked transcript excerpts with the sermon title, church, speaker, scripture reference, and a " +
      "start-time (seconds) so you can cite the exact moment. Use this to find what churches are actually preaching " +
      "on a topic. Only consented, published sermons are searchable.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for (a topic, phrase, or question). Max 1000 chars." },
        church_id: { type: "string", description: "Optional SoapBox community id to scope the search to one church." },
        match_count: { type: "integer", description: "Max results to return (1-20, default 6)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_sermon",
    description:
      "Fetch full metadata and (optionally) the transcript for ONE sermon by its id — typically a sermon_id " +
      "returned by search_sermons. Only returns sermons a pastor has opted in to share with agents; otherwise " +
      "returns not-found. If the sermon is paid and you haven't purchased it, the transcript is withheld and a " +
      "price is returned — call purchase_sermon first. Free sermons return the transcript directly.",
    inputSchema: {
      type: "object",
      properties: {
        sermon_id: { type: "string", description: "The sermon's id (from search_sermons results)." },
        include_transcript: { type: "boolean", description: "Include the full transcript text (default true)." },
      },
      required: ["sermon_id"],
    },
  },
  {
    name: "purchase_sermon",
    description:
      "Buy permanent access to a paid sermon using your prepaid marketplace credits. SoapBox is the Merchant of " +
      "Record: the church keeps 70% and SoapBox takes a 30% platform fee (this is a content SALE, NOT a donation — " +
      "donations always go 100% directly to the church). After purchase, get_sermon returns the full transcript. " +
      "Purchases are idempotent (buying the same sermon twice won't double-charge). If you have insufficient " +
      "credits, check get_credit_balance and top up. No key / no credits? Pay per-call in USDC on Base via x402 " +
      "instead — call pay_with_x402 with this sermon_id (agent-native, no SoapBox account).",
    inputSchema: {
      type: "object",
      properties: {
        sermon_id: { type: "string", description: "The sermon to purchase (from search_sermons results)." },
      },
      required: ["sermon_id"],
    },
  },
  {
    name: "purchase_bundle",
    description:
      "Buy a bundle (a sermon series — multiple sermons sold together at one price) using prepaid marketplace " +
      "credits. Grants access to EVERY sermon in the bundle. Same terms as purchase_sermon: church keeps 70% of net, " +
      "SoapBox 30% (a content sale, not a donation). Idempotent. Find bundles via browse_catalog (type: bundle). " +
      "No key / no credits? Pay per-call in USDC on Base via x402 — call pay_with_x402 with this bundle_id.",
    inputSchema: {
      type: "object",
      properties: { bundle_id: { type: "string", description: "The bundle's id (product_id from browse_catalog where type=bundle)." } },
      required: ["bundle_id"],
    },
  },
  {
    name: "pay_with_x402",
    description:
      "Pay for a paid sermon or bundle per-call in USDC on Base using the x402 protocol — the AGENT-NATIVE rail, " +
      "no SoapBox account, API key, or prepaid credits required (https://github.com/coinbase/x402). " +
      "Two-step, exactly per spec: (1) call with just the sermon_id (or bundle_id) and NO payment to get back the " +
      "HTTP-402 payment requirements — the USDC amount, asset, network ('base'), and SoapBox's payTo receive " +
      "address. (2) Send USDC on Base to that payTo, then call again with x_payment set to a base64-encoded JSON " +
      "payload carrying your broadcast Base tx hash ({\"txHash\":\"0x...\"}) — SoapBox verifies the on-chain " +
      "transfer, records the sale (church keeps 70%), and returns the transcript. Idempotent per tx hash. " +
      "Gasless EIP-3009 'exact' payments via an x402 facilitator are also accepted in the same x_payment field.",
    inputSchema: {
      type: "object",
      properties: {
        sermon_id: { type: "string", description: "The sermon to pay for (omit if paying for a bundle)." },
        bundle_id: { type: "string", description: "The bundle to pay for (omit if paying for a sermon)." },
        x_payment: { type: "string", description: "Step 2 only: base64-encoded JSON x402 payment payload (e.g. base64 of {\"txHash\":\"0x...\"} for an on-chain Base USDC transfer, or an EIP-3009 authorization for a facilitator). Omit on step 1 to receive the 402 requirements." },
      },
    },
  },
  {
    name: "get_credit_balance",
    description:
      "Check how many marketplace credits your API key has (in cents) for buying paid sermon access, plus your " +
      "tier and daily rate limit. Top-ups are done via the topup API action or the SoapBox developer portal.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browse_catalog",
    description:
      "Browse purchasable faith-content products on SoapBox (currently consented sermons; reading-plan and " +
      "devotional bundles coming). Returns products with id, title, church, and price. Then buy with purchase_sermon. " +
      "Optional church_id and text filter. No key required.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Optional text filter on product title." },
        church_id: { type: "string", description: "Optional SoapBox community id to scope to one church." },
        limit: { type: "integer", description: "Max products (1-100, default 25)." },
      },
    },
  },
  {
    name: "score_doctrinal_fit",
    description:
      "Assess how well a statement aligns with a named Christian tradition's historic doctrinal positions (e.g. " +
      "Reformed, Roman Catholic, Pentecostal, Eastern Orthodox). Returns an impartial alignment rating, score, " +
      "summary, and the relevant doctrinal loci. Analytical, not proselytizing. No key required.",
    inputSchema: {
      type: "object",
      properties: {
        statement: { type: "string", description: "The statement/claim to assess (max 1500 chars)." },
        tradition: { type: "string", description: "The tradition/denomination to assess against." },
      },
      required: ["statement", "tradition"],
    },
  },
  {
    name: "get_lectionary",
    description:
      "Get the Western (Revised Common Lectionary / Roman) liturgical season, liturgical color, RCL year (A/B/C), " +
      "and any major feast for a date (defaults to today). Useful for date-aware, season-appropriate faith content. " +
      "Daily readings are not included (those tables are licensed). No key required.",
    inputSchema: {
      type: "object",
      properties: { date: { type: "string", description: "Optional date YYYY-MM-DD (defaults to today, UTC)." } },
    },
  },
  {
    name: "synthesize_speech",
    description:
      "Generate spoken-audio (text-to-speech) for a verse, prayer, or devotional in 50+ languages, and get back a " +
      "playable audio URL. Pass BCP-47 language (e.g. en-US, es-ES, sw-KE), optional voice/gender. Results are " +
      "cached. Requires an API key (audio generation has real cost).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to speak (max 2000 chars)." },
        language: { type: "string", description: "BCP-47 language code, e.g. en-US, es-ES, sw-KE (default en-US)." },
        voice: { type: "string", description: "Optional specific Google voice name." },
        gender: { type: "string", description: "NEUTRAL | MALE | FEMALE (default NEUTRAL)." },
        format: { type: "string", description: "mp3 (default) or ogg." },
      },
      required: ["text"],
    },
  },
  {
    name: "get_faith_context",
    description:
      "Read a user's portable 'faith context' to personalize your responses — their denomination, preferred " +
      "language, faith journey, and ministry interests — shared WITH THE USER'S EXPLICIT CONSENT. Requires the " +
      "user's consent_token with the 'context:read' scope (bound to this agent). Use it to tailor tone, tradition, " +
      "and language. It returns only the user's declared profile (never their private prayers or journal).",
    inputSchema: {
      type: "object",
      properties: {
        consent_token: { type: "string", description: "The user's SoapBox consent token (scope context:read, bound to this agent)." },
      },
      required: ["consent_token"],
    },
  },
];

const TOOL_ACTION: Record<string, string> = {
  verify_scripture: "verify",
  get_verse: "verse",
  lookup_strongs: "strongs",
  find_churches: "churches",
  submit_prayer_request: "prayer_request",
  check_prayer_status: "prayer_status",
  give_to_church: "give",
  ask_ora: "ora",
  search_sermons: "sermon_search",
  get_sermon: "sermon_get",
  purchase_sermon: "sermon_purchase",
  get_credit_balance: "balance",
  get_faith_context: "context",
  get_lectionary: "lectionary",
  synthesize_speech: "tts",
  browse_catalog: "catalog",
  score_doctrinal_fit: "doctrine_fit",
  purchase_bundle: "bundle_purchase",
};

// (FREE_TOOLS updated below to include get_lectionary)

// Free read tools callable with no API key (mirror faith-content-api FREE_ACTIONS).
const FREE_TOOLS = new Set([
  "verify_scripture", "get_verse", "lookup_strongs", "find_churches",
  "ask_ora", "search_sermons", "get_sermon", "get_lectionary",
  "browse_catalog", "score_doctrinal_fit",
]);

// MCP resources — expose the live content catalog as a readable resource so an
// agent can browse SoapBox's faith-content store without first knowing the
// browse_catalog tool. Resources are read-only; resources/read just proxies the
// faith-content-api `catalog` action (the same data browse_catalog returns).
const RESOURCES = [
  {
    uri: "soapbox://catalog",
    name: "SoapBox Faith Content Catalog",
    description:
      "The live catalog of purchasable faith content on SoapBox — sermons, reading plans, books, " +
      "bundles, and physical goods. Each item has a title, type, description, price, and a web_url. " +
      "Read this to discover what's available; buy with the purchase_sermon / purchase_bundle tools.",
    mimeType: "application/json",
  },
];

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function callApi(apiKey: string, action: string, args: Record<string, unknown>) {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ action, ...args }),
  });
  const data = await r.json().catch(() => ({ error: "bad response" }));
  return { ok: r.ok, status: r.status, data };
}

// pay_with_x402: proxy the keyless x402-faith endpoint. Step 1 (no x_payment) →
// the agent gets the spec 402 + accepts (status 402, NOT an error). Step 2 (with
// x_payment) → the payload rides the X-PAYMENT header; on success we surface the
// content + the X-PAYMENT-RESPONSE settlement receipt back to the agent.
async function callX402(args: Record<string, unknown>) {
  const { x_payment, ...rest } = args;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof x_payment === "string" && x_payment) headers["X-PAYMENT"] = x_payment;
  const r = await fetch(X402_URL, { method: "POST", headers, body: JSON.stringify(rest) });
  const data = await r.json().catch(() => ({ error: "bad response" }));
  const paymentResponse = r.headers.get("x-payment-response");
  // A 402 here is the protocol's "payment required" signal — surface it as a
  // normal result (not isError) so the agent reads the `accepts` requirements.
  const ok = r.ok || r.status === 402;
  return { ok, status: r.status, data: paymentResponse ? { ...data, x_payment_response: paymentResponse } : data };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "MCP Streamable-HTTP: POST only" }), {
      status: 405, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const apiKey = req.headers.get("x-api-key") ??
    (req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");

  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try { msg = await req.json(); } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "parse error")), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const { id, method, params } = msg;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  // Notifications (no id) — acknowledge with 202, no body.
  if (id === undefined || id === null) {
    if (method?.startsWith("notifications/")) return new Response(null, { status: 202, headers: cors });
  }

  switch (method) {
    case "initialize":
      return json(rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER,
        instructions: "Grounded, public-domain (KJV) Scripture tools. Call verify_scripture before " +
          "presenting any Bible quote to avoid hallucinated/misattributed verses.",
      }));

    case "ping":
      return json(rpcResult(id, {}));

    case "tools/list":
      return json(rpcResult(id, { tools: TOOLS.map((t) => ({ ...t, annotations: TOOL_ANNOTATIONS[t.name] ?? { title: t.name, readOnlyHint: true, destructiveHint: false } })) }));

    case "resources/list":
      return json(rpcResult(id, { resources: RESOURCES }));

    case "resources/read": {
      const uri = String(params?.uri ?? "");
      if (uri !== "soapbox://catalog") {
        return json(rpcError(id, -32602, `unknown resource: ${uri}`));
      }
      // The catalog is a free, keyless read — proxy the faith-content-api action.
      const { data } = await callApi(apiKey, "catalog", {});
      return json(rpcResult(id, {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify(data, null, 2),
        }],
      }));
    }

    case "tools/call": {
      const name = String(params?.name ?? "");
      // x402 agent-native USDC payment — keyless (payment IS the credential). Routed
      // to the x402-faith endpoint, not faith-content-api.
      if (name === "pay_with_x402") {
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        const { ok, data } = await callX402(args);
        return json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: !ok }));
      }
      const action = TOOL_ACTION[name];
      if (!action) return json(rpcResult(id, { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true }));
      // Free read tools work with no key (faith-content-api enforces the same set
      // + a per-IP limit). Money/consent tools require a key.
      if (!apiKey && !FREE_TOOLS.has(name)) {
        return json(rpcResult(id, { content: [{ type: "text", text: `Tool '${name}' needs a SoapBox API key (Authorization: Bearer <key>). Free tools (${[...FREE_TOOLS].join(", ")}) need none. Get a key at https://soapboxsuperapp.com/developers` }], isError: true }));
      }
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const { ok, data } = await callApi(apiKey, action, args);
      return json(rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: !ok,
      }));
    }

    default:
      return json(rpcError(id, -32601, `method not found: ${method}`));
  }
});
