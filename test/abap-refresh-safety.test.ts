import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { buildGraph } from '../src/graph/build.js';
import { ensureFreshGraph } from '../src/graph/refresh.js';
import { checkGraph, formatGraphCheckReport } from '../src/graph/check.js';
import { fingerprintPath } from '../src/graph/fingerprint.js';
import { readGraph, wiringPath } from '../src/graph/write.js';
import { beginExport, completeExport, verifyExport } from '../src/graph/source-state.js';
import { callTool } from '../src/mcp/tools.js';

const TARGET = `CLASS zcl_target DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION.
CLASS-METHODS ping.
ENDCLASS.
CLASS zcl_target IMPLEMENTATION.
METHOD ping.
ENDMETHOD.
ENDCLASS.
`;
const CALLER = 'REPORT zcaller.\nSTART-OF-SELECTION.\n zcl_target=>ping( ).\n';

function fixture(protectedExport = false) {
  const base = mkdtempSync(join(tmpdir(), 'graft-safe-export-'));
  const root = join(base, 'repo'), out = join(base, 'graph'), staged = join(base, 'staged'), state = join(base, 'export.json');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(staged, 'src'), { recursive: true });
  const writeSources = (dir: string) => {
    writeFileSync(join(dir, 'src/zcl_target.clas.abap'), TARGET);
    writeFileSync(join(dir, 'src/zcaller.prog.abap'), CALLER);
  };
  writeSources(root); writeSources(staged);
  if (protectedExport) {
    const generation = beginExport(root, staged, state).generation;
    completeExport(root, state, generation);
    mkdirSync(join(out, '.graph'), { recursive: true });
    writeFileSync(join(out, '.graph/source-policy.json'), JSON.stringify({ sourceState: state, onlyDirs: ['src'] }));
  }
  return { base, root, out, staged, state, opts: { contextDir: out, onlyDirs: ['src'] }, cleanup() {
    assert.ok(!relative(resolve(tmpdir()), resolve(base)).startsWith('..'));
    assert.ok(base.includes('graft-safe-export-'));
    rmSync(base, { recursive: true, force: true });
  } };
}

function saved(out: string) {
  return { graph: readFileSync(wiringPath(out), 'utf8'), fingerprint: readFileSync(fingerprintPath(out), 'utf8'),
    diagnostics: readFileSync(join(out, '.graph/abap-diagnostics.json'), 'utf8') };
}

test('missing indexed src retains graph/fingerprint and never reports check OK', async () => {
  const f = fixture();
  try {
    await buildGraph(f.root, f.opts);
    const before = saved(f.out);
    renameSync(join(f.root, 'src'), join(f.base, 'paused-src'));
    const refresh = await ensureFreshGraph(f.root, f.opts);
    assert.equal(refresh.refreshed, false);
    assert.match(refresh.note!, /not verified current.*source directory unavailable/i);
    assert.deepEqual(saved(f.out), before);
    const check = await checkGraph(f.root, f.opts);
    assert.equal(check.ok, false);
    assert.match(formatGraphCheckReport(check), /ANALYSIS INCOMPLETE/);
    renameSync(join(f.base, 'paused-src'), join(f.root, 'src'));
    assert.equal((await checkGraph(f.root, f.opts)).ok, true);
  } finally { f.cleanup(); }
});

test('active export blocks queries even before its first source byte changes', async () => {
  const f = fixture(true);
  try {
    await buildGraph(f.root, f.opts); const before = saved(f.out);
    beginExport(f.root, f.staged, f.state);
    const result = await callTool(f.root, 'graft_trace_calls', { symbol: 'ZCL_TARGET=>PING' }, f.out);
    assert.equal(result.isError, false);
    assert.match(result.text, /still updating/);
    assert.match(result.text, /zcaller/i);
    assert.deepEqual(saved(f.out), before);
    assert.equal((await checkGraph(f.root, f.opts)).ok, false);
  } finally { f.cleanup(); }
});

test('paused partial copy cannot complete or replace the graph; verified deletion can', async () => {
  const f = fixture(true);
  try {
    await buildGraph(f.root, f.opts); const before = saved(f.out);
    const generation = beginExport(f.root, f.staged, f.state).generation;
    rmSync(join(f.root, 'src/zcl_target.clas.abap'));
    assert.throws(() => completeExport(f.root, f.state, generation), /incomplete/);
    assert.equal((await ensureFreshGraph(f.root, f.opts)).refreshed, false);
    assert.deepEqual(saved(f.out), before);
    // A subsequent, completed export really deletes this object.
    rmSync(join(f.staged, 'src/zcl_target.clas.abap'));
    const deletion = beginExport(f.root, f.staged, f.state).generation;
    completeExport(f.root, f.state, deletion);
    assert.equal((await ensureFreshGraph(f.root, f.opts)).refreshed, true);
    assert.ok(!readGraph(wiringPath(f.out))!.nodes.some(n => n.name.toLowerCase() === 'ping'));
    const trace = await callTool(f.root, 'graft_trace_calls', { symbol: 'ZCL_TARGET=>PING', depth: 2 }, f.out);
    assert.equal(trace.isError, false);
    assert.match(trace.text, /Unresolved call references/);
    assert.match(trace.text, /No transitive path is inferred/);
    assert.match(trace.text, /zcaller/i);
    assert.equal((await checkGraph(f.root, f.opts)).ok, true);
  } finally { f.cleanup(); }
});

