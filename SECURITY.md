# Security policy

## Supported versions

Security fixes are made on the latest published version. Upgrade to the latest
release before reporting an issue that may already have been corrected.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security-advisory reporting flow for this repository. Include the affected
version, operating system, Node.js version, reproduction steps, impact, and any
suggested mitigation. Avoid including real captured rules or database files;
use synthetic data in reproductions.

## Security model

- Captured rules are sensitive local user data. Database files and backups
  should remain user-readable only and must not be committed to source control.
- Stdio mode trusts the MCP client that launches it. Any connected client can
  list, create, update, and delete records; there is no per-tool authorization.
- HTTP mode has no authentication and is intentionally restricted to loopback.
  Do not expose it on a LAN, public interface, port-forward, or untrusted reverse
  proxy. If remote access is added externally, that boundary must provide
  authentication, authorization, TLS, request limits, and origin protection.
- `X-Conventions-Project` is scoping metadata, not authentication. A local HTTP
  client can choose any absolute project path, and `list_thoughts` intentionally
  provides the all-records management view.
- The embedding model is downloaded from Hugging Face on first use. Installers
  should use trusted networks and normal npm/model-cache integrity controls.
- Hook scripts execute with the user's permissions. Merge reviewed hook entries
  into client configuration; never replace unrelated configuration blindly.

Before an upgrade, create an integrity-checked backup with
`conventions-mcp backup <absolute-destination>`. Keep backups outside the live
database directory and protect them like the database itself.
