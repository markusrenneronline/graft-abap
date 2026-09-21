import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { extractAbapFiles, type AbapExtraction } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';
import { formatTraceEvidence } from '../src/graph/trace-evidence.js';
import { buildGraph } from '../src/graph/build.js';
import { callTool } from '../src/mcp/tools.js';
import type { GraphV1 } from '../src/graph/types.js';

const parse = (source: string) => {
  const result = extractAbapFiles(new Map([['src/zchain.prog.abap', `REPORT zchain.\n${source}`]]));
  assert.deepEqual(result.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  return result;
};
const calls = (g: AbapExtraction) => g.edges.filter(e => e.relation === 'calls');
const target = (g: AbapExtraction, name: string) => calls(g).filter(e => g.nodes.find(n => n.id === e.target)?.name === name);

const factory = `CLASS leaf DEFINITION. PUBLIC SECTION.
METHODS next RETURNING VALUE(r) TYPE REF TO leaf. METHODS ping IMPORTING value TYPE string OPTIONAL. ENDCLASS.
CLASS maker DEFINITION. PUBLIC SECTION. CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO leaf. ENDCLASS.`;

test('RETURNING object types resolve every chain hop with distinct actuals and declaration evidence', () => {
  const g = parse(`${factory}
maker=>make( )->next( )->ping( value = 'one' ).
maker=>make( )->ping( value = 'two' ).`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(calls(g).length, 3);
  const ping = target(g, 'PING')[0];
  assert.equal(ping.confidence, 'inferred');
  assert.deepEqual(ping.callSites?.map(s => s.arguments), [{ VALUE: "'one'" }, { VALUE: "'two'" }]);
  assert.ok(ping.callSites?.every(s => s.receiverType?.name === 'LEAF'));
  assert.match(ping.callSites![0].receiverType!.source.text, /METHODS next/);
  assert.match(ping.callSites![1].receiverType!.source.text, /CLASS-METHODS make/);
  assert.ok(!calls(g).some(e => g.nodes.find(n => n.id === e.source)?.name === 'MAKE'), 'all calls belong to the invoking block, not a fictitious MAKE -> PING body edge');
  const graph: GraphV1 = { ...g, meta: { version: 1, nodeCount: g.nodes.length, edgeCount: g.edges.length, languages: ['abap'] } };
  const trace = formatTraceEvidence(graph, g.nodes.find(n => n.name === 'ZCHAIN')!, 'out', 1);
  assert.match(trace, /Receiver static type: LEAF/);
  assert.match(trace, /Returning declaration/);
});

test('nested argument calls do not supply the receiver type of an enclosing chain', () => {
  const g = parse(`${factory}
CLASS other DEFINITION. PUBLIC SECTION. CLASS-METHODS unknown IMPORTING obj TYPE REF TO leaf RETURNING VALUE(r) TYPE REF TO object. ENDCLASS.
other=>unknown( obj = maker=>make( ) )->ping( ).`);
  assert.equal(calls(g).length, 2);
  assert.equal(target(g, 'PING').length, 0);
  assert.equal(g.unresolvedCalls.length, 1);
});

test('interface returns and alias signatures target declarations, not arbitrary implementations', () => {
  const g = parse(`INTERFACE lif. METHODS ping. ENDINTERFACE.
INTERFACE factory_if. METHODS make RETURNING VALUE(r) TYPE REF TO lif. ENDINTERFACE.
CLASS maker DEFINITION. PUBLIC SECTION. INTERFACES factory_if. ALIASES create FOR factory_if~make. ENDCLASS.
CLASS maker IMPLEMENTATION. METHOD factory_if~make. ENDMETHOD. ENDCLASS.
CLASS concrete DEFINITION. PUBLIC SECTION. INTERFACES lif. ENDCLASS.
CLASS concrete IMPLEMENTATION. METHOD lif~ping. ENDMETHOD. ENDCLASS.
DATA ref TYPE REF TO maker. ref->create( )->ping( ).`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(g.nodes.find(n => n.id === target(g, 'PING')[0].target)?.owner, 'LIF');
  assert.match(target(g, 'PING')[0].callSites![0].receiverType!.source.text, /TYPE REF TO lif/);
});

test('redefinitions inherit their return contract while retaining the redefined call target', () => {
  const g = parse(`${factory}
CLASS base DEFINITION. PUBLIC SECTION. METHODS get RETURNING VALUE(r) TYPE REF TO leaf. ENDCLASS.
CLASS child DEFINITION INHERITING FROM base. PUBLIC SECTION. METHODS get REDEFINITION. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD get. ENDMETHOD. ENDCLASS.
DATA ref TYPE REF TO child. ref->get( )->ping( ).`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(g.nodes.find(n => n.id === target(g, 'GET')[0].target)?.owner, 'CHILD');
  assert.equal(target(g, 'PING').length, 1);
  assert.match(target(g, 'PING')[0].callSites![0].receiverType!.source.text, /METHODS get RETURNING/);
});

test('return types are looked up at the declaration, not in the caller local class namespace', () => {
  const g = extractAbapFiles(new Map([
    ['src/zfactory.clas.abap', 'CLASS zfactory DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO zleaf. ENDCLASS.'],
    ['src/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS.'],
    ['src/zcaller.prog.abap', 'REPORT zcaller. CLASS zleaf DEFINITION. PUBLIC SECTION. METHODS wrong. ENDCLASS. zfactory=>make( )->ping( ).'],
  ]));
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(g.nodes.find(n => n.id === target(g, 'PING')[0].target)?.path, 'src/zleaf.clas.abap');
});

test('data type shadows, generic returns and non-reference returns do not guess a class', () => {
  for (const declaration of ['TYPE REF TO object', 'TYPE REF TO data', 'TYPE string', 'TYPE REF TO leaf', 'LIKE prototype']) {
    const g = parse(`${factory}
CLASS other DEFINITION. PUBLIC SECTION. TYPES leaf TYPE i. DATA prototype TYPE REF TO leaf.
CLASS-METHODS make RETURNING VALUE(r) ${declaration}. ENDCLASS.
other=>make( )->ping( ).`);
    assert.equal(target(g, 'PING').length, 0, declaration);
    assert.equal(g.unresolvedCalls.length, 1, declaration);
  }
});

test('inherited data types and unknown base declarations prevent an unsafe return type guess', () => {
  for (const base of ['CLASS base DEFINITION. PUBLIC SECTION. TYPES leaf TYPE i. ENDCLASS.', '']) {
    const g = parse(`${factory} ${base}
CLASS other DEFINITION INHERITING FROM base. PUBLIC SECTION. CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO leaf. ENDCLASS.
other=>make( )->ping( ).`);
    assert.equal(target(g, 'PING').length, 0);
    assert.equal(g.unresolvedCalls.length, 1);
  }
});

test('missing or ambiguous return types and missing next methods remain explicit references', () => {
  const sources = new Map([
    ['src/zfactory.clas.abap', 'CLASS zfactory DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO zleaf. ENDCLASS.'],
    ['src/zcaller.prog.abap', 'REPORT zcaller. zfactory=>make( )->ping( ).'],
  ]);
  for (const count of [0, 2, 1]) {
    sources.delete('src/a/zleaf.clas.abap'); sources.delete('src/b/zleaf.clas.abap');
    if (count) sources.set('src/a/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. ENDCLASS.');
    if (count === 2) sources.set('src/b/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. ENDCLASS.');
    const g = extractAbapFiles(sources);
    assert.equal(calls(g).length, 1);
    assert.equal(g.unresolvedCalls.length, 1);
    assert.equal(g.unresolvedCalls[0].reason, count === 1 ? 'missing_target' : 'unresolved_receiver');
  }
});

test('unsupported attribute/structure steps do not reuse the preceding return type', () => {
  const g = parse(`${factory}
maker=>make( )->child->ping( ).
maker=>make( )-child->ping( ).`);
  assert.equal(target(g, 'PING').length, 0);
  assert.equal(g.unresolvedCalls.length, 2);
});

test('return signature changes match cold extraction under parser reuse', () => {
  const sources = new Map([['src/zchain.prog.abap', `REPORT zchain. ${factory} maker=>make( )->ping( ).`]]);
  const session = new AbapParseSession();
  assert.equal(extractAbapFiles(sources, session).unresolvedCalls.length, 0);
  sources.set('src/zchain.prog.abap', sources.get('src/zchain.prog.abap')!.replace('CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO leaf', 'CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO object'));
  const changed = extractAbapFiles(sources, session);
  assert.deepEqual(changed, extractAbapFiles(sources));
  assert.equal(changed.unresolvedCalls.length, 1);
});

test('data type aliases in the declaration block hiding a class stay unresolved', () => {
  const g = parse(`${factory}
INTERFACE lif. TYPES target_type TYPE i. ENDINTERFACE.
CLASS other DEFINITION. PUBLIC SECTION. INTERFACES lif. ALIASES leaf FOR lif~target_type.
CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO leaf. ENDCLASS.
other=>make( )->ping( ).`);
  assert.equal(target(g, 'PING').length, 0);
  assert.equal(g.unresolvedCalls.length, 1);
});

test('caller local data types cannot hide a class in the return declaration namespace', () => {
  const g = parse(`${factory}
CLASS caller DEFINITION. PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. TYPES leaf TYPE i.
maker=>make( )->ping( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(target(g, 'PING').length, 1);
});

test('chain-expanded declarations never borrow a previous method return type', () => {
  const g = parse(`CLASS leaf DEFINITION. PUBLIC SECTION. METHODS ping. ENDCLASS.
CLASS maker DEFINITION. PUBLIC SECTION.
CLASS-METHODS: make RETURNING VALUE(r) TYPE REF TO leaf, unknown RETURNING VALUE(r) TYPE REF TO object. ENDCLASS.
maker=>make( )->ping( ). maker=>unknown( )->ping( ).`);
  assert.equal(g.unresolvedCalls.length, 1);
  assert.equal(target(g, 'PING')[0].callSites?.length, 1);
  assert.doesNotMatch(target(g, 'PING')[0].callSites![0].receiverType!.source.text, /unknown/);
});

test('persisted chain evidence and target removal refresh through MCP with an unchanged caller', async () => {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, 'graft-return-chain-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/zleaf.clas.abap'), 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS. CLASS zleaf IMPLEMENTATION. METHOD ping. ENDMETHOD. ENDCLASS.');
    writeFileSync(join(root, 'src/zfactory.clas.abap'), 'CLASS zfactory DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO zleaf. ENDCLASS. CLASS zfactory IMPLEMENTATION. METHOD make. ENDMETHOD. ENDCLASS.');
    writeFileSync(join(root, 'src/zcaller.prog.abap'), 'REPORT zcaller. zfactory=>make( )->ping( ).');
    await buildGraph(root);
    const trace = await callTool(root, 'graft_trace_calls', { symbol: 'ZLEAF=>PING', direction: 'in' });
    assert.equal(trace.isError, false, trace.text);
    assert.match(trace.text, /Receiver static type: ZLEAF/);
    assert.match(trace.text, /Returning declaration.*zfactory.clas.abap/);
    assert.equal(dirname(join(root, 'src/zleaf.clas.abap')), join(root, 'src'));
    rmSync(join(root, 'src/zleaf.clas.abap'));
    const inventory = await callTool(root, 'graft_unresolved_calls', { source: 'ZCALLER', evidence: true });
    assert.equal(inventory.isError, false, inventory.text);
    assert.match(inventory.text, /1 matched of 1 recorded/);
    assert.match(inventory.text, /unresolved_receiver/);
    assert.match(inventory.text, /make\( \)->PING/);
    const outgoing = await callTool(root, 'graft_trace_calls', { symbol: 'ZCALLER', direction: 'out', evidence: false });
    assert.equal(outgoing.isError, false, outgoing.text);
    assert.doesNotMatch(outgoing.text, /calls.*PING/);
  } finally {
    assert.equal(dirname(root), parent);
    rmSync(root, { recursive: true, force: true });
  }
});
