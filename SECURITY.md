# Security

**Agent Panel grants shell access with the operating-system permissions of its process owner.** It can read local conversations, run agent CLIs, modify project files and use the owner's existing agent authentication. It is a single-owner application, not a security boundary between users or a sandbox for agent code.

Keep the listener on loopback. For remote access, use an HTTPS reverse proxy or tunnel with WebSocket support, exact allowed origins and a strong unique owner password. Treat the owner password like an SSH key: there is no built-in two-factor authentication, so put an access layer (for example Cloudflare Access, Tailscale/WireGuard or an SSH tunnel) in front of any remote deployment. An unguessable hostname is not protection. See [Exposing Agent Panel to the internet](README.md#exposing-agent-panel-to-the-internet). Do not expose the listener on all interfaces. Leave proxy-header trust off unless a trusted loopback proxy strips incoming copies and supplies the client IP itself. Portal mode still allows only the owner; ordinary project permissions do not grant access.

Protect the state directory, agent credentials, terminal sockets, logs and backups from other OS users. Run one web process for local authentication. Password changes revoke existing sessions; open connections are rechecked periodically (up to five seconds). Trusted local applications and the OS account remain inside the trust boundary. Authentication does not limit what a signed-in owner or their agents can do on the machine.

Dependencies and agent CLIs need regular updates. Review agent permission modes and commands before running them. Avoid publishing logs, transcripts or screenshots containing private data. Optional external runners have their own permissions and risks.

## Report a vulnerability

Please **open a private security advisory on GitHub** using this repository's Security tab. Include affected versions, reproduction steps, impact and a minimal sanitized example. Do not post exploitable details or credentials in a public issue. If private reporting is not yet enabled, wait for a private reporting channel to be enabled before sharing sensitive details.

This project does not currently promise a response deadline or a supported-version maintenance window. Use an updated revision and review changes before deployment.
