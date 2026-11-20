import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MCP_URL,
  connect,
  connectCodex,
  hostStatus,
  listStatus,
  parseArgs,
  parseToml,
  splitTomlLines,
  tomlHasPolypad,
  validateKey,
  main,
  type ConnectEnv,
} from '../cli.js';

// Fake Pro keys only — never a real key. They match the server's format
// rules (pp_live_ prefix, ≤ 80 chars) and nothing else.
const FAKE_KEY = 'pp_live_testkey000000000000000001';
const FAKE_KEY_2 = 'pp_live_testkey000000000000000002';

function makeEnv(): { env: ConnectEnv; home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'polypad-connect-test-'));
  const env: ConnectEnv = { home, cwd: join(home, 'project') };
  mkdirSync(env.cwd, { recursive: true });
  return { env, home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
}

/** Capture main()'s stdout/stderr. */
async function runMain(argv: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(argv, env, {
    log: (line) => {
      out += `${line}\n`;
    },
    error: (line) => {
      err += `${line}\n`;
    },
  });
  return { code, out, err };
}

test('claude: writes the correct config into a temp HOME', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  const outcome = connect({ host: 'claude', env });
  const file = join(env.home, '.claude.json');
  assert.equal(outcome.file, file);
  assert.equal(outcome.wrote, true);
  const cfg = readJson(file);
  assert.deepEqual(cfg.mcpServers.polypad, { type: 'http', url: MCP_URL });
});

test('cursor: writes ~/.cursor/mcp.json with the same shape', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  connect({ host: 'cursor', env });
  const cfg = readJson(join(env.home, '.cursor', 'mcp.json'));
  assert.deepEqual(cfg.mcpServers.polypad, { type: 'http', url: MCP_URL });
});

test('gemini: writes ~/.gemini/settings.json', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  connect({ host: 'gemini', env });
  const cfg = readJson(join(env.home, '.gemini', 'settings.json'));
  assert.deepEqual(cfg.mcpServers.polypad, { type: 'http', url: MCP_URL });
});

test('vscode: writes ~/.copilot/mcp-config.json (the current Copilot format)', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  connect({ host: 'vscode', env });
  const cfg = readJson(join(env.home, '.copilot', 'mcp-config.json'));
  assert.deepEqual(cfg.mcpServers.polypad, { type: 'http', url: MCP_URL });
});

test('vscode: honors $COPILOT_HOME', (t) => {
  const { env, home, cleanup } = makeEnv();
  t.after(cleanup);
  const alt = join(home, 'alt-copilot');
  connect({ host: 'vscode', env: { ...env, copilotHome: alt } });
  const cfg = readJson(join(alt, 'mcp-config.json'));
  assert.deepEqual(cfg.mcpServers.polypad, { type: 'http', url: MCP_URL });
});

test('existing servers are preserved in a JSON config', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  const file = join(env.home, '.claude.json');
  mkdirSync(env.home, { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      {
        theme: 'dark',
        mcpServers: {
          other: { type: 'stdio', command: 'other-mcp' },
          another: { type: 'http', url: 'https://example.com/mcp' },
        },
      },
      null,
      2,
    ),
  );
  connect({ host: 'claude', env });
  const cfg = readJson(file);
  assert.equal(cfg.theme, 'dark');
  assert.deepEqual(cfg.mcpServers.other, { type: 'stdio', command: 'other-mcp' });
  assert.deepEqual(cfg.mcpServers.another, { type: 'http', url: 'https://example.com/mcp' });
  assert.deepEqual(cfg.mcpServers.polypad, { type: 'http', url: MCP_URL });
});

test('refuses without --force when already connected', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  connect({ host: 'claude', env });
  assert.throws(() => connect({ host: 'claude', env }), /already connected to claude/);
  // --force overwrites.
  const outcome = connect({ host: 'claude', env, force: true });
  assert.equal(outcome.wrote, true);
  const cfg = readJson(join(env.home, '.claude.json'));
  assert.deepEqual(cfg.mcpServers.polypad, { type: 'http', url: MCP_URL });
});

test('--dry-run writes nothing', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  const file = join(env.home, '.claude.json');
  const outcome = connect({ host: 'claude', env, dryRun: true });
  assert.equal(outcome.dryRun, true);
  assert.equal(outcome.wrote, false);
  assert.equal(existsSync(file), false);
  // Dry run on an existing config leaves it untouched.
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://x.example/mcp' } } }));
  connect({ host: 'claude', env, dryRun: true });
  assert.deepEqual(readJson(file), { mcpServers: { other: { type: 'http', url: 'https://x.example/mcp' } } });
});

