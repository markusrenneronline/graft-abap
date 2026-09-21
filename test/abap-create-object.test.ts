import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAbapFiles, type AbapExtraction } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';
import { buildGraph } from '../src/graph/build.js';
import { callTool } from '../src/mcp/tools.js';

const leaf = `CLASS leaf DEFINITION. PUBLIC SECTION.
METHODS constructor IMPORTING seed TYPE string OPTIONAL.
METHODS ping. ENDCLASS.`;
const parse = (source: string) => {
  const g = extractAbapFiles(new Map([['src/zcreate.prog.abap', `REPORT zcreate.\n${source}`]]));
  assert.deepEqual(g.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  return g;
};
const ctors = (g: AbapExtraction) => g.edges.filter(e => e.relation === 'calls' && g.nodes.find(n => n.id === e.target)?.name === 'CONSTRUCTOR');

test('CREATE OBJECT resolves explicit and declared types with distinct occurrences and actuals', () => {
  const g = parse(`${leaf} DATA ref TYPE REF TO leaf.
CREATE OBJECT ref EXPORTING seed = 'implicit'. CREATE OBJECT ref TYPE leaf EXPORTING seed = 'explicit'.`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(ctors(g).length, 1);
  const sites = ctors(g)[0].callSites!;
  assert.equal(sites.length, 2);
  assert.deepEqual(sites.map(s => s.arguments), [{ SEED: "'implicit'" }, { SEED: "'explicit'" }]);
  assert.ok(sites.every(s => s.argumentsComplete && s.construction?.className === 'LEAF'));
  assert.notEqual(sites[0].occurrence?.column, sites[1].occurrence?.column);
});

test('CREATE OBJECT parameter lists exclude exception mappings and nested invocation actuals', () => {
  const g = parse(`${leaf}
CLASS helper DEFINITION. PUBLIC SECTION. CLASS-METHODS value IMPORTING input TYPE string RETURNING VALUE(r) TYPE string. ENDCLASS.
DATA ref TYPE REF TO leaf.
CREATE OBJECT ref EXPORTING seed = helper=>value( input = 'inner' ) EXCEPTIONS OTHERS = 1.`);
  const site = ctors(g)[0]?.callSites![0];
  assert.deepEqual(site?.arguments, { SEED: "helper=>value( input = 'inner' )" });
  assert.equal(site?.argumentsComplete, true);
  const helper = g.edges.find(e => e.relation === 'calls' && g.nodes.find(n => n.id === e.target)?.name === 'VALUE');
  assert.deepEqual(helper?.callSites![0].arguments, { INPUT: "'inner'" });
});

test('chain-expanded CREATE OBJECT preserves both source target positions', () => {
  const g = parse(`${leaf} DATA: a TYPE REF TO leaf, b TYPE REF TO leaf. CREATE OBJECT: a, b.`);
  const sites = ctors(g)[0]?.callSites;
  assert.equal(sites?.length, 2);
  assert.notEqual(sites![0].occurrence?.column, sites![1].occurrence?.column);
});

test('CREATE OBJECT uses formal parameter types and does not instantiate interface declarations', () => {
  const g = parse(`${leaf} INTERFACE lif. METHODS ping. ENDINTERFACE.
CLASS caller DEFINITION. PUBLIC SECTION. METHODS run CHANGING ref TYPE REF TO leaf. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. CREATE OBJECT ref. ENDMETHOD. ENDCLASS.
DATA iface TYPE REF TO lif. CREATE OBJECT iface.`);
  assert.equal(ctors(g).length, 1);
  assert.equal(g.nodes.find(n => n.id === ctors(g)[0].source)?.name, 'RUN');
  assert.equal(g.unresolvedCalls.length, 1);
  assert.equal(g.unresolvedCalls[0].reason, 'resolution_incomplete');
});

test('CREATE OBJECT literal TYPE resolves but dynamic names never fall back to variable static type', () => {
  const g = parse(`${leaf} DATA ref TYPE REF TO leaf. DATA name TYPE string.
CREATE OBJECT ref TYPE ('LEAF'). CREATE OBJECT ref TYPE (name). CREATE OBJECT ref TYPE ('leaf').`);
  assert.equal(ctors(g)[0]?.callSites?.length, 1);
  assert.equal(g.unresolvedCalls.length, 2);
  assert.ok(g.unresolvedCalls.every(r => r.reason === 'dynamic_target'));
});

test('CREATE OBJECT dynamic parameter tables cannot be mistaken for omitted defaults', () => {
  const g = parse(`${leaf} DATA ref TYPE REF TO leaf.
CREATE OBJECT ref TYPE ('LEAF') PARAMETER-TABLE args EXCEPTION-TABLE exceptions.`);
  assert.equal(ctors(g).length, 1);
  assert.equal(ctors(g)[0].callSites![0].argumentsComplete, false);
  assert.deepEqual(ctors(g)[0].callSites![0].arguments, {});
});

test('CREATE OBJECT selects explicit child constructor or forwards to known base', () => {
  const g = parse(`${leaf}
CLASS child DEFINITION INHERITING FROM leaf. ENDCLASS.
CLASS own DEFINITION INHERITING FROM leaf. PUBLIC SECTION. METHODS constructor. ENDCLASS.
DATA ref TYPE REF TO object. CREATE OBJECT ref TYPE child EXPORTING seed = 'base'. CREATE OBJECT ref TYPE own.`);
  assert.equal(ctors(g).length, 2);
  const base = ctors(g).find(e => g.nodes.find(n => n.id === e.target)?.owner === 'LEAF')!;
  const own = ctors(g).find(e => g.nodes.find(n => n.id === e.target)?.owner === 'OWN')!;
  assert.equal(base.callSites![0].construction?.implicitForwarding, true);
  assert.equal(base.callSites![0].construction?.className, 'CHILD');
  assert.equal(own.callSites![0].construction?.implicitForwarding, false);
});

test('fully known empty constructors do not invent graph nodes or missing calls', () => {
  const g = parse('CLASS plain DEFINITION. ENDCLASS. DATA ref TYPE REF TO plain. CREATE OBJECT ref.');
  assert.equal(ctors(g).length, 0);
  assert.equal(g.unresolvedCalls.length, 0);
});

test('missing and cyclic constructor ancestry remains an explicit unresolved reference', () => {
  for (const extra of ['', 'CLASS base DEFINITION INHERITING FROM child. ENDCLASS.']) {
    const g = parse(`CLASS child DEFINITION INHERITING FROM base. ENDCLASS. ${extra}
DATA ref TYPE REF TO child. CREATE OBJECT ref.`);
    assert.equal(ctors(g).length, 0);
    assert.equal(g.unresolvedCalls.length, 1);
    assert.equal(g.unresolvedCalls[0].reason, 'resolution_incomplete');
  }
});

test('implicit generic, aliased and component target types stay unresolved', () => {
  for (const [decl, target] of [['DATA ref TYPE REF TO object.', 'ref'], ['TYPES alias TYPE REF TO leaf. DATA ref TYPE alias.', 'ref'], ['DATA ref TYPE REF TO leaf.', 'ref->child']]) {
    const g = parse(`${leaf} ${decl} CREATE OBJECT ${target}.`);
    assert.equal(ctors(g).length, 0, target);
    assert.equal(g.unresolvedCalls.length, 1, target);
    assert.equal(g.unresolvedCalls[0].reason, 'unresolved_receiver');
  }
});

test('unknown local variables hide attributes while explicit ME selects its own attribute', () => {
  const g = parse(`${leaf}
CLASS caller DEFINITION. PUBLIC SECTION. DATA ref TYPE REF TO leaf. METHODS run. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run.
DATA ref TYPE REF TO object. CREATE OBJECT ref. CREATE OBJECT me->ref.
ENDMETHOD. ENDCLASS.`);
  assert.equal(ctors(g)[0]?.callSites?.length, 1);
  assert.match(ctors(g)[0].callSites![0].text, /CREATE OBJECT me->ref/);
  assert.equal(g.unresolvedCalls.length, 1);
});

test('CREATE OBJECT unknown or duplicate explicit classes do not borrow another constructor', () => {
  const missing = parse(`${leaf} DATA ref TYPE REF TO object. CREATE OBJECT ref TYPE absent.`);
  assert.equal(ctors(missing).length, 0);
  assert.equal(missing.unresolvedCalls[0]?.reason, 'missing_target');
  const ambiguous = extractAbapFiles(new Map([
    ['src/a/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS constructor. ENDCLASS.'],
    ['src/b/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS constructor. ENDCLASS.'],
    ['src/zcreate.prog.abap', 'REPORT zcreate. DATA ref TYPE REF TO object. CREATE OBJECT ref TYPE zleaf.'],
  ]));
  assert.equal(ctors(ambiguous).length, 0);
  assert.equal(ambiguous.unresolvedCalls[0]?.reason, 'ambiguous_target');
});

test('explicit CREATE OBJECT does not mutate a generic reference binding for later calls', () => {
  const g = parse(`${leaf} DATA ref TYPE REF TO object. CREATE OBJECT ref TYPE leaf. ref->ping( ).`);
  assert.equal(ctors(g).length, 1);
  assert.equal(g.unresolvedCalls.length, 1);
  assert.equal(g.unresolvedCalls[0].targetName, 'REF->PING');
});

test('CREATE OBJECT under AREA HANDLE retains constructor parameters and surrounding evidence', () => {
  const g = parse(`${leaf} DATA ref TYPE REF TO leaf. DATA seed TYPE string.
seed = 'initial'. IF allowed = abap_true. CREATE OBJECT ref AREA HANDLE area EXPORTING seed = seed. ENDIF.`);
  const site = ctors(g)[0]?.callSites![0];
  assert.deepEqual(site?.arguments, { SEED: 'seed' });
  assert.equal(site?.controls?.[0].kind, 'IF');
  assert.match(site?.localAssignments?.[0].text ?? '', /seed = 'initial'/);
});

test('constructor changes with reused ASTs agree with a fresh parse', () => {
  const files = new Map([['src/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS constructor. ENDCLASS.'],
    ['src/zcreate.prog.abap', 'REPORT zcreate. DATA ref TYPE REF TO zleaf. CREATE OBJECT ref.']]);
  const session = new AbapParseSession();
  assert.equal(ctors(extractAbapFiles(files, session)).length, 1);
  files.delete('src/zleaf.clas.abap');
  const changed = extractAbapFiles(files, session);
  assert.deepEqual(changed, extractAbapFiles(files));
  assert.equal(changed.unresolvedCalls.length, 1);
});

test('CREATE OBJECT persists in MCP and becomes discoverable unresolved evidence after target deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-create-object-'));
  try {
    mkdirSync(join(root, 'src'));
    const classFile = join(root, 'src/zleaf.clas.abap');
    writeFileSync(classFile, 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS constructor. ENDCLASS. CLASS zleaf IMPLEMENTATION. METHOD constructor. ENDMETHOD. ENDCLASS.');
    writeFileSync(join(root, 'src/zcreate.prog.abap'), 'REPORT zcreate. DATA ref TYPE REF TO zleaf. CREATE OBJECT ref.');
    await buildGraph(root);
    const trace = await callTool(root, 'graft_trace_calls', { symbol: 'ZLEAF=>CONSTRUCTOR', direction: 'in' });
    assert.equal(trace.isError, false, trace.text);
    assert.match(trace.text, /Object construction: ZLEAF/);
    assert.match(trace.text, /CREATE OBJECT/);
    rmSync(classFile);
    const inventory = await callTool(root, 'graft_unresolved_calls', { query: 'ZLEAF', evidence: true });
    assert.equal(inventory.isError, false, inventory.text);
    assert.match(inventory.text, /1 matched/);
    assert.match(inventory.text, /CREATE OBJECT ref/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
