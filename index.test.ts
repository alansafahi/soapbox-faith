// deno test --allow-read index.test.ts
//
// Keeps the published tool surface honest about what an agent can actually call.
//
// The prepaid marketplace-credit wallet was retired 2026-07-15: the upstream
// Faith Content API answers HTTP 410 for sermon_purchase, bundle_purchase and
// topup. This server kept offering `purchase_sermon` and `purchase_bundle` on
// tools/list and told agents to "buy ... using your prepaid marketplace credits"
// and to "check get_credit_balance and top up" — so an agent that followed the
// documentation spent its turns on dead endpoints, and only succeeded if it
// ignored the docs and guessed pay_with_x402. These assertions stop that copy
// from coming back.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SRC = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
const README = Deno.readTextFileSync(new URL("./README.md", import.meta.url));
const SERVER_JSON = JSON.parse(Deno.readTextFileSync(new URL("./server.json", import.meta.url)));

/** Tool names offered on tools/list. */
function toolNames(): string[] {
  const block = SRC.match(/\nconst TOOLS = \[([\s\S]*?)\n\];/);
  assert(block, "TOOLS array not found");
  return [...block[1].matchAll(/^\s{4}name: "([a-z_0-9]+)",/gm)].map((m) => m[1]);
}

/** The tool -> upstream action map. */
function toolActions(): Record<string, string> {
  const block = SRC.match(/const TOOL_ACTION: Record<string, string> = \{([\s\S]*?)\n\};/);
  assert(block, "TOOL_ACTION map not found");
  const map: Record<string, string> = {};
  for (const m of block[1].matchAll(/^\s*([a-z_0-9]+):\s*"([a-z_]+)",/gm)) map[m[1]] = m[2];
  return map;
}

// Upstream actions that answer HTTP 410. Kept in step with the backend's
// faith-content-api router, which has the same assertion derived from source.
const RETIRED_ACTIONS = ["sermon_purchase", "bundle_purchase", "topup"];
const RETIRED_TOOLS = ["purchase_sermon", "purchase_bundle"];

Deno.test("the retired purchase tools are off tools/list", () => {
  const names = toolNames();
  for (const gone of RETIRED_TOOLS) {
    assert(!names.includes(gone), `${gone} is retired (HTTP 410) but still offered on tools/list`);
  }
  assert(names.includes("pay_with_x402"), "pay_with_x402 is the replacement rail and must stay listed");
});

Deno.test("no tool routes to a retired upstream action", () => {
  const offenders = Object.entries(toolActions())
    .filter(([, action]) => RETIRED_ACTIONS.includes(action))
    .map(([tool, action]) => `${tool} -> ${action}`);
  assertEquals(offenders, [], "these tools call endpoints that answer 410");
});

Deno.test("no tool description sends an agent to the retired wallet", () => {
  const block = SRC.match(/\nconst TOOLS = \[([\s\S]*?)\n\];/)![1];
  for (const bad of [/\bpurchase_sermon\b/, /\bpurchase_bundle\b/, /check get_credit_balance/i, /top up/i]) {
    const hit = block.match(bad);
    assert(!hit, `a tool description still points at the retired wallet: ${hit?.[0]}`);
  }
});

Deno.test("every mention of prepaid credits says they are retired", () => {
  for (const m of SRC.matchAll(/[^"\n]*prepaid[^"\n]*/gi)) {
    assert(/retired/i.test(m[0]), `"${m[0].trim()}" mentions prepaid credits without saying they are retired`);
  }
});

Deno.test("consent-token examples use the prefix the app actually mints", () => {
  // Tokens are minted `sbxc_` + 48 hex. The per-scope prefixes sbxpr_ / sbxgv_ /
  // sbxctx_ never existed outside these examples.
  for (const stale of ["sbxpr_", "sbxgv_", "sbxctx_"]) {
    assert(!SRC.includes(stale), `${stale} is not a prefix SoapBox mints; use sbxc_`);
  }
  assert(SRC.includes("sbxc_"), "the consent-token examples lost their prefix entirely");
});

Deno.test("pay_with_x402 is documented as keyless, because it is", () => {
  // It is dispatched before the API-key gate, so a key is genuinely not needed.
  const gate = SRC.indexOf("if (!apiKey && !FREE_TOOLS.has(name))");
  const dispatch = SRC.indexOf('if (name === "pay_with_x402")');
  assert(dispatch !== -1 && gate !== -1, "could not locate the x402 dispatch or the key gate");
  assert(dispatch < gate, "pay_with_x402 is no longer dispatched ahead of the key gate");

  const table = README.match(/\| Free \(no key\) \| Key required \|\n\|---\|---\|\n\|([^|]*)\|([^|]*)\|/);
  assert(table, "the README auth table changed shape");
  assert(table[1].includes("pay_with_x402"), "README lists pay_with_x402 as key-required, but it is keyless");
  for (const gone of RETIRED_TOOLS) {
    assert(!table[1].includes(gone) && !table[2].includes(gone), `README still advertises ${gone}`);
  }
});

Deno.test("the registry manifest does not promise a key buys sermons", () => {
  const header = SERVER_JSON.remotes[0].headers[0].description as string;
  assert(!/buying sermons/i.test(header),
    "server.json still says a key is needed to buy sermons; x402 is keyless");
  assertEquals(SERVER_JSON.version, SRC.match(/const SERVER = \{ name: "soapbox-faith", version: "([^"]+)" \}/)![1],
    "server.json and the SERVER constant disagree on the version");
});
