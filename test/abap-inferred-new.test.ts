import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAbapFiles, type AbapExtraction } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';
import { buildGraph } from '../src/graph/build.js';
import { callTool } from '../src/mcp/tools.js';
import { callSiteExcerpts, validExcerpt } from '../pilot/evaluate-evidence.mjs';

const leaf = 'CLASS leaf DEFINITION. PUBLIC SECTION. METHODS constructor IMPORTING seed TYPE string OPTIONAL. METHODS ping. ENDCLASS.';
const parse = (source: string) => {
  const g = extractAbapFiles(new Map([['src/zhash.prog.abap', `REPORT zhash.\n${source}`]]));
  assert.deepEqual(g.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  return g;
};
const ctors = (g: AbapExtraction) => g.edges.filter(e => e.relation === 'calls' && g.nodes.find(n => n.id === e.target)?.name === 'CONSTRUCTOR');

test('NEW # direct assignment uses an explicit reference declaration and keeps actuals', () => {
  const g = parse(`${leaf} DATA ref TYPE REF TO leaf. ref = NEW #( seed = 'value' ).`);
  const site = ctors(g)[0]?.callSites![0];
  assert.equal(ctors(g).length, 1);
  assert.equal(site?.construction?.className, 'LEAF');
  assert.deepEqual(site?.arguments, { SEED: "'value'" });
  assert.equal(site?.argumentsComplete, true);
  assert.equal(site?.construction?.inferredType?.target, 'REF');
  assert.match(site?.construction?.inferredType?.source.text ?? '', /DATA ref TYPE REF TO leaf/);
});

test('NEW # returning parameter uses the method signature as type evidence', () => {
  const g = parse(`${leaf}
CLASS factory DEFINITION. PUBLIC SECTION. CLASS-METHODS make RETURNING VALUE(result) TYPE REF TO leaf. ENDCLASS.
CLASS factory IMPLEMENTATION. METHOD make. result = NEW #( ). ENDMETHOD. ENDCLASS.`);
  const site = ctors(g)[0]?.callSites![0];
  assert.equal(ctors(g).length, 1);
  assert.match(site?.construction?.inferredType?.source.text ?? '', /RETURNING VALUE\(result\) TYPE REF TO leaf/);
});

test('NEW # attributes and ME respect local variable shadowing', () => {
  const g = parse(`${leaf}
CLASS caller DEFINITION. PUBLIC SECTION. DATA ref TYPE REF TO leaf. METHODS run. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. DATA ref TYPE REF TO object.
ref = NEW #( ). me->ref = NEW #( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(ctors(g)[0]?.callSites?.length, 1);
  assert.equal(ctors(g)[0].callSites![0].construction?.inferredType?.target, 'ME->REF');
});

test('NEW # attribute type is resolved in declaration scope despite local data-type shadowing', () => {
  const g = parse(`${leaf}
CLASS caller DEFINITION. PUBLIC SECTION. DATA ref TYPE REF TO leaf. METHODS run. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. TYPES leaf TYPE i. me->ref = NEW #( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(ctors(g).length, 1);
});

test('NEW # local aliases, generic targets and data references cannot borrow a class constructor', () => {
  for (const declaration of ['DATA ref TYPE REF TO object.', 'TYPES alias TYPE REF TO leaf. DATA ref TYPE alias.', 'TYPES leaf TYPE i. DATA ref TYPE REF TO leaf.', 'DATA ref TYPE REF TO i.']) {
    const g = parse(`${leaf} ${declaration} ref = NEW #( ).`);
    assert.equal(ctors(g).length, 0, declaration);
  }
});

test('NEW # cannot infer its type from inline DATA with no independent target type', () => {
  assert.equal(ctors(parse(`${leaf} DATA(ref) = NEW #( ).`)).length, 0);
});

test('NEW # does not reuse assignment target type for nested or method-chain creations', () => {
  const g = parse(`${leaf}
CLASS holder DEFINITION. PUBLIC SECTION. METHODS constructor IMPORTING value TYPE REF TO leaf. ENDCLASS.
DATA ref TYPE REF TO holder. ref = NEW #( value = NEW #( ) ).
DATA other TYPE REF TO leaf. other = NEW #( )->next( ).`);
  assert.equal(ctors(g).length, 1);
  assert.equal(ctors(g)[0].callSites?.length, 1);
  assert.equal(g.nodes.find(n => n.id === ctors(g)[0].target)?.owner, 'HOLDER');
});

test('NEW # standalone unknown target and complex component targets stay unguessed', () => {
  const g = parse(`${leaf} DATA ref TYPE REF TO leaf. ref->child = NEW #( ). missing = NEW #( ).`);
  assert.equal(ctors(g).length, 0);
});

test('NEW # forwards implicit constructor but does not invent a fully known empty one', () => {
  const g = parse(`${leaf} CLASS child DEFINITION INHERITING FROM leaf. ENDCLASS.
CLASS empty DEFINITION. ENDCLASS.
DATA a TYPE REF TO child. DATA b TYPE REF TO empty. a = NEW #( seed = 'base' ). b = NEW #( ).`);
  assert.equal(ctors(g).length, 1);
  assert.equal(ctors(g)[0].callSites![0].construction?.implicitForwarding, true);
  assert.equal(ctors(g)[0].callSites![0].construction?.className, 'CHILD');
});

test('NEW # never instantiates an interface as a class', () => {
  const g = parse('INTERFACE lif. METHODS ping. ENDINTERFACE. DATA ref TYPE REF TO lif. ref = NEW #( ).');
  assert.equal(ctors(g).length, 0);
});

test('NEW # missing and ambiguous target types cannot borrow a known constructor', () => {
  assert.equal(ctors(parse(`${leaf} DATA ref TYPE REF TO absent. ref = NEW #( ).`)).length, 0);
  const g = extractAbapFiles(new Map([
    ['src/a/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS constructor. ENDCLASS.'],
    ['src/b/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS constructor. ENDCLASS.'],
    ['src/zhash.prog.abap', 'REPORT zhash. DATA ref TYPE REF TO zleaf. ref = NEW #( ).'],
  ]));
  assert.equal(ctors(g).length, 0);
});

test('NEW # inline factory target preserves factory declaration namespace', () => {
  const g = extractAbapFiles(new Map([
    ['src/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS constructor. ENDCLASS.'],
    ['src/zfactory.clas.abap', 'CLASS zfactory DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO zleaf. ENDCLASS.'],
    ['src/zhash.prog.abap', 'REPORT zhash. CLASS zleaf DEFINITION. PUBLIC SECTION. METHODS constructor. ENDCLASS. DATA(ref) = zfactory=>make( ). ref = NEW #( ).'],
  ]));
  assert.equal(ctors(g).length, 1);
  assert.equal(g.nodes.find(n => n.id === ctors(g)[0].target)?.path, 'src/zleaf.clas.abap');
  assert.match(ctors(g)[0].callSites![0].construction?.inferredType?.inlineDeclaration?.text ?? '', /DATA\(ref\) = zfactory=>make/);
});

test('NEW # supports target types already proven by earlier inline factory declarations', () => {
  const g = parse(`${leaf} CLASS factory DEFINITION. PUBLIC SECTION. CLASS-METHODS make RETURNING VALUE(result) TYPE REF TO leaf. ENDCLASS.
DATA(ref) = factory=>make( ). ref = NEW #( ).`);
  assert.equal(ctors(g).length, 1);
  assert.match(ctors(g)[0].callSites![0].construction?.inferredType?.source.text ?? '', /RETURNING/);
});

test('NEW # declaration evidence is separately validated and keeps original chain declaration text', () => {
  const source = `REPORT zhash.\n${leaf}\nDATA: num TYPE i, ref TYPE REF TO leaf.\nref = NEW #( ).`;
  const g = extractAbapFiles(new Map([['src/zhash.prog.abap', source]]));
  const site = ctors(g)[0]?.callSites![0];
  assert.ok(site);
  assert.ok(callSiteExcerpts(site).every(e => validExcerpt(e, source)));
  assert.match(site.construction!.inferredType!.source.text, /ref TYPE REF TO leaf/);
  site.construction!.inferredType!.source.span = 'L1-L1';
  assert.equal(callSiteExcerpts(site).every(e => validExcerpt(e, source)), false);
});

test('NEW # target type changes under AST reuse agree with a cold extraction', () => {
  const files = new Map([['src/zhash.prog.abap', `REPORT zhash. ${leaf} DATA ref TYPE REF TO leaf. ref = NEW #( ).`]]);
  const session = new AbapParseSession();
  assert.equal(ctors(extractAbapFiles(files, session)).length, 1);
  files.set('src/zhash.prog.abap', files.get('src/zhash.prog.abap')!.replace('DATA ref TYPE REF TO leaf', 'DATA ref TYPE REF TO object'));
  const changed = extractAbapFiles(files, session);
  assert.deepEqual(changed, extractAbapFiles(files));
  assert.equal(ctors(changed).length, 0);
});

test('NEW # type provenance persists through MCP and signature changes remove stale calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-inferred-new-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/zleaf.clas.abap'), 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS constructor. ENDCLASS. CLASS zleaf IMPLEMENTATION. METHOD constructor. ENDMETHOD. ENDCLASS.');
    const source = join(root, 'src/zhash.prog.abap');
    writeFileSync(source, 'REPORT zhash. DATA ref TYPE REF TO zleaf. ref = NEW #( ).');
    await buildGraph(root);
    const trace = await callTool(root, 'graft_trace_calls', { symbol: 'ZLEAF=>CONSTRUCTOR', direction: 'in' });
    assert.equal(trace.isError, false, trace.text);
    assert.match(trace.text, /Constructor type from assignment target REF/);
    assert.match(trace.text, /Assignment target type declaration/);
    writeFileSync(source, 'REPORT zhash. DATA ref TYPE REF TO object. ref = NEW #( ).');
    const after = await callTool(root, 'graft_trace_calls', { symbol: 'ZLEAF=>CONSTRUCTOR', direction: 'in' });
    assert.equal(after.isError, false, after.text);
    assert.match(after.text, /no indexed callers/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
