#!/usr/bin/env node
// Uses this installation's compiled runtime and a new synthetic export only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = join(base, 'pilot/run.mjs');
const version = readFileSync(run, 'utf8').match(/const pilotVersion = '([^']+)'/)[1];
const env = { ...process.env, DO_NOT_TRACK: '1', GRAFT_SOURCE_STATE: '' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const optionalHash = path => existsSync(path) ? hash(readFileSync(path)) : null;
const source = `REPORT zhandoff.
CLASS leaf DEFINITION. PUBLIC SECTION.
METHODS constructor. METHODS ping. ENDCLASS.
CLASS leaf IMPLEMENTATION.
METHOD constructor. ENDMETHOD. METHOD ping. ENDMETHOD. ENDCLASS.
CLASS parent DEFINITION. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS parent IMPLEMENTATION. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. ENDCLASS.
CLASS child IMPLEMENTATION. ENDCLASS.
START-OF-SELECTION.
NEW leaf( )->ping( ).
CREATE OBJECT child=>ref.
child=>ref->ping( ).
`;

function command(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: base, env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (result.error || result.status !== 0)
    throw new Error(`${script} failed (exit ${result.status}): ${[result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n')}`);
  return result.stdout;
}

async function mcp(config) {
  const child = spawn(process.execPath, [run, '--config', config, 'mcp'], { cwd: base, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  const stopped = new Promise(resolve => child.once('close', resolve));
  let sequence = 0;
  let stderr = '';
  const fail = error => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error); } pending.clear(); };
  child.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-4000); });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', code => fail(new Error(`MCP exited ${code}: ${stderr}`)));
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    try {
      const result = JSON.parse(line);
      const value = pending.get(result.id);
      if (!value) return;
      clearTimeout(value.timer); pending.delete(result.id);
      if (result.error) value.reject(new Error(JSON.stringify(result.error))); else value.resolve(result.result);
    } catch (error) { fail(error); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}; ${stderr}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  };
  try {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'graft-abap-install-check', version: '1' } });
    assert.equal(init.serverInfo.version, version);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc('tools/list', {});
    assert.equal(list.tools.length, 8);
    assert.equal(Object.keys(list.tools.find(t => t.name === 'graft_trace_calls').inputSchema.properties).length, 9);
    assert.match(await tool('graft_check_freshness'), /graph check: OK/);
    const trace = await tool('graft_trace_calls', { symbol: 'LEAF=>PING', direction: 'in', depth: '2' });
    assert.match(trace, /ZHANDOFF/);
    assert.match(trace, /effective depth: 2/);
    assert.match(trace, /NEW object type/);
    assert.match(trace, /inherited attribute declaration/);
    assert.match(trace, /Attribute inheritance/);
    assert.match(trace, /CLASS child DEFINITION INHERITING FROM parent/);
    assert.match(trace, /CLASS-DATA ref TYPE REF TO leaf/);
    const compact = await tool('graft_trace_calls', { symbol: 'LEAF=>PING', direction: 'in', evidence: false });
    assert.doesNotMatch(compact, /Attribute inheritance|Reference declaration/);
    const ctor = await tool('graft_trace_calls', { symbol: 'LEAF=>CONSTRUCTOR', direction: 'in' });
    assert.match(ctor, /Object construction: LEAF/);
    assert.match(await tool('graft_unresolved_calls'), /0 matched of 0 recorded/);
    assert.match(await tool('graft_diagnostics'), /ABAP diagnostic inventory:/);
    for (const name of ['graft_diagnostics', 'graft_unresolved_calls']) {
      const first = await tool(name);
      const revision = /^\[Inventory\] revision: (inventory:[a-f0-9]{64})$/m.exec(first)?.[1];
      assert.ok(revision);
      assert.match(await tool(name, { offset: 1, revision }), /revision verified/);
      const mismatch = await rpc('tools/call', { name, arguments: { offset: 1, revision: 'inventory:' + '0'.repeat(64) } });
      assert.equal(mismatch.isError, true);
    }
    return { tools: list.tools.length, traceParameters: 9, numericStringDepth: true, newReceiver: true, constructor: true,
      inheritedAttribute: true, inheritedDeclarationAndPath: true, compactEvidenceOmitted: true, noUnresolvedCalls: true, inventoryRevisions: true };
  } finally {
    reader.close(); child.stdin.end();
    if (child.exitCode === null) child.kill();
    // Await actual termination before removing the fixture files.
    await stopped;
    fail(new Error('MCP check ended'));
  }
}

export async function smokeInstallation() {
  const parent = realpathSync.native(tmpdir());
  const temporary = realpathSync.native(mkdtempSync(join(parent, 'graft clean install ')));
  const ownConfig = join(base, 'pilot/config.json');
  const originalConfig = optionalHash(ownConfig);
  try {
    const { beginExport, completeExport } = await import('../dist/graph/source-state.js');
    const repo = join(temporary, 'ABAP export');
    const settings = join(temporary, 'settings');
    mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(settings);
    const sourcePath = join(repo, 'src/zhandoff.prog.abap');
    writeFileSync(sourcePath, source);
    const state = join(settings, 'source-state.json');
    completeExport(repo, state, beginExport(repo, repo, state).generation);
    const config = join(settings, 'config.json');
    writeFileSync(config, JSON.stringify({ repository: repo, graphDirectory: '../graph cache', sourceState: 'source-state.json', abapVersion: '7.50' }));
    command(run, ['--config', config, 'build']);
    assert.match(command(run, ['--config', config, 'check']), /graph check: OK/);
    assert.match(command(run, ['--config', config, 'notices', '--limit', '1', '--offset', '0', '--evidence']), /ABAP diagnostic inventory:/);
    for (const inventory of ['notices', 'unresolved']) {
      const first = command(run, ['--config', config, inventory]);
      const revision = /^\[Inventory\] revision: (inventory:[a-f0-9]{64})$/m.exec(first)?.[1];
      assert.ok(revision);
      assert.match(command(run, ['--config', config, inventory, '--revision', revision, '--offset', '1']), /revision verified/);
      assert.throws(() => command(run, ['--config', config, inventory, '--revision', 'inventory:' + '0'.repeat(64)]), /Inventory changed/);
    }
    const legacy = JSON.parse(command(run, ['--config', config, 'diagnostics']));
    assert.ok(Array.isArray(legacy.first50), 'legacy JSON diagnostic command remains compatible');
    command(run, ['--config', config, 'viz']);
    assert.ok(existsSync(join(temporary, 'graph cache/visual/index.html')));
    const doctor = JSON.parse(command(join(base, 'pilot/doctor.mjs'), ['--config', config]));
    assert.equal(doctor.ok, true); assert.equal(doctor.warnings, 0);
    const protocol = await mcp(config);
    assert.equal(readFileSync(sourcePath, 'utf8'), source);
    assert.equal(optionalHash(ownConfig), originalConfig);
    assert.ok(existsSync(join(temporary, 'graph cache/.graph/wiring.json')));
    assert.ok(!existsSync(join(repo, 'graft')));
    return { ok: true, version, node: process.version, platform: process.platform, architecture: process.arch,
      isolatedConfiguration: true, relativeConfigPaths: true, isolatedVisualization: true, sourceUnchanged: true, existingConfigUnchanged: true,
      doctorWarnings: doctor.warnings, mcp: protocol,
      scope: 'This machine and this installation only; synthetic export, no SAP connection and no second-machine certification.' };
  } finally {
    assert.equal(dirname(temporary), parent);
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await smokeInstallation(), null, 2)); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
