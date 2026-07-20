# Examples

Runnable references showing how to use the SoapBox Faith MCP server.

## faith-research-assistant.ts

A ~90-line reference agent that connects to the live MCP and runs the pattern any
faith-aware AI app should follow: **verify Scripture before quoting it**, then
research with ORA + real sermons, and cite the sources.

```bash
# No install beyond Deno; uses the free, keyless read tools.
deno run --allow-net --allow-env examples/faith-research-assistant.ts
```

It demonstrates three tools end-to-end:

1. `verify_scripture` — confirm a quote is real and correctly attributed (anti-hallucination)
2. `ask_ora` — a grounded, KJV-cited answer to a study question
3. `search_sermons` — what real, consented churches are preaching on the topic

### Optional: the keyed path (and get a free API key)

The money/consent tools need a key. To exercise the keyed path — and create a real
free-tier key in the process — pass an email (self-serves via `faith-api-signup`):

```bash
SOAPBOX_SIGNUP_EMAIL="you@example.com" deno run --allow-net --allow-env examples/faith-research-assistant.ts
# or bring your own:
SOAPBOX_API_KEY="sbx_..." deno run --allow-net --allow-env examples/faith-research-assistant.ts
```

## Connecting from Claude (no code)

Add the endpoint as a remote MCP connector — free read tools work with no key:

```
https://foyekanoxpnkydoibaas.supabase.co/functions/v1/faith-mcp
```

Add an `Authorization: Bearer <key>` header only for the money/consent tools.
Full docs: https://soapboxsuperapp.com/developers · Connect guide: https://soapboxsuperapp.com/for-agents
