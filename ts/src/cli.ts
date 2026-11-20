#!/usr/bin/env node
/**
 * `polypad connect` — one-command onboarding for the Polypad MCP server.
 *
 * Polypad's MCP server is remote (https://polypad.family/api/mcp), so
 * connecting a host is just writing one server entry into that host's
 * config file — no local server to install, no account to create, no
 * sign-up. The free tier needs no key at all; a Pro key (pp_live_...)
 * is attached as an `x-api-key` header when passed with --key.
 *
 *   npx -y polypad-agent connect claude
 *   polypad connect cursor --key pp_live_...
 *   polypad connect --list
 *
 * Supported hosts: claude, cursor, codex, gemini, vscode, grok.
 *
 * Config targets (verified against each vendor's current docs):
 * - claude:  ~/.claude.json, mcpServers.polypad
 * - cursor:  ~/.cursor/mcp.json, mcpServers.polypad
 * - codex:   ~/.codex/config.toml, [mcp_servers.polypad] (http_headers carries the key)
 * - gemini:  ~/.gemini/settings.json, mcpServers.polypad
 * - vscode:  ~/.copilot/mcp-config.json, mcpServers.polypad
 *            (VS Code's own docs now call .vscode/mcp.json / settings.json
 *            "mcp.servers" the deprecated Local-harness format — the
 *            Copilot harness reads mcp-config.json / .mcp.json directly.)
 * - grok:    no local config file — prints the steps to add it in Grok's
 *            connector UI instead.
 *
 * --local writes a project-level config where the host supports one:
 * claude (./.mcp.json), cursor (./.cursor/mcp.json), vscode (./.mcp.json).
 * codex / gemini / grok have no supported project-level form here.
 *
 * Safety: existing configs are read first and preserved (every other
 * server stays untouched). An invalid JSON/TOML config is an error, never
 * silently overwritten. Writes are atomic (temp file + rename). A --key
 * value is never printed — only "Pro key attached".
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MCP_URL = 'https://polypad.family/api/mcp';
export const PRO_KEY_PREFIX = 'pp_live_';
export const PRO_KEY_MAX_LENGTH = 80;

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

export type Host = 'claude' | 'cursor' | 'codex' | 'gemini' | 'vscode' | 'grok';
export const HOSTS: Host[] = ['claude', 'cursor', 'codex', 'gemini', 'vscode', 'grok'];

/** Where a host reads its config from. `null` = no local config file. */
export function configPath(host: Host, env: ConnectEnv, local: boolean): string | null {
  switch (host) {
    case 'claude':
      return local ? join(env.cwd, '.mcp.json') : join(env.home, '.claude.json');
    case 'cursor':
      return local ? join(env.cwd, '.cursor', 'mcp.json') : join(env.home, '.cursor', 'mcp.json');
    case 'codex':
      // CODEX_HOME relocates the whole .codex directory (per Codex docs).
      return local ? null : join(env.codexHome ?? join(env.home, '.codex'), 'config.toml');
    case 'gemini':
      return local ? null : join(env.home, '.gemini', 'settings.json');
    case 'vscode':
      // $COPILOT_HOME relocates the Copilot user config (per VS Code docs).
      return local
        ? join(env.cwd, '.mcp.json')
        : join(env.copilotHome ?? join(env.home, '.copilot'), 'mcp-config.json');
    case 'grok':
      return null;
  }
}

/** Hosts that accept a project-level (--local) config. */
export function supportsLocal(host: Host): boolean {
  return host === 'claude' || host === 'cursor' || host === 'vscode';
}

export interface ConnectEnv {
  /** User home directory (HOME / os.homedir()). */
  home: string;
  /** Working directory for --local configs. */
  cwd: string;
  /** $COPILOT_HOME override for the VS Code user config. */
  copilotHome?: string;
  /** $CODEX_HOME override for the Codex config dir. */
  codexHome?: string;
}

