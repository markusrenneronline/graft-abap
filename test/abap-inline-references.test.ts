import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAbapFiles, type AbapExtraction } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';
import { buildGraph } from '../src/graph/build.js';
import { callTool } from '../src/mcp/tools.js';
import { formatTraceEvidence } from '../src/graph/trace-evidence.js';
import type { GraphV1 } from '../src/graph/types.js';
import { queryUnresolvedCalls } from '../src/graph/unresolved-calls.js';
import { callSiteExcerpts, validExcerpt } from '../pilot/evaluate-evidence.mjs';

const factory = `CLASS leaf DEFINITION. PUBLIC SECTION.
METHODS next RETURNING VALUE(r) TYPE REF TO leaf. METHODS ping. ENDCLASS.
CLASS maker DEFINITION. PUBLIC SECTION. CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO leaf. ENDCLASS.`;
const parse = (source: string) => {
  const g = extractAbapFiles(new Map([['src/zinline.prog.abap', `REPORT zinline.\n${source}`]]));
  assert.deepEqual(g.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  return g;
};
const targets = (g: AbapExtraction, name: string) => g.edges.filter(e => e.relation === 'calls' && g.nodes.find(n => n.id === e.target)?.name === name);
const graph = (g: AbapExtraction): GraphV1 => ({ ...g, meta: { version: 1, nodeCount: g.nodes.length, edgeCount: g.edges.length, languages: ['abap'] } });

test('inline factory references resolve later calls with declaration and returning evidence', () => {
  const g = parse(`${factory} DATA(ref) = maker=>make( ). ref->ping( ). CALL METHOD ref->ping.`);
  assert.equal(g.unresolvedCalls.length, 0);
  const sites = targets(g, 'PING')[0].callSites!;
  assert.equal(sites.length, 2);
  assert.equal(sites[0].receiverType?.basis, 'inline_returning');
  assert.match(sites[0].receiverType!.source.text, /RETURNING VALUE\(r\) TYPE REF TO leaf/);
  assert.match(sites[0].receiverType!.inlineDeclaration!.text, /DATA\(ref\) = maker=>make/);
  const output = formatTraceEvidence(graph(g), g.nodes.find(n => n.name === 'ZINLINE')!, 'out', 1);
  assert.match(output, /Inline reference declaration/);
  assert.match(output, /Returning declaration/);
});

test('dependent inline declarations follow full method return chains', () => {
  const g = parse(`${factory} DATA(a) = maker=>make( )->next( ). DATA(b) = a->next( ). b->ping( ).`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(targets(g, 'PING').length, 1);
  assert.equal(targets(g, 'NEXT')[0].callSites?.length, 2);
});

test('inline type provenance remains visible when the called method is missing', () => {
  const g = parse(`${factory} DATA(ref) = maker=>make( ). ref->absent( ).`);
  assert.equal(g.unresolvedCalls.length, 1);
  assert.equal(g.unresolvedCalls[0].reason, 'missing_target');
  const inventory = queryUnresolvedCalls(graph(g), { query: 'ABSENT', evidence: true });
  assert.match(inventory, /Returning declaration/);
  assert.match(inventory, /Inline reference declaration/);
});

test('inline source evidence is validated at its own original line', () => {
  const source = `REPORT zinline.\n${factory}\nDATA(ref) = maker=>make( ).\nref->ping( ).`;
  const g = extractAbapFiles(new Map([['src/zinline.prog.abap', source]]));
  const site = targets(g, 'PING')[0].callSites![0];
  assert.ok(callSiteExcerpts(site).every(e => validExcerpt(e, source)));
  site.receiverType!.inlineDeclaration!.span = 'L1-L1';
  assert.equal(callSiteExcerpts(site).every(e => validExcerpt(e, source)), false);
});

test('inline declaration type is static even in a conditional; construction can use it', () => {
  const g = parse(`${factory.replace('METHODS ping.', 'METHODS ping. METHODS constructor.')}
IF allowed = abap_true. DATA(ref) = maker=>make( ). ENDIF. ref->ping( ). CREATE OBJECT ref.`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(targets(g, 'CONSTRUCTOR').length, 1);
  assert.equal(targets(g, 'CONSTRUCTOR')[0].callSites![0].receiverType?.basis, 'inline_returning');
});

test('unqualified factory calls resolve inside their own class', () => {
  const g = parse(`${factory}
CLASS caller DEFINITION. PUBLIC SECTION. METHODS make RETURNING VALUE(r) TYPE REF TO leaf. METHODS run. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. DATA(ref) = make( ). ref->ping( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(targets(g, 'PING').length, 1);
});

test('inline CAST declares its target static type without proving cast success', () => {
  const g = parse(`${factory} DATA generic TYPE REF TO object. DATA(ref) = CAST leaf( generic ). ref->ping( ).`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(targets(g, 'PING')[0].callSites![0].receiverType?.basis, 'inline_cast');
  const output = formatTraceEvidence(graph(g), g.nodes.find(n => n.name === 'ZINLINE')!, 'out', 1);
  assert.match(output, /cast success.*not (proven|inferred)/);
  assert.match(output, /CAST expression/);
});

test('NEW chain assignment uses the final return type, never the initial NEW class', () => {
  const g = parse(`${factory} DATA(ref) = NEW maker( )->make( ). ref->ping( ).`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(targets(g, 'PING')[0].callSites![0].receiverType?.name, 'LEAF');
});

test('NEW attribute suffix cannot incorrectly type an inline reference as the initial class', () => {
  const g = parse(`${factory} DATA(ref) = NEW leaf( )->child. ref->ping( ).`);
  assert.equal(targets(g, 'PING').length, 0);
  assert.equal(g.unresolvedCalls.length, 1);
});

test('normal assignments do not refine an existing generic reference', () => {
  const g = parse(`${factory} DATA ref TYPE REF TO object. ref = maker=>make( ). ref->ping( ).`);
  assert.equal(targets(g, 'PING').length, 0);
  assert.equal(g.unresolvedCalls[0].reason, 'unresolved_receiver');
});

test('later assignments cannot change an inline reference static type', () => {
  const g = parse(`${factory}
CLASS child DEFINITION INHERITING FROM leaf. PUBLIC SECTION. METHODS ping REDEFINITION. ENDCLASS.
DATA(ref) = maker=>make( ). ref = NEW child( ). ref->ping( ).`);
  assert.equal(g.nodes.find(n => n.id === targets(g, 'PING')[0].target)?.owner, 'LEAF');
});

test('generic, unknown, conditional and attribute-ended results stay open', () => {
  for (const expression of ['other=>unknown( obj = maker=>make( ) )', 'COND #( WHEN ok = 1 THEN maker=>make( ) )', 'maker=>make( )->child', 'CAST #( generic )']) {
    const g = parse(`${factory}
CLASS other DEFINITION. PUBLIC SECTION. CLASS-METHODS unknown IMPORTING obj TYPE REF TO leaf RETURNING VALUE(r) TYPE REF TO object. ENDCLASS.
DATA generic TYPE REF TO object. DATA(ref) = ${expression}. ref->ping( ).`);
    assert.equal(targets(g, 'PING').length, 0, expression);
    assert.ok(g.unresolvedCalls.some(r => r.targetName === 'REF->PING'));
  }
});

test('inference cannot escape its method or apply before its declaration', () => {
  const g = parse(`${factory}
CLASS caller DEFINITION. PUBLIC SECTION. METHODS first. METHODS second. ENDCLASS.
CLASS caller IMPLEMENTATION.
METHOD first. ref->ping( ). DATA(ref) = maker=>make( ). ref->ping( ). ENDMETHOD.
METHOD second. DATA ref TYPE REF TO object. ref->ping( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(targets(g, 'PING')[0].callSites?.length, 1);
  assert.equal(g.unresolvedCalls.length, 2);
});

test('same-statement nested reads cannot acquire the new inline binding early', () => {
  const g = parse(`${factory}
CLASS other DEFINITION. PUBLIC SECTION. CLASS-METHODS make IMPORTING input TYPE string RETURNING VALUE(r) TYPE REF TO leaf. ENDCLASS.
DATA(ref) = other=>make( input = ref->ping( ) ). ref->ping( ).`);
  assert.equal(targets(g, 'PING')[0].callSites?.length, 1);
  assert.equal(g.unresolvedCalls.length, 1);
});

test('inline variables retain the declaration namespace across exported factory contracts', () => {
  const g = extractAbapFiles(new Map([
    ['src/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS.'],
    ['src/zfactory.clas.abap', 'CLASS zfactory DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO zleaf. ENDCLASS.'],
    ['src/zinline.prog.abap', 'REPORT zinline. CLASS zleaf DEFINITION. PUBLIC SECTION. METHODS ping. ENDCLASS. DATA(ref) = zfactory=>make( ). ref->ping( ).'],
  ]));
  assert.equal(g.nodes.find(n => n.id === targets(g, 'PING')[0]?.target)?.path, 'src/zleaf.clas.abap');
});

test('inherited return signatures and interface aliases still supply inline object types', () => {
  const g = parse(`${factory}
CLASS child DEFINITION INHERITING FROM maker. PUBLIC SECTION. METHODS extra. ENDCLASS.
INTERFACE lif. METHODS make RETURNING VALUE(r) TYPE REF TO leaf. ENDINTERFACE.
CLASS aliasmaker DEFINITION. PUBLIC SECTION. INTERFACES lif. ALIASES create FOR lif~make. ENDCLASS.
CLASS aliasmaker IMPLEMENTATION. METHOD lif~make. ENDMETHOD. ENDCLASS.
DATA makerref TYPE REF TO aliasmaker. DATA(a) = makerref->create( ). a->ping( ).
DATA(b) = child=>make( ). b->ping( ).`);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(targets(g, 'PING')[0].callSites?.length, 2);
});

test('inline result inference disappears after return signature removal with reused ASTs', () => {
  const files = new Map([['src/zinline.prog.abap', `REPORT zinline. ${factory} DATA(ref) = maker=>make( ). ref->ping( ).`]]);
  const session = new AbapParseSession();
  assert.equal(targets(extractAbapFiles(files, session), 'PING').length, 1);
  files.set('src/zinline.prog.abap', files.get('src/zinline.prog.abap')!.replace('CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO leaf', 'CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO object'));
  const changed = extractAbapFiles(files, session);
  assert.deepEqual(changed, extractAbapFiles(files));
  assert.equal(targets(changed, 'PING').length, 0);
});

test('inline reference evidence persists and MCP refresh removes it after signature change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-inline-refs-'));
  try {
    mkdirSync(join(root, 'src'));
    const makerFile = join(root, 'src/zmaker.clas.abap');
    writeFileSync(join(root, 'src/zleaf.clas.abap'), 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS. CLASS zleaf IMPLEMENTATION. METHOD ping. ENDMETHOD. ENDCLASS.');
    const maker = 'CLASS zmaker DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS make RETURNING VALUE(r) TYPE REF TO zleaf. ENDCLASS. CLASS zmaker IMPLEMENTATION. METHOD make. ENDMETHOD. ENDCLASS.';
    writeFileSync(makerFile, maker);
    writeFileSync(join(root, 'src/zinline.prog.abap'), 'REPORT zinline. DATA(ref) = zmaker=>make( ). ref->ping( ).');
    await buildGraph(root);
    const before = await callTool(root, 'graft_trace_calls', { symbol: 'ZLEAF=>PING', direction: 'in' });
    assert.equal(before.isError, false, before.text);
    assert.match(before.text, /Inline reference declaration/);
    assert.match(before.text, /Returning declaration/);
    writeFileSync(makerFile, maker.replace('TYPE REF TO zleaf', 'TYPE REF TO object'));
    const after = await callTool(root, 'graft_unresolved_calls', { query: 'REF->PING', evidence: true });
    assert.equal(after.isError, false, after.text);
    assert.match(after.text, /1 matched/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