test('--key adds the x-api-key header and rejects bad keys', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  connect({ host: 'cursor', env, key: FAKE_KEY });
  const cfg = readJson(join(env.home, '.cursor', 'mcp.json'));
  assert.deepEqual(cfg.mcpServers.polypad, {
    type: 'http',
    url: MCP_URL,
    headers: { 'x-api-key': FAKE_KEY },
  });
  assert.equal(validateKey(FAKE_KEY), null);
  assert.match(validateKey('sk_live_abc') ?? '', /must start with "pp_live_"/);
  assert.match(validateKey('pp_live_') ?? '', /incomplete/);
  assert.match(validateKey(`${'pp_live_'}${'x'.repeat(73)}`) ?? '', /too long/);
  assert.match(validateKey('pp_live_has space') ?? '', /whitespace/);
  assert.throws(() => connect({ host: 'cursor', env, key: 'not-a-key', force: true }), /Invalid Pro key/);
});

test('invalid JSON config errors out without overwriting', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  const file = join(env.home, '.claude.json');
  writeFileSync(file, '{ not json');
  assert.throws(() => connect({ host: 'claude', env }), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ not json');
});

test('--local writes project-level configs where supported', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  connect({ host: 'claude', env, local: true });
  assert.deepEqual(readJson(join(env.cwd, '.mcp.json')).mcpServers.polypad, { type: 'http', url: MCP_URL });
  connect({ host: 'cursor', env, local: true });
  assert.deepEqual(readJson(join(env.cwd, '.cursor', 'mcp.json')).mcpServers.polypad, { type: 'http', url: MCP_URL });
  // vscode --local targets the same ./.mcp.json as claude --local, so use a
  // second project dir to show the vscode write independently.
  const other = join(env.home, 'other-project');
  mkdirSync(other, { recursive: true });
  connect({ host: 'vscode', env: { ...env, cwd: other }, local: true });
  assert.deepEqual(readJson(join(other, '.mcp.json')).mcpServers.polypad, { type: 'http', url: MCP_URL });
});

test('--local is rejected for codex, gemini and grok', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  for (const host of ['codex', 'gemini', 'grok'] as const) {
    assert.throws(() => connect({ host, env, local: true }), /does not support a project-level config|no local config file/);
  }
  assert.equal(existsSync(join(env.cwd, '.codex', 'config.toml')), false);
});

test('codex: appends a [mcp_servers.polypad] table and preserves the rest', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  const file = join(env.home, '.codex', 'config.toml');
  mkdirSync(join(env.home, '.codex'), { recursive: true });
  writeFileSync(
    file,
    '# Codex config\nmodel = "gpt-5"\n\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n',
  );
  const outcome = connectCodex({ host: 'codex', env, file });
  assert.equal(outcome.file, file);
  const raw = readFileSync(file, 'utf8');
  assert.match(raw, /model = "gpt-5"/);
  assert.match(raw, /\[mcp_servers\.other\]/);
  assert.match(raw, /\[mcp_servers\.polypad\]/);
  assert.match(raw, new RegExp(`url = "${MCP_URL.replace(/\./g, '\\.')}"`));
  const tables = parseToml(raw);
  assert.equal(tomlHasPolypad(tables), true);
  // Second connect without --force refuses.
  assert.throws(() => connect({ host: 'codex', env }), /already connected to codex/);
});

test('codex: --key becomes http_headers, and a second key is rejected without --force', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  connect({ host: 'codex', env, key: FAKE_KEY });
  const raw = readFileSync(join(env.home, '.codex', 'config.toml'), 'utf8');
  assert.match(raw, new RegExp(`http_headers = \\{ "x-api-key" = "${FAKE_KEY}" \\}`));
  const tables = parseToml(raw);
  const polypad = tables.get('mcp_servers.polypad');
  assert.ok(polypad);
  assert.equal(polypad.get('url'), MCP_URL);
  assert.deepEqual(polypad.get('http_headers'), { 'x-api-key': FAKE_KEY });
});

test('codex: invalid TOML errors out without overwriting', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  const file = join(env.home, '.codex', 'config.toml');
  mkdirSync(join(env.home, '.codex'), { recursive: true });
  writeFileSync(file, '[mcp_servers.other]\nurl = \n');
  assert.throws(() => connect({ host: 'codex', env }), /not valid TOML/);
  assert.equal(readFileSync(file, 'utf8'), '[mcp_servers.other]\nurl = \n');
});

test('codex: --force on an existing polypad table asks for a manual removal', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  connect({ host: 'codex', env });
  // TOML cannot be safely rewritten in place, so --force refuses with guidance.
  assert.throws(() => connect({ host: 'codex', env, force: true }), /remove that table by hand/);
});

test('TOML parser: handles comments, arrays, inline tables and multiline values', () => {
  const doc = parseToml(
    [
      '# a comment with a [bracket] in it',
      'top = 1',
      '',
      '[mcp_servers.other]',
      'url = "https://other.example/mcp" # trailing comment',
      'tags = ["a",',
      '  "b"]',
      'opts = { retries = 3, enabled = true }',
      'note = """multi',
      'line"""',
    ].join('\n'),
  );
  assert.equal(doc.get('')?.get('top'), 1);
  assert.equal(doc.get('mcp_servers.other')?.get('url'), 'https://other.example/mcp');
  assert.deepEqual(doc.get('mcp_servers.other')?.get('tags'), ['a', 'b']);
  assert.deepEqual(doc.get('mcp_servers.other')?.get('opts'), { retries: 3, enabled: true });
  assert.equal(doc.get('mcp_servers.other')?.get('note'), 'multi\nline');
  assert.equal(tomlHasPolypad(doc), false);
});