export function defaultEnv(env: NodeJS.ProcessEnv = process.env): ConnectEnv {
  return {
    home: env.HOME || env.USERPROFILE || homedir(),
    cwd: process.cwd(),
    copilotHome: env.COPILOT_HOME || undefined,
    codexHome: env.CODEX_HOME || undefined,
  };
}

/** One-line restart instruction shown after a successful connect. */
export function restartInstruction(host: Host): string {
  switch (host) {
    case 'claude':
      return 'Restart Claude Code (or run /mcp in a session) to load the Polypad tools.';
    case 'cursor':
      return 'Restart Cursor — Polypad will appear under Settings → MCP.';
    case 'codex':
      return 'Restart the Codex CLI (or run /mcp) to load the Polypad tools.';
    case 'gemini':
      return 'Restart the Gemini CLI to load the Polypad tools.';
    case 'vscode':
      return 'Reload VS Code — Polypad will appear in Copilot’s MCP server list (run MCP: List Servers to check).';
    case 'grok':
      return 'Add Polypad in Grok’s connector settings (see below).';
  }
}

export const FIRST_PROMPTS = [
  'What tokens launched on Robinhood Chain today?',
  'Start a tokenized fund for me.',
] as const;

export function grokInstructions(): string {
  return [
    'Grok has no local config file, so there is nothing to write.',
    '',
    'Add Polypad in Grok’s connector settings:',
    '  1. Open Grok → Settings → Connectors (MCP servers).',
    '  2. Add a new HTTP MCP server with this URL:',
    `       ${MCP_URL}`,
    '  3. If you have a Pro key, add a header: x-api-key: <your pp_live_ key>',
    '     (no key is needed for the free tier).',
    '  4. Save, then ask Grok one of the first prompts below.',
  ].join('\n');
}

/**
 * Validate a Pro key the way the server does (see lib/agents-api/v2/keys.ts):
 * `pp_live_` prefix, at most 80 chars. Returns an error message, or null
 * when the key is well-formed.
 */
export function validateKey(key: string): string | null {
  if (!key.startsWith(PRO_KEY_PREFIX)) return 'Pro key must start with "pp_live_".';
  if (key.length <= PRO_KEY_PREFIX.length)
    return 'Pro key looks incomplete — it must be longer than the "pp_live_" prefix.';
  if (key.length > PRO_KEY_MAX_LENGTH)
    return `Pro key is too long — the server accepts at most ${PRO_KEY_MAX_LENGTH} characters.`;
  if (/\s/.test(key)) return 'Pro key must not contain whitespace.';
  if (/["\\]/.test(key)) return 'Pro key must not contain quotes or backslashes.';
  return null;
}

/** The JSON server entry written for claude / cursor / gemini / vscode. */
export function jsonEntry(key?: string): Record<string, unknown> {
  const entry: Record<string, unknown> = { type: 'http', url: MCP_URL };
  if (key) entry.headers = { 'x-api-key': key };
  return entry;
}

export class ConnectError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'ConnectError';
    this.exitCode = exitCode;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Write file atomically: temp file in the same directory, then rename. */
function atomicWrite(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    throw err;
  }
}

/** Merge the polypad entry into a JSON config object. Returns the new object. */
export function mergeJsonConfig(
  parsed: unknown,
  key: string | undefined,
  force: boolean,
): { merged: Record<string, unknown>; alreadyConnected: boolean } {
  if (!isPlainObject(parsed)) {
    throw new ConnectError('Config is not a JSON object — refusing to overwrite it.');
  }
  const servers = parsed.mcpServers;
  if (servers !== undefined && !isPlainObject(servers)) {
    throw new ConnectError('Config has a "mcpServers" value that is not an object — refusing to overwrite it.');
  }
  const alreadyConnected = isPlainObject(servers) && Object.prototype.hasOwnProperty.call(servers, 'polypad');
  if (alreadyConnected && !force) {
    throw new ConnectError('ALREADY_CONNECTED');
  }
  const next: Record<string, unknown> = { ...parsed, mcpServers: { ...(isPlainObject(servers) ? servers : {}) } };
  (next.mcpServers as Record<string, unknown>).polypad = jsonEntry(key);
  return { merged: next, alreadyConnected };
}

/**
 * Connect a JSON host (claude / cursor / gemini / vscode). Reads the
 * existing config, preserves every other server, and writes atomically.
 */
export function connectJson(opts: ConnectOptions & { file: string }): ConnectOutcome {
  const { file } = opts;
  let parsed: unknown = {};
  if (existsSync(file)) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      throw new ConnectError(`Cannot read ${file}: ${(err as Error).message}`);
    }
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ConnectError(`${file} is not valid JSON — fix it or move it aside; nothing was changed.`);
    }
  }
  let merged: Record<string, unknown>;
  let alreadyConnected: boolean;
  try {
    ({ merged, alreadyConnected } = mergeJsonConfig(parsed, opts.key, opts.force ?? false));
  } catch (err) {
    if (err instanceof ConnectError && err.message === 'ALREADY_CONNECTED') {
      throw new ConnectError(
        `Polypad is already connected to ${opts.host} (${file}). Re-run with --force to overwrite it.`,
      );
    }
    throw err;
  }
  if (!opts.dryRun) {
    atomicWrite(file, `${JSON.stringify(merged, null, 2)}\n`);
  }
  let preview: string | undefined;
  if (opts.dryRun) {
    // Show the full merged config, with the key value redacted.
    const display = JSON.parse(JSON.stringify(merged)) as Record<string, unknown>;
    const entry = (display.mcpServers as Record<string, unknown>).polypad as Record<string, unknown>;
    if (opts.key && isPlainObject(entry.headers)) {
      (entry.headers as Record<string, unknown>)['x-api-key'] = '***';
    }
    preview = JSON.stringify(display, null, 2);
  }
  return {
    host: opts.host,
    file,
    dryRun: opts.dryRun ?? false,
    keyAttached: opts.key !== undefined,
    wrote: !opts.dryRun,
    alreadyConnected,
    preview,
  };
}

