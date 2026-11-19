/**
 * Live read-only smoke test. Reads only — it never prepares, signs, or
 * sends anything. Run: `npm run smoke`
 */
import { PolypadClient } from '../src/index.js';

const client = new PolypadClient({ clientName: 'polypad-agent-smoke' });

const info = await client.initialize();
console.log('server:', info.serverInfo.name, 'v' + info.serverInfo.version, '| protocol:', info.protocolVersion);

const tools = await client.listTools();
console.log('tools:', tools.length, '—', tools.map((t) => t.name).join(', '));

const stats = await client.stats();
console.log('stats:', JSON.stringify(stats));
console.log('smoke OK — reads only, nothing prepared, signed, or sent.');
