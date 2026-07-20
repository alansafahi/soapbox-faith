# SoapBox Faith — MCP Server

Faith tools for AI agents: cited, public-domain (KJV) Scripture, ORA Bible Q&A, real sermon search, a church directory, and consent-gated prayer & giving. This is the official [Model Context Protocol](https://modelcontextprotocol.io) server for [SoapBox Super App](https://soapboxsuperapp.com).

**It's a thin protocol adapter:** it speaks MCP (JSON-RPC 2.0 over Streamable HTTP) and forwards each tool call to SoapBox's hosted [Faith Content API](https://soapboxsuperapp.com/developers), which owns the auth, metering, and content logic.

- **Hosted endpoint (no need to run this yourself):** `https://foyekanoxpnkydoibaas.supabase.co/functions/v1/faith-mcp`
- **Transport:** Streamable HTTP (JSON-RPC 2.0)
- **Connect guide:** https://soapboxsuperapp.com/for-agents · **API reference:** https://soapboxsuperapp.com/developers

## Auth — keyless-first

**The read tools need no API key** — point your client at the endpoint and call them (per-IP rate-limited). A key is required only for tools that cost money to run or act on a user's behalf. Pass it as `Authorization: Bearer <key>` when needed; self-serve one at https://soapboxsuperapp.com/developers.

| Free (no key) | Key required |
|---|---|
| `verify_scripture` · `get_verse` · `lookup_strongs` · `find_churches` · `ask_ora` · `search_sermons` · `get_sermon` · `get_lectionary` · `browse_catalog` · `score_doctrinal_fit` | `synthesize_speech` · `purchase_sermon` · `purchase_bundle` · `pay_with_x402` · `get_credit_balance` · `submit_prayer_request` · `check_prayer_status` · `give_to_church` · `get_faith_context` |

Prayer and giving additionally require an explicit, user-issued **consent token** (they act on a real person's behalf). Prayer *submits a request to a live human community prayer wall* — the AI does not "pray for you." Giving is passthrough — SoapBox takes no cut of donations. Sermon purchases are a content sale (church keeps 70% of net; SoapBox is Merchant of Record on sales only).

## Connect from Claude (remote MCP)

Add a custom connector with the hosted URL above. Free tools work immediately; add an `Authorization: Bearer <key>` header to unlock the key-gated tools.

## Highlights

- **Anti-hallucination:** call `verify_scripture` before presenting any Bible quote — it confirms the quote is real and cited to the correct KJV reference.
- **Grounded Q&A:** `ask_ora` returns KJV-cited answers (a study aid, crisis-safe — not a counselor).
- **Real, consented content:** `search_sermons` covers sermons pastors explicitly opted in to share with agents.
- **Agent-native payments:** `pay_with_x402` pays per-call in USDC on Base ([x402](https://github.com/coinbase/x402)) — no account required.

## Run it yourself

```bash
# Deno 2.x
deno run --allow-net --allow-env index.ts        # serves on http://localhost:8000

# or Docker
docker build -t soapbox-faith .
docker run -p 8000:8000 soapbox-faith
```

`SUPABASE_URL` defaults to the production host, so read tools work out of the box. The MCP handshake (`initialize`, `tools/list`, `resources/list`) needs no configuration.

## Resources

- `soapbox://catalog` — the live faith-content catalog as JSON (via MCP `resources/read`).

## License

MIT © SoapBox Super App. See [LICENSE](./LICENSE).