// ---------------------------------------------------------------------------
// Minimal TOML reader — just enough to validate a Codex config.toml and to
// tell whether [mcp_servers.polypad] is already there. It is not a general
// TOML library: it covers tables, key = value pairs, strings (basic,
// literal, and multiline), numbers, booleans, datetimes, arrays, and
// inline tables — the shapes Codex config files actually use.
// ---------------------------------------------------------------------------

type TomlTable = Map<string, unknown>;

function tomlError(message: string, lineNo: number): Error {
  return new Error(`Invalid TOML (line ${lineNo}): ${message}`);
}

/**
 * Split TOML text into logical lines, joining lines continued by an open
 * multiline string, array, or inline table. Comments are stripped (a `#`
 * starts a comment only outside a string).
 */
export function splitTomlLines(text: string): Array<{ line: string; number: number }> {
  const out: Array<{ line: string; number: number }> = [];
  let buf = '';
  let startLine = 1;
  let lineNo = 1;
  // Scanner state: 'normal' | 'basic' | 'literal' | 'multi-basic' | 'multi-literal' | 'comment'
  let state: 'normal' | 'basic' | 'literal' | 'multi-basic' | 'multi-literal' | 'comment' = 'normal';
  let depth = 0; // open [ / { outside strings
  let i = 0;
  const flush = () => {
    out.push({ line: buf, number: startLine });
    buf = '';
    startLine = lineNo + 1;
  };
  while (i < text.length) {
    const ch = text[i];
    const next3 = text.slice(i, i + 3);
    if (state === 'comment') {
      if (ch === '\n') {
        state = 'normal';
        if (depth === 0) flush();
        else buf += ch;
        lineNo += 1;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'basic') {
      buf += ch;
      if (ch === '\\' && i + 1 < text.length) {
        buf += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') state = 'normal';
      if (ch === '\n') lineNo += 1;
      i += 1;
      continue;
    }
    if (state === 'literal') {
      buf += ch;
      if (ch === "'") state = 'normal';
      if (ch === '\n') lineNo += 1;
      i += 1;
      continue;
    }
    if (state === 'multi-basic') {
      if (next3 === '"""') {
        buf += '"""';
        i += 3;
        state = 'normal';
        continue;
      }
      buf += ch;
      if (ch === '\\' && i + 1 < text.length) {
        buf += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '\n') lineNo += 1;
      i += 1;
      continue;
    }
    if (state === 'multi-literal') {
      if (next3 === "'''") {
        buf += "'''";
        i += 3;
        state = 'normal';
        continue;
      }
      buf += ch;
      if (ch === '\n') lineNo += 1;
      i += 1;
      continue;
    }
    // normal state
    if (next3 === '"""') {
      buf += '"""';
      i += 3;
      state = 'multi-basic';
      continue;
    }
    if (next3 === "'''") {
      buf += "'''";
      i += 3;
      state = 'multi-literal';
      continue;
    }
    if (ch === '"') {
      buf += ch;
      state = 'basic';
      i += 1;
      continue;
    }
    if (ch === "'") {
      buf += ch;
      state = 'literal';
      i += 1;
      continue;
    }
    if (ch === '#') {
      state = 'comment';
      i += 1;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === '\n') {
      if (depth === 0) flush();
      else buf += ch;
      lineNo += 1;
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (state !== 'normal') {
    throw tomlError('unterminated string', lineNo);
  }
  if (depth !== 0) {
    throw tomlError('unbalanced brackets', lineNo);
  }
  if (buf.trim() !== '') out.push({ line: buf, number: startLine });
  return out;
}

class TomlValueParser {
  private pos = 0;
  constructor(
    private readonly src: string,
    private readonly lineNo: number,
  ) {}

  parse(): unknown {
    this.skipWs();
    const value = this.parseValue();
    this.skipWs();
    if (this.pos !== this.src.length) {
      throw tomlError(`unexpected trailing characters in value: ${this.src.slice(this.pos)}`, this.lineNo);
    }
    return value;
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /[\s]/.test(this.src[this.pos])) this.pos += 1;
  }

  private parseValue(): unknown {
    this.skipWs();
    const ch = this.src[this.pos];
    if (ch === '"') return this.parseBasicString();
    if (ch === "'") return this.parseLiteralString();
    if (ch === '[') return this.parseArray();
    if (ch === '{') return this.parseInlineTable();
    // Bare value: read to a comma / closing bracket / end.
    let end = this.pos;
    while (end < this.src.length && ![',', ']', '}'].includes(this.src[end])) end += 1;
    const raw = this.src.slice(this.pos, end).trim();
    this.pos = end;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(raw)) return Number(raw);
    if (/^0x[0-9a-fA-F_]+$/.test(raw)) return Number.parseInt(raw.replace(/_/g, ''), 16);
    if (/^0o[0-7_]+$/.test(raw)) return Number.parseInt(raw.replace(/_/g, '').slice(2), 8);
    if (/^0b[01_]+$/.test(raw)) return Number.parseInt(raw.replace(/_/g, '').slice(2), 2);
    if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(raw)) return raw; // datetime
    throw tomlError(`cannot parse value: ${raw}`, this.lineNo);
  }

  private parseBasicString(): string {
    // Handles both "..." and """...""" (the splitter already joined multiline).
    if (this.src.startsWith('"""', this.pos)) {
      const end = this.src.indexOf('"""', this.pos + 3);
      if (end === -1) throw tomlError('unterminated multiline string', this.lineNo);
      const raw = this.src.slice(this.pos + 3, end);
      this.pos = end + 3;
      return raw.replace(/\\(.)/g, (_m, c: string) => {
        switch (c) {
          case 'n':
            return '\n';
          case 't':
            return '\t';
          case 'r':
            return '\r';
          case '\\':
            return '\\';
          case '"':
            return '"';
          default:
            return c;
        }
      });
    }
    let out = '';
    this.pos += 1; // opening "
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '"') {
        this.pos += 1;
        return out;
      }
      if (c === '\\' && this.pos + 1 < this.src.length) {
        const esc = this.src[this.pos + 1];
        out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
        this.pos += 2;
        continue;
      }
      out += c;
      this.pos += 1;
    }
    throw tomlError('unterminated string', this.lineNo);
  }

  private parseLiteralString(): string {
    if (this.src.startsWith("'''", this.pos)) {
      const end = this.src.indexOf("'''", this.pos + 3);
      if (end === -1) throw tomlError('unterminated multiline string', this.lineNo);
      const raw = this.src.slice(this.pos + 3, end);
      this.pos = end + 3;
      return raw;
    }
    const end = this.src.indexOf("'", this.pos + 1);
    if (end === -1) throw tomlError('unterminated string', this.lineNo);
    const raw = this.src.slice(this.pos + 1, end);
    this.pos = end + 1;
    return raw;
  }

  private parseArray(): unknown[] {
    const items: unknown[] = [];
    this.pos += 1; // [
    for (;;) {
      this.skipWs();
      if (this.pos >= this.src.length) throw tomlError('unterminated array', this.lineNo);
      if (this.src[this.pos] === ']') {
        this.pos += 1;
        return items;
      }
      items.push(this.parseValue());
      this.skipWs();
      if (this.src[this.pos] === ',') {
        this.pos += 1;
        continue;
      }
      if (this.src[this.pos] === ']') {
        this.pos += 1;
        return items;
      }
      throw tomlError('expected "," or "]" in array', this.lineNo);
    }
  }

  private parseInlineTable(): Record<string, unknown> {
    const table: Record<string, unknown> = {};
    this.pos += 1; // {
    for (;;) {
      this.skipWs();
      if (this.pos >= this.src.length) throw tomlError('unterminated inline table', this.lineNo);
      if (this.src[this.pos] === '}') {
        this.pos += 1;
        return table;
      }
      const keyMatch = /^[A-Za-z0-9_-]+|"[^"]*"|'[^']*'/.exec(this.src.slice(this.pos));
      if (!keyMatch) throw tomlError('expected a key in inline table', this.lineNo);
      let key = keyMatch[0];
      if (key.startsWith('"') || key.startsWith("'")) key = key.slice(1, -1);
      this.pos += keyMatch[0].length;
      this.skipWs();
      if (this.src[this.pos] !== '=') throw tomlError('expected "=" in inline table', this.lineNo);
      this.pos += 1;
      table[key] = this.parseValue();
      this.skipWs();
      if (this.src[this.pos] === ',') {
        this.pos += 1;
        continue;
      }
      if (this.src[this.pos] === '}') {
        this.pos += 1;
        return table;
      }
      throw tomlError('expected "," or "}" in inline table', this.lineNo);
    }
  }
}

