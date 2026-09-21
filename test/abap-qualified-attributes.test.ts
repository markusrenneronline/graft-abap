import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAbapFiles, type AbapExtraction } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';
import { contentHash } from '../src/util/id.js';
import { callSiteExcerpts, validExcerpt } from '../pilot/evaluate-evidence.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph } from '../src/graph/build.js';
import { callTool } from '../src/mcp/tools.js';

const leaf = `CLASS leaf DEFINITION. PUBLIC SECTION. METHODS constructor IMPORTING value TYPE string OPTIONAL.
METHODS ping IMPORTING value TYPE string OPTIONAL. METHODS next RETURNING VALUE(r) TYPE REF TO leaf. ENDCLASS.`;
const parse = (body: string) => {
  const source = `REPORT zattrs.\n${leaf}\n${body}`;
  const result = extractAbapFiles(new Map([['src/zattrs.prog.abap', source]]));
  assert.deepEqual(result.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  return { result, source };
};
const calls = (g: AbapExtraction, name: string) => g.edges.filter(e => e.relation === 'calls' && g.nodes.find(n => n.id === e.target)?.name === name).flatMap(e => e.callSites ?? []);

test('ME attribute calls bypass same-name local variables and retain each invocation actuals', () => {
  const { result } = parse(`CLASS caller DEFINITION. PUBLIC SECTION. METHODS run. PRIVATE SECTION. DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. DATA ref TYPE REF TO object.
me->ref->ping( value = 'one' ). CALL METHOD me->ref->ping EXPORTING value = 'two'. ENDMETHOD. ENDCLASS.`);
  assert.deepEqual(calls(result, 'PING').map(s => s.arguments), [{ VALUE: "'one'" }, { VALUE: "'two'" }]);
  assert.ok(calls(result, 'PING').every(s => s.receiverType?.basis === 'declaration'));
  assert.equal(result.unresolvedCalls.length, 0);
});

test('public CLASS-DATA receivers support functional/classic calls and both construction forms', () => {
  const { result } = parse(`CLASS holder DEFINITION. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO leaf. ENDCLASS.
holder=>ref->ping( value = 'functional' ). CALL METHOD holder=>ref->ping EXPORTING value = 'classic'.
CREATE OBJECT holder=>ref EXPORTING value = 'create'. holder=>ref = NEW #( value = 'new' ).`);
  assert.equal(calls(result, 'PING').length, 2);
  assert.deepEqual(calls(result, 'CONSTRUCTOR').map(s => s.arguments), [{ VALUE: "'create'" }, { VALUE: "'new'" }]);
  assert.equal(result.unresolvedCalls.length, 0);
});

test('qualified attribute method return continues through the established RETURNING resolver', () => {
  const { result } = parse(`CLASS holder DEFINITION. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO leaf. ENDCLASS.
holder=>ref->next( )->ping( value = 'after' ).`);
  assert.equal(calls(result, 'NEXT').length, 1);
  assert.equal(calls(result, 'PING').length, 1);
  assert.deepEqual(calls(result, 'PING')[0].arguments, { VALUE: "'after'" });
  assert.match(calls(result, 'PING')[0].receiverType?.source.text ?? '', /RETURNING VALUE/);
});

test('class selector never borrows an instance attribute or a method parameter', () => {
  const { result } = parse(`CLASS holder DEFINITION. PUBLIC SECTION. DATA ref TYPE REF TO leaf.
METHODS run IMPORTING argument TYPE REF TO leaf. ENDCLASS.
holder=>ref->ping( ). holder=>argument->ping( ). CREATE OBJECT holder=>ref.`);
  assert.equal(calls(result, 'PING').length, 0);
  assert.equal(calls(result, 'CONSTRUCTOR').length, 0);
  assert.equal(result.unresolvedCalls.length, 3);
});

test('nonpublic static attributes are resolved only inside their declaring class', () => {
  for (const visibility of ['PRIVATE', 'PROTECTED']) {
    const { result } = parse(`CLASS holder DEFINITION. PUBLIC SECTION. CLASS-METHODS run.
${visibility} SECTION. CLASS-DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS holder IMPLEMENTATION. METHOD run. holder=>ref->ping( ). ENDMETHOD. ENDCLASS.
holder=>ref->ping( ).`);
    assert.equal(calls(result, 'PING').length, 1, visibility);
    assert.equal(result.unresolvedCalls.length, 1, visibility);
  }
});

test('unknown attributes, arbitrary object chains and dynamic access stay open; inherited attributes resolve', () => {
  const { result } = parse(`CLASS holder DEFINITION. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS child DEFINITION INHERITING FROM holder. ENDCLASS.
DATA obj TYPE REF TO holder. DATA name TYPE string.
holder=>missing->ping( ). obj->ref->ping( ). child=>ref->ping( ). CALL METHOD holder=>(name)->ping.`);
  assert.equal(calls(result, 'PING').length, 1);
  assert.equal(calls(result, 'PING')[0].receiverType?.basis, 'inherited_attribute');
  assert.equal(result.unresolvedCalls.length, 3);
  assert.equal(result.unresolvedCalls.filter(r => r.reason === 'dynamic_target').length, 1);
});

test('generic and data reference attributes never borrow the unique method by name', () => {
  const { result } = parse(`CLASS holder DEFINITION. PUBLIC SECTION. TYPES leaf TYPE i.
CLASS-DATA generic TYPE REF TO object. CLASS-DATA dataref TYPE REF TO leaf. ENDCLASS.
holder=>generic->ping( ). holder=>dataref->ping( ).`);
  assert.equal(calls(result, 'PING').length, 0);
  assert.equal(result.unresolvedCalls.length, 2);
});

test('external qualified attribute preserves the expression occurrence identity and proves its type', () => {
  const { result, source } = parse(`CLASS holder DEFINITION. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO external. ENDCLASS.
holder=>ref->ping( ).`);
  const ref = result.unresolvedCalls[0];
  assert.equal(ref.reason, 'missing_target');
  assert.equal(ref.targetName, 'holder=>ref->PING');
  assert.equal(ref.site.receiverType?.name, 'EXTERNAL');
  assert.match(ref.site.receiverType!.source.text, /CLASS-DATA ref TYPE REF TO external/);
  assert.ok(callSiteExcerpts(ref.site).every(e => validExcerpt(e, source)));
  const position = (row: number, col: number) => `${String(row).padStart(10, '0')}:${String(col).padStart(10, '0')}`;
  const at = ref.site.occurrence!;
  const row = Number(ref.site.span.match(/\d+/)![0]);
  const key = `src/zattrs.prog.abap\0${position(row, 1)}\0${position(at.line, at.column)}`;
  assert.equal(ref.id, `unresolved:${contentHash(`${key}\0method\0holder=>ref->PING`).slice(0, 16)}`);
});

test('qualified attribute resolves its declared class in the declaration namespace', () => {
  const result = extractAbapFiles(new Map([
    ['src/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS.'],
    ['src/zholder.clas.abap', 'CLASS zholder DEFINITION PUBLIC. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO zleaf. ENDCLASS.'],
    ['src/zattrs.prog.abap', 'REPORT zattrs. CLASS zleaf DEFINITION. PUBLIC SECTION. METHODS ping. ENDCLASS. zholder=>ref->ping( ).'],
  ]));
  const edge = result.edges.find(e => e.relation === 'calls');
  assert.equal(result.nodes.find(n => n.id === edge?.target)?.path, 'src/zleaf.clas.abap');
  assert.equal(edge?.callSites?.[0].receiverType?.source.path, 'src/zholder.clas.abap');
});

test('attribute declaration changes invalidate unchanged callers under AST reuse', () => {
  const input = new Map([
    ['src/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS.'],
    ['src/zholder.clas.abap', 'CLASS zholder DEFINITION PUBLIC. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO zleaf. ENDCLASS.'],
    ['src/zattrs.prog.abap', 'REPORT zattrs. zholder=>ref->ping( ).'],
  ]);
  const session = new AbapParseSession();
  assert.equal(calls(extractAbapFiles(input, session), 'PING').length, 1);
  input.set('src/zholder.clas.abap', input.get('src/zholder.clas.abap')!.replace('REF TO zleaf', 'REF TO object'));
  const updated = extractAbapFiles(input, session);
  assert.deepEqual(updated, extractAbapFiles(input));
  assert.equal(calls(updated, 'PING').length, 0);
  assert.equal(updated.unresolvedCalls.length, 1);
});

test('duplicate qualified owners cannot borrow either attribute declaration', () => {
  const holder = 'CLASS zholder DEFINITION PUBLIC. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO zleaf. ENDCLASS.';
  const result = extractAbapFiles(new Map([
    ['src/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS.'],
    ['src/a/zholder.clas.abap', holder], ['src/b/zholder.clas.abap', holder],
    ['src/zattrs.prog.abap', 'REPORT zattrs. zholder=>ref->ping( ).'],
  ]));
  assert.equal(calls(result, 'PING').length, 0);
  assert.equal(result.unresolvedCalls.length, 1);
});

test('MCP retains qualified declaration evidence and refreshes when its missing target arrives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-qualified-attributes-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/zholder.clas.abap'), 'CLASS zholder DEFINITION PUBLIC. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO zleaf. ENDCLASS. CLASS zholder IMPLEMENTATION. ENDCLASS.');
    writeFileSync(join(root, 'src/zattrs.prog.abap'), 'REPORT zattrs. zholder=>ref->ping( ).');
    await buildGraph(root);
    const open = await callTool(root, 'graft_unresolved_calls', { query: 'PING', evidence: true });
    assert.equal(open.isError, false, open.text);
    assert.match(open.text, /missing_target/);
    assert.match(open.text, /Reference declaration/);
    assert.match(open.text, /CLASS-DATA ref TYPE REF TO zleaf/);
    const revision = open.text.match(/inventory:[a-f0-9]{64}/)?.[0];
    assert.ok(revision);
    writeFileSync(join(root, 'src/zleaf.clas.abap'), 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS. CLASS zleaf IMPLEMENTATION. METHOD ping. ENDMETHOD. ENDCLASS.');
    const trace = await callTool(root, 'graft_trace_calls', { symbol: 'ZLEAF=>PING', direction: 'in' });
    assert.equal(trace.isError, false, trace.text);
    assert.match(trace.text, /Reference declaration/);
    assert.match(trace.text, /CLASS-DATA ref TYPE REF TO zleaf/);
    const compact = await callTool(root, 'graft_trace_calls', { symbol: 'ZLEAF=>PING', direction: 'in', evidence: false });
    assert.equal(compact.isError, false, compact.text);
    assert.doesNotMatch(compact.text, /Reference declaration|CLASS-DATA/);
    const oldPage = await callTool(root, 'graft_unresolved_calls', { revision, offset: 1 });
    assert.equal(oldPage.isError, true, oldPage.text);
    assert.match(oldPage.text, /revision/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
