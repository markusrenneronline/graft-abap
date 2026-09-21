import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
// Match the child process's extractor stamp when preparing a current graph.
import { buildGraph } from '../dist/graph/build.js';

async function launch(failRuntime = false, mode: 'pilot' | 'cli' = 'pilot', failAbap = false) {
  const base = mkdtempSync(join(tmpdir(), 'graft-lazy-mcp-')), repo = join(base, 'repo'), graph = join(base, 'graph');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/zboot.prog.abap'), 'REPORT zboot.');
  await buildGraph(repo, { contextDir: graph, onlyDirs: ['src'] });
  const config = join(base, 'config.json'), log = join(base, 'loads.txt'), hook = join(base, 'loader.mjs'), preload = join(base, 'preload.mjs');
  writeFileSync(config, JSON.stringify({ repository: repo, graphDirectory: graph, abapVersion: '7.50' }));
  writeFileSync(hook, `import { appendFileSync } from 'node:fs';
export async function load(url, context, next) {
 if (url.includes('/dist/mcp/tools.js') || url.includes('/dist/engine.js') || url.includes('/dist/graph/abap.js') || url.includes('/node_modules/@abaplint/')) {
  appendFileSync(${JSON.stringify(log)}, url + '\\n');
  if (${failRuntime} && url.endsWith('/dist/mcp/tools.js')) throw new Error('fixture runtime unavailable');
  if (${failAbap} && (url.endsWith('/dist/graph/abap.js') || url.includes('/node_modules/@abaplint/'))) throw new Error('fixture ABAP parser unavailable');
 }
 return next(url, context);
}`);
  writeFileSync(preload, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hook).href)});`);
  const run = fileURLToPath(new URL('../pilot/run.mjs', import.meta.url));
  const entry = mode === 'pilot' ? [run, '--config', config, 'mcp']
    : [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--dir', graph, 'mcp', repo];
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, ...entry], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, DO_NOT_TRACK: '1', GRAFT_NO_UPKEEP: '1', GRAFT_NO_SAVINGS: '1', GRAFT_NO_GITIGNORE: '1', GRAFT_NO_IGNORE: '1', GRAFT_STRUCTURAL_ONLY: '1' },
  });
  const stopped = new Promise(resolve => child.once('close', resolve));
  let id = 0, stderr = '';
  const pending = new Map<number, any>();
  const fail = (error: Error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on('error', fail); child.stdin.on('error', fail);
  child.on('exit', code => fail(new Error(`MCP exit ${code}: ${stderr}`)));
  child.stderr.on('data', bytes => stderr += bytes);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try {
    const reply = JSON.parse(line), item = pending.get(reply.id); if (!item) return;
    clearTimeout(item.timer); pending.delete(reply.id); item.resolve(reply);
  } catch (error) { fail(error as Error); } });
  return {
    rpc: (method: string, params = {}) => new Promise<any>((resolve, reject) => {
      const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timeout ${method}: ${stderr}`)); }, 15000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    }),
    loads: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
    cleanup: async () => { child.kill(); await stopped; lines.close(); rmSync(base, { recursive: true, force: true }); },
  };
}

test('pinned MCP initialize, ping and full schema do not load the analysis runtime', async () => {
  const server = await launch(true);
  try {
    const init = await server.rpc('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(init.result.protocolVersion, '2024-11-05'); assert.equal(init.result.serverInfo.name, 'graft');
    assert.equal(typeof init.result.instructions, 'string');
    const list = await server.rpc('tools/list');
    assert.equal(list.result.tools.length, 8);
    assert.equal(createHash('sha256').update(JSON.stringify(list.result.tools)).digest('hex'), '0a46b1db90e38c436759cfeb5a026011bc7b24084e1c8acf6a4ae4b3bc60f26c');
    assert.deepEqual((await server.rpc('ping')).result, {});
    assert.deepEqual(server.loads(), []);
  } finally { await server.cleanup(); }
});

test('concurrent first MCP tool calls share one runtime load and return their own results', async () => {
  const server = await launch();
  try {
    await server.rpc('initialize'); await server.rpc('tools/list');
    assert.deepEqual(server.loads(), []);
    const results = await Promise.all([
      server.rpc('tools/call', { name: 'graft_check_freshness', arguments: {} }),
      server.rpc('tools/call', { name: 'graft_repo_map', arguments: {} }),
    ]);
    for (const reply of results) assert.equal(reply.result.isError, false, JSON.stringify(reply));
    assert.match(JSON.stringify(results[0]), /graph check: OK/);
    assert.match(JSON.stringify(results[1]), /zboot/i);
    assert.equal(server.loads().filter(url => url.endsWith('/dist/mcp/tools.js')).length, 1);
    assert.equal(server.loads().filter(url => url.endsWith('/dist/engine.js')).length, 1);
  } finally { await server.cleanup(); }
});

test('a deferred runtime import failure returns a protocol error and leaves discovery and ping alive', async () => {
  const server = await launch(true);
  try {
    await server.rpc('initialize');
    for (let index = 0; index < 2; index++) {
      const reply = await server.rpc('tools/call', { name: 'graft_repo_map', arguments: {} });
      assert.equal(reply.error.code, -32603); assert.match(reply.error.message, /fixture runtime unavailable/);
    }
    assert.deepEqual((await server.rpc('ping')).result, {});
    assert.equal((await server.rpc('tools/list')).result.tools.length, 8);
    assert.equal(server.loads().filter(url => url.endsWith('/dist/mcp/tools.js')).length, 1);
  } finally { await server.cleanup(); }
});

for (const mode of ['pilot', 'cli'] as const) {
  test(`${mode} MCP serves a fresh ABAP graph with the parser unavailable`, async () => {
    const server = await launch(false, mode, true);
    try {
      await server.rpc('initialize');
      assert.equal((await server.rpc('tools/list')).result.tools.length, 8);
      const reply = await server.rpc('tools/call', { name: 'graft_repo_map', arguments: {} });
      assert.equal(reply.result.isError, false, JSON.stringify(reply));
      assert.match(JSON.stringify(reply), /zboot/i);
      assert.doesNotMatch(JSON.stringify(reply), /not verified current/i);
      assert.ok(!server.loads().some(url => url.endsWith('/dist/graph/abap.js') || url.includes('/node_modules/@abaplint/')));
    } finally { await server.cleanup(); }
  });
}
