import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { extractAbapFiles, type AbapExtraction } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';
import { buildGraph } from '../src/graph/build.js';
import { callTool } from '../src/mcp/tools.js';
import { formatTraceEvidence } from '../src/graph/trace-evidence.js';
import type { GraphV1 } from '../src/graph/types.js';

const leaf = `CLASS leaf DEFINITION. PUBLIC SECTION.
METHODS constructor IMPORTING seed TYPE string OPTIONAL.
METHODS next RETURNING VALUE(r) TYPE REF TO leaf.
METHODS ping IMPORTING value TYPE string OPTIONAL. ENDCLASS.`;
const parse = (source: string) => {
  const g = extractAbapFiles(new Map([['src/znew.prog.abap', `REPORT znew.\n${source}`]]));
  assert.deepEqual(g.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  return g;
};
const calls = (g: AbapExtraction) => g.edges.filter(e => e.relation === 'calls');
const target = (g: AbapExtraction, name: string) => calls(g).filter(e => g.nodes.find(n => n.id === e.target)?.name === name);

test('NEW chains resolve local methods and constructors with separate actuals and source occurrences', () => {
  const g = parse(`${leaf} NEW leaf( seed = 'ctor' )->ping( value = 'method' ).`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(calls(g).length, 2);
  const ctor = target(g, 'CONSTRUCTOR')[0].callSites![0];
  const ping = target(g, 'PING')[0].callSites![0];
  assert.deepEqual(ctor.arguments, { SEED: "'ctor'" });
  assert.deepEqual(ping.arguments, { VALUE: "'method'" });
  assert.notEqual(ctor.occurrence?.column, ping.occurrence?.column);
  assert.equal(ctor.construction?.className, 'LEAF');
  assert.equal(ctor.construction?.implicitForwarding, false);
  assert.equal(ping.receiverType?.basis, 'new');
  assert.equal(ping.receiverType?.source.text, "NEW leaf( seed = 'ctor' )");
  assert.ok(calls(g).every(e => g.nodes.find(n => n.id === e.source)?.name === 'ZNEW'));
});

test('NEW and CAST starts continue through declared return types', () => {
  const g = parse(`${leaf} DATA ref TYPE REF TO object.
NEW leaf( )->next( )->ping( ).
CAST leaf( ref )->next( )->ping( ).`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(target(g, 'CONSTRUCTOR')[0].callSites?.length, 1, 'CAST must never create a constructor call');
  assert.deepEqual(target(g, 'NEXT')[0].callSites?.map(s => s.receiverType?.basis), ['new', 'cast']);
  assert.ok(target(g, 'PING')[0].callSites?.every(s => s.receiverType?.name === 'LEAF' && !s.receiverType.basis));
});

test('CAST interface targets its declaration and does not pick an implementation class', () => {
  const g = parse(`INTERFACE lif. METHODS ping. ENDINTERFACE.
CLASS concrete DEFINITION. PUBLIC SECTION. INTERFACES lif. ENDCLASS.
CLASS concrete IMPLEMENTATION. METHOD lif~ping. ENDMETHOD. ENDCLASS.
DATA ref TYPE REF TO object. CAST lif( ref )->ping( ).`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(g.nodes.find(n => n.id === target(g, 'PING')[0].target)?.owner, 'LIF');
  const graph: GraphV1 = { ...g, meta: { version: 1, nodeCount: g.nodes.length, edgeCount: g.edges.length, languages: ['abap'] } };
  const output = formatTraceEvidence(graph, g.nodes.find(n => n.name === 'ZNEW')!, 'out', 1);
  assert.match(output, /CAST target type/);
  assert.match(output, /cast success.*not (proven|evaluated)/);
  assert.match(output, /Receiver expression/);
});

test('implicit constructors forward to a known base but do not invent constructor nodes', () => {
  const g = parse(`${leaf}
CLASS child DEFINITION INHERITING FROM leaf. ENDCLASS.
CLASS plain DEFINITION. PUBLIC SECTION. METHODS ping. ENDCLASS.
NEW child( seed = 'base' )->ping( ). NEW plain( )->ping( ).`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(g.nodes.filter(n => n.name === 'CONSTRUCTOR').length, 1);
  assert.equal(target(g, 'CONSTRUCTOR').length, 1);
  const site = target(g, 'CONSTRUCTOR')[0].callSites![0];
  assert.equal(site.construction?.className, 'CHILD');
  assert.equal(site.construction?.implicitForwarding, true);
  assert.deepEqual(site.arguments, { SEED: "'base'" });
});

test('an explicit child constructor is selected without adding an automatic base call', () => {
  const g = parse(`${leaf}
CLASS child DEFINITION INHERITING FROM leaf. PUBLIC SECTION. METHODS constructor. ENDCLASS.
NEW child( )->ping( ).`);
  assert.equal(target(g, 'CONSTRUCTOR').length, 1);
  assert.equal(g.nodes.find(n => n.id === target(g, 'CONSTRUCTOR')[0].target)?.owner, 'CHILD');
});

test('standalone and nested NEW occurrences are recorded once; positional actuals remain incomplete', () => {
  const g = parse(`${leaf}
DATA(a) = NEW leaf( 'positional' ).
DATA(b) = NEW leaf( seed = 'named' ).
NEW leaf( seed = helper=>value( ) )->ping( value = helper=>value( ) ).
CLASS helper DEFINITION. PUBLIC SECTION. CLASS-METHODS value RETURNING VALUE(r) TYPE string. ENDCLASS.`);
  const sites = target(g, 'CONSTRUCTOR')[0].callSites!;
  assert.equal(sites.length, 3);
  assert.equal(sites[0].argumentsComplete, false);
  assert.equal(sites[1].argumentsComplete, true);
  assert.deepEqual(sites[2].arguments, { SEED: 'helper=>value( )' });
  assert.equal(target(g, 'VALUE')[0].callSites?.length, 2);
});

test('generic, inferred, unknown and shadowed types cannot borrow a globally unique method', () => {
  for (const expression of ['NEW #( )', 'CAST #( ref )', 'CAST object( ref )', 'NEW unknown( )']) {
    const g = parse(`${leaf} DATA ref TYPE REF TO object. ${expression}->ping( ).`);
    assert.equal(calls(g).length, 0, expression);
    assert.equal(g.unresolvedCalls.length, 1, expression);
  }
  for (const expression of ['NEW leaf( )', 'CAST leaf( ref )']) {
    const g = parse(`${leaf}
CLASS caller DEFINITION. PUBLIC SECTION. TYPES leaf TYPE i. METHODS run. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. DATA ref TYPE REF TO data. ${expression}->ping( ). ENDMETHOD. ENDCLASS.`);
    assert.equal(calls(g).length, 0);
    assert.equal(g.unresolvedCalls.length, 1);
  }
});

test('NEW of a data type, interface or ambiguous class never manufactures object constructor edges', () => {
  const g = parse(`TYPES num TYPE i. DATA(a) = NEW num( ).
INTERFACE lif. METHODS ping. ENDINTERFACE. NEW lif( )->ping( ).`);
  assert.equal(calls(g).length, 0);
  const ambiguous = extractAbapFiles(new Map([
    ['src/a/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS constructor. METHODS ping. ENDCLASS.'],
    ['src/b/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS constructor. METHODS ping. ENDCLASS.'],
    ['src/znew.prog.abap', 'REPORT znew. NEW zleaf( )->ping( ).'],
  ]));
  assert.equal(calls(ambiguous).length, 0);
  assert.equal(ambiguous.unresolvedCalls.length, 1);
});

test('attribute and dereference steps never reuse the initial object type', () => {
  const g = parse(`${leaf} DATA ref TYPE REF TO object.
NEW leaf( )->child->ping( ). CAST leaf( ref )->child->ping( ).`);
  assert.equal(target(g, 'PING').length, 0);
  assert.equal(g.unresolvedCalls.length, 2);
});

test('missing and cyclic bases do not invent an implicit constructor or hide an own method', () => {
  for (const extra of ['', 'CLASS base DEFINITION INHERITING FROM child. ENDCLASS.']) {
    const g = parse(`CLASS child DEFINITION INHERITING FROM base. PUBLIC SECTION. METHODS ping. ENDCLASS.
${extra} NEW child( )->ping( ).`);
    assert.equal(target(g, 'CONSTRUCTOR').length, 0);
    assert.equal(target(g, 'PING').length, 1);
  }
});

test('multiline receiver evidence remains an exact source fragment and nested NEW arguments are independent', () => {
  const g = parse(`${leaf}
CLASS holder DEFINITION. PUBLIC SECTION. METHODS constructor IMPORTING obj TYPE REF TO leaf. METHODS ping. ENDCLASS.
NEW holder( obj = NEW leaf(
  seed = 'inner'
) )->ping( ).`);
  const ctors = target(g, 'CONSTRUCTOR');
  assert.equal(ctors.length, 2);
  const holder = ctors.find(e => g.nodes.find(n => n.id === e.target)?.owner === 'HOLDER')!.callSites![0];
  const inner = ctors.find(e => g.nodes.find(n => n.id === e.target)?.owner === 'LEAF')!.callSites![0];
  assert.deepEqual(inner.arguments, { SEED: "'inner'" });
  assert.match(holder.arguments!.OBJ, /NEW leaf\(/);
  const source = target(g, 'PING')[0].callSites![0].receiverType!.source;
  assert.equal(source.text, "NEW holder( obj = NEW leaf(\n  seed = 'inner'\n) )");
  const [first, last] = source.span.match(/\d+/g)!.map(Number);
  assert.equal(last - first, 2);
});

test('constructor type changes under parser reuse match a cold parse', () => {
  const sources = new Map([['src/znew.prog.abap', `REPORT znew. ${leaf} NEW leaf( )->ping( ).`]]);
  const session = new AbapParseSession();
  assert.equal(extractAbapFiles(sources, session).unresolvedCalls.length, 0);
  sources.set('src/znew.prog.abap', 'REPORT znew. NEW leaf( )->ping( ).');
  const changed = extractAbapFiles(sources, session);
  assert.deepEqual(changed, extractAbapFiles(sources));
  assert.equal(calls(changed).length, 0);
  assert.equal(changed.unresolvedCalls.length, 1);
});

test('NEW and CAST evidence survives persistence and target deletion via MCP refresh', async () => {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, 'graft-new-cast-'));
  try {
    mkdirSync(join(root, 'src'));
    const declaration = 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS constructor. METHODS ping. ENDCLASS.';
    const implementation = 'CLASS zleaf IMPLEMENTATION. METHOD constructor. ENDMETHOD. METHOD ping. ENDMETHOD. ENDCLASS.';
    writeFileSync(join(root, 'src/zleaf.clas.abap'), `${declaration} ${implementation}`);
    writeFileSync(join(root, 'src/znew.prog.abap'), 'REPORT znew. DATA ref TYPE REF TO object. NEW zleaf( )->ping( ). CAST zleaf( ref )->ping( ).');
    await buildGraph(root);
    const trace = await callTool(root, 'graft_trace_calls', { symbol: 'ZLEAF=>PING', direction: 'in' });
    assert.equal(trace.isError, false, trace.text);
    assert.match(trace.text, /NEW object type/);
    assert.match(trace.text, /CAST target type/);
    const ctor = await callTool(root, 'graft_trace_calls', { symbol: 'ZLEAF=>CONSTRUCTOR', direction: 'in' });
    assert.equal(ctor.isError, false, ctor.text);
    assert.match(ctor.text, /Object construction: ZLEAF/);
    const targetPath = join(root, 'src/zleaf.clas.abap');
    assert.equal(dirname(targetPath), join(root, 'src'));
    rmSync(targetPath);
    const refs = await callTool(root, 'graft_unresolved_calls', { source: 'ZNEW', evidence: true });
    assert.equal(refs.isError, false, refs.text);
    assert.match(refs.text, /2 matched of 2 recorded/);
    assert.match(refs.text, /unresolved_receiver/);
  } finally {
    assert.equal(dirname(root), parent);
    rmSync(root, { recursive: true, force: true });
  }
});
