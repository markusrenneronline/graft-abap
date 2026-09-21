import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { extractAbapFiles, type AbapExtraction } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';
import { diagnosticId, queryDiagnostics } from '../src/graph/diagnostics.js';
import { buildGraph } from '../src/graph/build.js';
import { callTool } from '../src/mcp/tools.js';
import { verifyDiagnosticEvidence } from '../pilot/evaluate-evidence.mjs';
import type { GraphV1 } from '../src/graph/types.js';

const path = 'src/zconstruct.prog.abap';
const notices = (g: AbapExtraction) => g.diagnostics.filter(d => d.kind === 'unresolved_construction');
const parse = (body: string, extra = new Map<string, string>()) => {
  const source = 'REPORT zconstruct.\n' + body;
  const g = extractAbapFiles(new Map([[path, source], ...extra]));
  assert.deepEqual(g.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  return { g, source };
};
const graphOf = (g: AbapExtraction): GraphV1 => ({ ...g, abap: { files: 1, diagnostics: g.diagnostics },
  meta: { version: 1, nodeCount: g.nodes.length, edgeCount: g.edges.length, languages: ['abap'] } });

test('unknown explicit NEW types are diagnostic occurrences, not guessed method calls', () => {
  const { g, source } = parse('DATA(ref) = NEW zmissing( ).');
  const [item] = notices(g);
  assert.ok(item); assert.match(item.message, /ZMISSING/); assert.match(item.message, /data or an object/);
  assert.equal(item.line, 2); assert.equal(item.column, 13);
  assert.equal(item.source?.text, source.split('\n')[1]);
  assert.equal(g.unresolvedCalls.length, 0);
  assert.equal(g.edges.filter(e => e.relation === 'calls').length, 0);
});

test('same-line NEW occurrences remain distinct and retain IDs across filters', () => {
  const { g } = parse('DATA(a) = NEW absent( ). DATA(b) = NEW absent( ).');
  const items = notices(g);
  assert.equal(items.length, 2);
  assert.equal(new Set(items.map(diagnosticId)).size, 2);
  assert.deepEqual(items.map(item => item.column), [11, 36]);
  const graph = graphOf(g);
  const compact = queryDiagnostics(graph, { kind: 'unresolved_construction', evidence: false });
  assert.ok(compact.includes(`:L2:${items[0].column}`));
  for (const item of items) assert.ok(queryDiagnostics(graph, { query: diagnosticId(item), evidence: true }).includes(diagnosticId(item)));
});

test('unsupported nested hash contexts are visible without assigning the outer type', () => {
  const { g } = parse(`CLASS holder DEFINITION. PUBLIC SECTION. METHODS constructor IMPORTING child TYPE REF TO object. ENDCLASS.
DATA ref TYPE REF TO holder.
ref = NEW holder( child = NEW #( ) ).`);
  assert.equal(notices(g).length, 1); assert.match(notices(g)[0].message, /NEW #/);
  assert.equal(g.edges.filter(e => e.relation === 'calls').length, 1);
});

test('hash inference that names a missing export type reports that type', () => {
  const { g } = parse('DATA ref TYPE REF TO cl_missing.\nref = NEW #( ).');
  assert.equal(notices(g).length, 1); assert.match(notices(g)[0].message, /CL_MISSING/);
  assert.equal(g.unresolvedCalls.length, 0);
});

test('known classes with no explicit constructor produce no missing-constructor notice', () => {
  const { g } = parse(`CLASS empty DEFINITION. ENDCLASS.
CLASS child DEFINITION INHERITING FROM empty. ENDCLASS.
DATA a TYPE REF TO empty. a = NEW #( ). DATA(b) = NEW child( ).`);
  assert.deepEqual(notices(g), []);
});

test('known incomplete and cyclic constructor ancestry remains visible', () => {
  const { g } = parse(`CLASS child DEFINITION INHERITING FROM missing. ENDCLASS.
CLASS one DEFINITION INHERITING FROM two. ENDCLASS.
CLASS two DEFINITION INHERITING FROM one. ENDCLASS.
DATA(a) = NEW child( ). DATA(b) = NEW one( ).`);
  assert.equal(notices(g).length, 2);
  assert.ok(notices(g).every(item => /constructor ancestry/.test(item.message)));
  assert.equal(g.unresolvedCalls.length, 0);
});

test('an explicit constructor is usable despite an unexported base declaration', () => {
  const { g } = parse('CLASS child DEFINITION INHERITING FROM missing. PUBLIC SECTION. METHODS constructor. ENDCLASS. DATA(a) = NEW child( ).');
  assert.deepEqual(notices(g), []);
  assert.equal(g.edges.filter(e => e.relation === 'calls').length, 1);
});

test('explicit data and locally declared data reference types are not reported as omitted constructors', () => {
  const { g } = parse(`TYPES ty TYPE string. TYPES ref_type TYPE REF TO object.
DATA(a) = NEW i( 5 ). DATA(b) = NEW string( 'x' ). DATA(c) = NEW ty( ). DATA(d) = NEW ref_type( ).
DATA number TYPE REF TO i. number = NEW #( 5 ).
DATA text TYPE REF TO ty. text = NEW #( ).`);
  assert.deepEqual(notices(g), []);
});

test('known inherited data types are distinguished from an unresolved class', () => {
  const { g } = parse(`CLASS base DEFINITION. PUBLIC SECTION. TYPES ty TYPE string. ENDCLASS.
CLASS child DEFINITION INHERITING FROM base. PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD run. DATA(ref) = NEW ty( ). ENDMETHOD. ENDCLASS.`);
  assert.deepEqual(notices(g), []);
});

test('exported DDIC data types do not become constructor diagnostics', () => {
  const extra = new Map([['src/zvalue.dtel.xml', '<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DD04V><ROLLNAME>ZVALUE</ROLLNAME><DATATYPE>CHAR</DATATYPE></DD04V></asx:values></asx:abap></abapGit>']]);
  const { g } = parse('DATA(a) = NEW zvalue( ). DATA ref TYPE REF TO zvalue. ref = NEW #( ).', extra);
  assert.deepEqual(notices(g), []);
});

test('comment and string text does not create a construction diagnostic', () => {
  const { g } = parse('* DATA(ref) = NEW absent( ).\nDATA(text) = `NEW absent( )`.');
  assert.deepEqual(notices(g), []);
});

test('existing diagnostic IDs remain byte-identical without occurrence columns', () => {
  const item = { path, line: 2, kind: 'unsupported_statement', message: 'old message' };
  const old = 'diagnostic:' + createHash('sha256').update(JSON.stringify([path, 2, item.kind, item.message])).digest('hex').slice(0, 16);
  assert.equal(diagnosticId(item), old);
});

test('construction positions are independently validated against the original NEW token', () => {
  const { g, source } = parse('DATA(a) = NEW absent( ).');
  assert.equal(notices(g).length, 1);
  const graph = graphOf(g);
  assert.deepEqual(verifyDiagnosticEvidence(graph, () => source).invalid, []);
  notices(g)[0].column!++;
  assert.ok(verifyDiagnosticEvidence(graph, () => source).invalid.some((item: { reason: string }) => /position/.test(item.reason)));
});

test('AST reuse and MCP refresh replace a construction notice when its class arrives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-construction-notice-'));
  const source = 'REPORT zconstruct.\nDATA(ref) = NEW zcl_leaf( ).';
  const targetPath = 'src/zcl_leaf.clas.abap';
  const definitions = 'CLASS zcl_leaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS constructor. ENDCLASS. CLASS zcl_leaf IMPLEMENTATION. METHOD constructor. ENDMETHOD. ENDCLASS.';
  const sources = new Map([[path, source]]), session = new AbapParseSession();
  assert.equal(notices(extractAbapFiles(sources, session)).length, 1);
  sources.set(targetPath, definitions);
  const incremental = extractAbapFiles(sources, session);
  assert.ok(session.stats.reusedFiles >= 1, 'unchanged caller syntax is reused');
  assert.deepEqual(incremental, extractAbapFiles(sources));
  try {
    mkdirSync(join(root, 'src')); writeFileSync(join(root, path), source); await buildGraph(root);
    const old = await callTool(root, 'graft_diagnostics', { kind: 'unresolved_construction', evidence: true });
    assert.equal(old.isError, false); assert.match(old.text, /1 matched/);
    const compact = await callTool(root, 'graft_trace_calls', { symbol: 'ZCONSTRUCT', direction: 'out', evidence: false });
    assert.equal(compact.isError, false); assert.match(compact.text, /unresolved_construction/);
    assert.doesNotMatch(compact.text, /Recorded source line|Stable evidence ID/);
    const revision = /^\[Inventory\] revision: (inventory:[a-f0-9]+)$/m.exec(old.text)![1];
    writeFileSync(join(root, targetPath), definitions);
    const changed = await callTool(root, 'graft_diagnostics', { kind: 'unresolved_construction', revision });
    assert.equal(changed.isError, true); assert.match(changed.text, /Inventory changed/);
    const fresh = await callTool(root, 'graft_diagnostics', { kind: 'unresolved_construction' });
    assert.equal(fresh.isError, false); assert.match(fresh.text, /0 matched/);
    const trace = await callTool(root, 'graft_trace_calls', { symbol: 'ZCL_LEAF=>CONSTRUCTOR', direction: 'in' });
    assert.equal(trace.isError, false); assert.match(trace.text, /ZCONSTRUCT/);
    assert.equal(readFileSync(join(root, path), 'utf8'), source);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
