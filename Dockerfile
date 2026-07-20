FROM denoland/deno:2.1.4

WORKDIR /app

# The MCP server is a single self-contained Deno module.
COPY index.ts .

# Pre-cache dependencies at build time.
RUN deno cache index.ts

# Streamable-HTTP MCP server listens on 8000 by default (Deno.serve).
EXPOSE 8000

# Read tools are keyless and forward to the public SoapBox Faith Content API
# (SUPABASE_URL defaults to the production host). No secrets required to start
# or to respond to MCP introspection (initialize / tools/list).
CMD ["run", "--allow-net", "--allow-env", "index.ts"]