test('TOML parser: rejects duplicate tables, duplicate keys and unterminated strings', () => {
  assert.throws(() => parseToml('[a]\nx = 1\n[a]\ny = 2\n'), /duplicate table/);
  assert.throws(() => parseToml('[a]\nx = 1\nx = 2\n'), /duplicate key/);
  assert.throws(() => parseToml('x = "unterminated\n'), /unterminated string/);
  assert.throws(() => parseToml('[a\nx = 1\n'), /unbalanced brackets/);
  assert.throws(() => splitTomlLines('x = [1,\n2\n'), /unbalanced brackets/);
});

test('grok: prints instructions, writes nothing, exits 0', async (t) => {
  const { env, home, cleanup } = makeEnv();
  t.after(cleanup);
  const { code, out } = await runMain(['connect', 'grok'], { HOME: home });
  assert.equal(code, 0);
  assert.match(out, new RegExp(MCP_URL.replace(/\./g, '\\.')));
  assert.match(out, /no local config file/i);
  assert.match(out, /What tokens launched on Robinhood Chain today\?/);
  assert.equal(existsSync(join(home, '.grok')), false);
});

test('main: --help, --version, no-host and unknown host', async (t) => {
  const { home, cleanup } = makeEnv();
  t.after(cleanup);
  const help = await runMain(['--help'], { HOME: home });
  assert.equal(help.code, 0);
  assert.match(help.out, /polypad connect <host>/);
  assert.match(help.out, /claude, cursor, codex, gemini, vscode, grok/);

  const version = await runMain(['--version'], { HOME: home });
  assert.equal(version.code, 0);
  assert.match(version.out, /polypad-agent 2\.1\.0/);

  const noHost = await runMain(['connect'], { HOME: home });
  assert.equal(noHost.code, 0);
  assert.match(noHost.out, /Usage:/);

  const unknown = await runMain(['connect', 'windsurf'], { HOME: home });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown host: windsurf/);
});

test('main: connect claude end-to-end prints file, restart and first prompts', async (t) => {
  const { env, home, cleanup } = makeEnv();
  t.after(cleanup);
  const { code, out } = await runMain(['connect', 'claude'], { HOME: home });
  assert.equal(code, 0);
  assert.match(out, /Connected Polypad to claude/);
  assert.match(out, new RegExp(join(env.home, '.claude.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(out, /Restart Claude Code/);
  assert.match(out, /What tokens launched on Robinhood Chain today\?/);
  assert.match(out, /Start a tokenized fund for me\./);
});

test('main: --dry-run prints the change and writes nothing; key value never printed', async (t) => {
  const { home, cleanup } = makeEnv();
  t.after(cleanup);
  const { code, out } = await runMain(['connect', 'cursor', '--key', FAKE_KEY_2, '--dry-run'], { HOME: home });
  assert.equal(code, 0);
  assert.match(out, /Dry run/);
  assert.match(out, /\*\*\*/);
  assert.doesNotMatch(out, new RegExp(FAKE_KEY_2));
  assert.equal(existsSync(join(home, '.cursor', 'mcp.json')), false);
});

test('main: connect --list shows hosts and connection state', async (t) => {
  const { home, cleanup } = makeEnv();
  t.after(cleanup);
  const before = await runMain(['connect', '--list'], { HOME: home });
  assert.equal(before.code, 0);
  assert.match(before.out, /claude\s+not connected/);
  assert.match(before.out, /grok\s+manual setup/);

  await runMain(['connect', 'claude'], { HOME: home });
  const after = await runMain(['connect', '--list'], { HOME: home });
  assert.match(after.out, /claude\s+connected/);
  assert.match(after.out, /cursor\s+not connected/);
});

test('hostStatus and listStatus agree with the files on disk', (t) => {
  const { env, cleanup } = makeEnv();
  t.after(cleanup);
  assert.equal(hostStatus('claude', env).status, 'not connected');
  assert.equal(hostStatus('grok', env).status, 'manual');
  connect({ host: 'vscode', env });
  assert.equal(hostStatus('vscode', env).status, 'connected');
  const rows = listStatus(env);
  assert.equal(rows.length, 6);
  assert.equal(rows.find((r) => r.host === 'vscode')?.status, 'connected');
});

test('parseArgs: flags, --key=value, and errors', () => {
  assert.deepEqual(parseArgs(['connect', 'claude', '--key', FAKE_KEY, '--local', '--force']), {
    command: 'connect',
    host: 'claude',
    key: FAKE_KEY,
    local: true,
    force: true,
  });
  assert.equal(parseArgs(['connect', 'cursor', '--key=pp_live_x']).key, 'pp_live_x');
  assert.match(parseArgs(['connect', 'claude', '--nope']).error ?? '', /Unknown option/);
  assert.match(parseArgs(['connect', 'claude', '--key']).error ?? '', /--key needs a value/);
});