/**
 * Parse a TOML document into a flat map of dotted table path → key/value
 * map. The root table is stored under the empty path "". Throws on any
 * structural problem (bad header, bad key/value line, duplicate table or
 * key, unparseable value).
 */
export function parseToml(text: string): Map<string, TomlTable> {
  const tables = new Map<string, TomlTable>();
  tables.set('', new Map());
  let current = '';
  for (const { line, number } of splitTomlLines(text)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const arrayHeader = /^\[\[([^\]]+)\]\]/.exec(trimmed);
    if (arrayHeader) {
      throw tomlError('array-of-tables ([[...]]) is not supported by this reader', number);
    }
    const header = /^\[([^\]]+)\]\s*$/.exec(trimmed);
    if (header) {
      const path = header[1].trim();
      if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(path)) {
        throw tomlError(`bad table header: [${header[1]}]`, number);
      }
      if (tables.has(path)) throw tomlError(`duplicate table [${path}]`, number);
      tables.set(path, new Map());
      current = path;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*([\s\S]+)$/.exec(trimmed);
    if (!kv) throw tomlError(`cannot parse line: ${trimmed}`, number);
    const table = tables.get(current);
    if (!table) throw tomlError(`key outside any table: ${kv[1]}`, number);
    if (table.has(kv[1])) throw tomlError(`duplicate key "${kv[1]}" in [${current || 'root'}]`, number);
    table.set(kv[1], new TomlValueParser(kv[2].trim(), number).parse());
  }
  return tables;
}

