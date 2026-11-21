# Changelog — polypad-agent

All notable changes to the TypeScript (`polypad-agent` on npm) and Python
(`polypad-agent` on PyPI) SDKs. The TypeScript package carries the `polypad`
CLI (`polypad connect`); the Python package is a library only.

## 2.1.1 (TypeScript) / 2.0.2 (Python) — 2026-11-21

### Added

- Package metadata so the npm and PyPI pages link back to GitHub: `repository`,
  `homepage` (`https://polypad.family/build`), `bugs`, and keywords.
- MIT `LICENSE` (matching [polydash-labs/Polydash](https://github.com/polydash-labs/Polydash)).
- README quickstart at the top: keyless MCP connect, SDK install, and a short
  example, plus links to polypad.family, /build, the MCP Registry, and the
  Capability Index.

## 2.1.0 — 2026-11-19 (TypeScript only; Python stays 2.0.1)

### Added

- **`polypad connect` — one-command onboarding.** One command wires Polypad's
  remote MCP server (`https://polypad.family/api/mcp`) into an AI host:
  `npx -y polypad-agent connect claude`, or `polypad connect <host>` after
  `npm install -g polypad-agent`. Hosts: `claude`, `cursor`, `codex`,
  `gemini`, `vscode`, `grok` (prints the steps — Grok has no local config
  file). Flags: `--key pp_live_...` (Pro key as an `x-api-key` header),
  `--local` (project-level config for claude, cursor, vscode), `--force`,
  `--dry-run`; plus `polypad connect --list`, `polypad --help`,
  `polypad --version`. Existing configs are preserved, writes are atomic,
  invalid JSON/TOML is never overwritten, and a `--key` value is never
  printed. After connecting it prints the file written, the restart step,
  and two first prompts.
- **Claude Code plugin** (`plugins/polypad/` + `.claude-plugin/marketplace.json`):
  `/plugin marketplace add polydash-labs/polypad-agent`, then
  `/plugin install polypad@polypad-agent`. Adds the Polypad MCP server and a
  `use-polypad` skill to Claude Code.

### Notes

- VS Code target is the current Copilot format: `~/.copilot/mcp-config.json`
  (or `$COPILOT_HOME/mcp-config.json`) with a top-level `mcpServers` key,
  and `./.mcp.json` for `--local`. VS Code's own docs now call
  `.vscode/mcp.json` / `settings.json` `"mcp"."servers"` the deprecated
  Local-harness format, so the CLI does not write them.
- Codex carries a Pro key via `http_headers = { "x-api-key" = "..." }` in
  `[mcp_servers.polypad]` — confirmed against Codex's current MCP docs.

## 2.0.1 — 2026-11-18

- Fix: published status in README (the packages are live on npm and PyPI).
- CI: TypeScript + Python tests on push/PR.

## 2.0.0 — 2026-11-18

- Initial public release. Thin typed clients (TypeScript + Python) for the
  Polypad agent API (MCP) v2.0.0 on Robinhood Chain: reads, prepares, the
  prepare → sign → confirm loop, persistent wallet binding (90-day token),
  x402 pay-per-call, and SpendVault spending keys.