test('ready manifest rejects altered bytes, extra files, wrong generation and malformed policy', async () => {
  const f = fixture(true);
  try {
    await buildGraph(f.root, f.opts); const before = saved(f.out);
    writeFileSync(join(f.root, 'src/zcaller.prog.abap'), CALLER + '* changed\n');
    assert.throws(() => verifyExport(f.root, f.state), /incomplete or modified/);
    await assert.rejects(buildGraph(f.root, f.opts), /incomplete or modified/);
    assert.deepEqual(saved(f.out), before);
    writeFileSync(join(f.root, 'src/zcaller.prog.abap'), CALLER);
    writeFileSync(join(f.root, 'src/extra.prog.abap'), 'REPORT extra.');
    assert.throws(() => verifyExport(f.root, f.state), /incomplete/);
    const generation = beginExport(f.root, f.staged, f.state).generation;
    assert.throws(() => completeExport(f.root, f.state, generation + '-wrong'), /generation changed/);
    writeFileSync(join(f.out, '.graph/source-policy.json'), '{');
    assert.equal((await ensureFreshGraph(f.root, f.opts)).refreshed, false);
    assert.deepEqual(saved(f.out), before);
  } finally { f.cleanup(); }
});

test('broken ABAP structure retains last good graph and reports analysis failure', async () => {
  const f = fixture();
  try {
    await buildGraph(f.root, f.opts); const before = saved(f.out);
    writeFileSync(join(f.root, 'src/zcl_target.clas.abap'), TARGET.replace('ENDMETHOD.', ''));
    await assert.rejects(buildGraph(f.root, f.opts), /ABAP analysis rejected/);
    const result = await ensureFreshGraph(f.root, f.opts);
    assert.equal(result.refreshed, false);
    assert.match(result.note!, /ABAP analysis rejected/);
    assert.deepEqual(saved(f.out), before);
    assert.match(formatGraphCheckReport(await checkGraph(f.root, f.opts)), /ANALYSIS INCOMPLETE/);
  } finally { f.cleanup(); }
});

test('malformed ABAP metadata is a failure rather than a clean new graph', async () => {
  const f = fixture();
  try {
    await buildGraph(f.root, f.opts); const before = saved(f.out);
    writeFileSync(join(f.root, 'src/zcl_target.clas.xml'), '<abapGit><broken></abapGit>');
    await assert.rejects(buildGraph(f.root, f.opts), /Invalid XML/);
    assert.deepEqual(saved(f.out), before);
    assert.equal((await checkGraph(f.root, f.opts)).ok, false);
  } finally { f.cleanup(); }
});

test('source changed after enumeration cannot publish mixed source bytes', async () => {
  const f = fixture();
  try {
    await buildGraph(f.root, f.opts); const before = saved(f.out);
    await assert.rejects(buildGraph(f.root, { ...f.opts, onProgress: event => {
      if (event.phase === 'parse' && event.index === event.total - 1) {
        writeFileSync(join(f.root, 'src/new.prog.abap'), 'REPORT new.');
      }
    } }), /Source file set changed/);
    assert.deepEqual(saved(f.out), before);
  } finally { f.cleanup(); }
});

test('graph check detects a missing ABAP edge even when every source/node hash matches', async () => {
  const f = fixture();
  try {
    await buildGraph(f.root, f.opts);
    const graph = readGraph(wiringPath(f.out))!;
    graph.edges = graph.edges.filter(edge => edge.relation !== 'calls');
    writeFileSync(wiringPath(f.out), JSON.stringify(graph));
    const check = await checkGraph(f.root, f.opts);
    assert.equal(check.ok, false);
    assert.equal(check.changed.length, 0);
    assert.equal(check.relationshipsChanged, 1);
  } finally { f.cleanup(); }
});

test('undecodable ABAP cannot silently remove definitions from a valid graph', async () => {
  const f = fixture();
  try {
    await buildGraph(f.root, f.opts); const before = saved(f.out);
    writeFileSync(join(f.root, 'src/zcl_target.clas.abap'), Buffer.from([0xfe, 0xff, 0, 65]));
    await assert.rejects(buildGraph(f.root, f.opts), /unsupported source encoding/);
    assert.deepEqual(saved(f.out), before);
    assert.equal((await checkGraph(f.root, f.opts)).ok, false);
  } finally { f.cleanup(); }
});