/** True when the parsed TOML already defines the polypad MCP server. */
export function tomlHasPolypad(tables: Map<string, TomlTable>): boolean {
  if (tables.has('mcp_servers.polypad')) return true;
  const parent = tables.get('mcp_servers');
  return parent !== undefined && parent.has('polypad');
}

function escapeTomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The TOML block appended for Codex. The key is validated first, so the
 *  only characters it can contain are safe in a basic string. */
export function codexTomlBlock(key?: string): string {
  const lines = [
    '# Polypad MCP server — added by `polypad connect`. Delete this block to disconnect.',
    '[mcp_servers.polypad]',
    `url = ${escapeTomlBasicString(MCP_URL)}`,
  ];
  if (key) lines.push(`http_headers = { "x-api-key" = ${escapeTomlBasicString(key)} }`);
  return lines.join('\n');
}

/**
 * Connect Codex (~/.codex/config.toml). Appends a [mcp_servers.polypad]
 * table; the rest of the file is left byte-for-byte untouched.
 */
export function connectCodex(opts: ConnectOptions & { file: string }): ConnectOutcome {
  const { file } = opts;
  let raw = '';
  if (existsSync(file)) {
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      throw new ConnectError(`Cannot read ${file}: ${(err as Error).message}`);
    }
    let tables: Map<string, TomlTable>;
    try {
      tables = parseToml(raw);
    } catch (err) {
      throw new ConnectError(`${file} is not valid TOML (${(err as Error).message}) — fix it or move it aside; nothing was changed.`);
    }
    if (tomlHasPolypad(tables) && !opts.force) {
      throw new ConnectError(
        `Polypad is already connected to codex (${file}). Re-run with --force to overwrite it.`,
      );
    }
    if (tomlHasPolypad(tables) && opts.force) {
      throw new ConnectError(
        `--force cannot rewrite the existing [mcp_servers.polypad] table in ${file} — remove that table by hand, then run connect again.`,
      );
    }
  }
  if (!opts.dryRun) {
    const prefix = raw === '' ? '' : raw.endsWith('\n') ? '\n' : '\n';
    atomicWrite(file, `${raw}${prefix}${codexTomlBlock(opts.key)}\n`);
  }
  return {
    host: 'codex',
    file,
    dryRun: opts.dryRun ?? false,
    keyAttached: opts.key !== undefined,
    wrote: !opts.dryRun,
    alreadyConnected: false,
    // '***' stands in for the key value in the preview — the real key is never printed.
    preview: opts.dryRun ? codexTomlBlock(opts.key ? '***' : undefined) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Connect entry point
// ---------------------------------------------------------------------------

export interface ConnectOptions {
  host: Host;
  key?: string;
  local?: boolean;
  force?: boolean;
  dryRun?: boolean;
  env: ConnectEnv;
}

export interface ConnectOutcome {
  host: Host;
  /** File written, or null for grok (no file). */
  file: string | null;
  dryRun: boolean;
  keyAttached: boolean;
  wrote: boolean;
  alreadyConnected: boolean;
  /** What --dry-run would write, with any key value redacted. */
  preview?: string;
}

/**
 * Connect one host. Throws ConnectError on any user-facing failure
 * (already connected, invalid config, bad key, unsupported --local).
 * Never prints the key value.
 */
export function connect(opts: ConnectOptions): ConnectOutcome {
  if (opts.key !== undefined) {
    const keyError = validateKey(opts.key);
    if (keyError) throw new ConnectError(`Invalid Pro key: ${keyError}`);
  }
  if (opts.host === 'grok') {
    if (opts.local) {
      throw new ConnectError('Grok has no local config file, so --local does not apply. Run `polypad connect grok` without --local.');
    }
    return { host: 'grok', file: null, dryRun: opts.dryRun ?? false, keyAttached: opts.key !== undefined, wrote: false, alreadyConnected: false };
  }
  if (opts.local && !supportsLocal(opts.host)) {
    throw new ConnectError(
      `${opts.host} does not support a project-level config here — run without --local to write the user config.`,
    );
  }
  const file = configPath(opts.host, opts.env, opts.local ?? false);
  if (file === null) {
    throw new ConnectError(`${opts.host} does not support a project-level config here — run without --local to write the user config.`);
  }
  if (opts.host === 'codex') return connectCodex({ ...opts, file });
  return connectJson({ ...opts, file });
}

/** Read a host's user config (if any) and say whether polypad is in it. */
export type HostStatus = 'connected' | 'not connected' | 'unreadable' | 'manual';

export function hostStatus(host: Host, env: ConnectEnv): { status: HostStatus; file: string | null } {
  if (host === 'grok') return { status: 'manual', file: null };
  const file = configPath(host, env, false);
  if (file === null) return { status: 'manual', file: null };
  if (!existsSync(file)) return { status: 'not connected', file };
  try {
    if (host === 'codex') {
      return { status: tomlHasPolypad(parseToml(readFileSync(file, 'utf8'))) ? 'connected' : 'not connected', file };
    }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const servers = isPlainObject(parsed) ? parsed.mcpServers : undefined;
    return {
      status: isPlainObject(servers) && Object.prototype.hasOwnProperty.call(servers, 'polypad') ? 'connected' : 'not connected',
      file,
    };
  } catch {
    return { status: 'unreadable', file };
  }
}

export function listStatus(env: ConnectEnv): Array<{ host: Host; status: HostStatus; file: string | null }> {
  return HOSTS.map((host) => ({ host, ...hostStatus(host, env) }));
}

// ---------------------------------------------------------------------------
// CLI output
// ---------------------------------------------------------------------------

export function helpText(): string {
  return [
    'polypad — one-command onboarding for the Polypad MCP server.',
    '',
    'Usage:',
    '  polypad connect <host> [--key pp_live_...] [--local] [--force] [--dry-run]',
    '  polypad connect --list',
    '  polypad --help',
    '  polypad --version',
    '',
    'Hosts: claude, cursor, codex, gemini, vscode, grok',
    '',
    '  claude   Claude Code — writes ~/.claude.json',
    '  cursor   Cursor — writes ~/.cursor/mcp.json',
    '  codex    Codex CLI — writes ~/.codex/config.toml',
    '  gemini   Gemini CLI — writes ~/.gemini/settings.json',
    '  vscode   VS Code (Copilot) — writes ~/.copilot/mcp-config.json',
    '  grok     Grok — prints the steps to add it in Grok’s connector UI',
    '',
    'Flags:',
    '  --key <key>   Attach a Pro key (pp_live_...) as an x-api-key header.',
    '  --local       Write a project-level config instead of the user config',
    '                (claude, cursor, vscode only).',
    '  --force       Overwrite an existing polypad entry.',
    '  --dry-run     Print what would change without writing anything.',
    '',
    'No API key is needed — the free tier works without one. Get a Pro key at',
    'https://polypad.family/agents/accounts for higher rate limits.',
    '',
    'Examples:',
    '  npx -y polypad-agent connect claude',
    '  polypad connect cursor --key pp_live_...',
    '  polypad connect vscode --local',
    '',
  ].join('\n');
}

export function versionText(): string {
  return `polypad-agent ${VERSION}`;
}

function printOutcome(outcome: ConnectOutcome, opts: ConnectOptions, log: (line: string) => void): void {
  const host = opts.host;
  if (host === 'grok') {
    log(grokInstructions());
    log('');
    log('Try these first prompts:');
    for (const prompt of FIRST_PROMPTS) log(`  "${prompt}"`);
    return;
  }
  if (opts.dryRun) {
    log(`Would connect Polypad to ${host} in ${outcome.file}:`);
    log('');
    log(outcome.preview ?? '(no preview)');
    log('');
    log('Dry run — nothing was written.');
    return;
  }
  log(`Connected Polypad to ${host}.`);
  log(`  Config: ${outcome.file}`);
  if (outcome.keyAttached) log('  Pro key attached.');
  log(`  ${restartInstruction(host)}`);
  log('');
  log('Try these first prompts:');
  for (const prompt of FIRST_PROMPTS) log(`  "${prompt}"`);
}

function printList(env: ConnectEnv, log: (line: string) => void): void {
  const rows = listStatus(env);
  const width = Math.max(...rows.map((r) => r.host.length));
  log('Polypad MCP connections:');
  for (const row of rows) {
    const status =
      row.status === 'manual'
        ? 'manual setup — no local config file'
        : row.status === 'unreadable'
          ? `config unreadable (${row.file})`
          : row.status;
    log(`  ${row.host.padEnd(width)}  ${status}`);
  }
  log('');
  log('Connect a host with: polypad connect <host>');
}

// ---------------------------------------------------------------------------
// Argument parsing + entry point
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command?: string;
  host?: string;
  list?: boolean;
  help?: boolean;
  version?: boolean;
  key?: string;
  local?: boolean;
  force?: boolean;
  dryRun?: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '--list') out.list = true;
    else if (arg === '--local') out.local = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--key') {
      if (i + 1 >= argv.length) {
        out.error = '--key needs a value: --key pp_live_...';
        return out;
      }
      out.key = argv[(i += 1)];
    } else if (arg.startsWith('--key=')) {
      out.key = arg.slice('--key='.length);
    } else if (arg.startsWith('-')) {
      out.error = `Unknown option: ${arg}`;
      return out;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0) out.command = positional[0];
  if (positional.length > 1) out.host = positional[1];
  if (positional.length > 2) out.error = `Unexpected argument: ${positional[2]}`;
  return out;
}

