# AGENTS.md — Conventions MCP

## Codex workspace scoping

When Codex connects to the shared HTTP server, its MCP configuration must run
the bundled header helper so every connection identifies the active workspace:

```toml
[mcp_servers.conventions]
url = "http://127.0.0.1:47123/mcp"
http_headers_helper = "conventions-mcp codex-project-header"
```

Codex runs `http_headers_helper` in the active workspace. The helper sends that
absolute working directory as `X-Conventions-Project`; the server then converts
slashes to dashes for its project identifier, so `/var/www/html` is presented
as `-var-www-html`. Without the helper, a shared HTTP connection has no Codex
workspace root and receives only global rules.