export interface MainIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: MainIo = console): Promise<number> {
  const args = parseArgs(argv);
  if (args.error) {
    io.error(`Error: ${args.error}`);
    io.error('');
    io.error(helpText());
    return 1;
  }
  if (args.version) {
    io.log(versionText());
    return 0;
  }
  if (args.help || args.command === undefined) {
    io.log(helpText());
    return 0;
  }
  if (args.command !== 'connect') {
    io.error(`Error: unknown command: ${args.command}`);
    io.error('');
    io.error(helpText());
    return 1;
  }
  const connectEnv = defaultEnv(env);
  if (args.list) {
    printList(connectEnv, io.log);
    return 0;
  }
  if (args.host === undefined) {
    io.log(helpText());
    return 0;
  }
  const host = args.host.toLowerCase();
  if (!(HOSTS as string[]).includes(host)) {
    io.error(`Error: unknown host: ${args.host}`);
    io.error(`Supported hosts: ${HOSTS.join(', ')}`);
    return 1;
  }
  try {
    const outcome = connect({
      host: host as Host,
      key: args.key,
      local: args.local,
      force: args.force,
      dryRun: args.dryRun,
      env: connectEnv,
    });
    printOutcome(outcome, { host: host as Host, key: args.key, dryRun: args.dryRun, env: connectEnv }, io.log);
    return 0;
  } catch (err) {
    if (err instanceof ConnectError) {
      io.error(`Error: ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }
}

// Run main() only when this file is the entry point. The invoked path is
// resolved through symlinks first: npm installs the bin as a symlink
// (node_modules/.bin/polypad -> ../polypad-agent/dist/cli.js), so a plain
// argv[1] comparison would never match and the CLI would exit silently.
if (process.argv[1]) {
  try {
    if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
      main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
      });
    }
  } catch {
    // argv[1] is not a readable path — this file was imported, not executed.
  }
}
