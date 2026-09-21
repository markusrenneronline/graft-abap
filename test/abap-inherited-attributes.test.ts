import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAbapFiles, type AbapExtraction } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';
import { callSiteExcerpts, validExcerpt } from '../pilot/evaluate-evidence.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph } from '../src/graph/build.js';
import { callTool } from '../src/mcp/tools.js';

const leaf = 'CLASS leaf DEFINITION. PUBLIC SECTION. METHODS ping IMPORTING value TYPE string OPTIONAL. METHODS constructor. ENDCLASS.';
const parse = (body: string) => {
  const source = `REPORT zinherit.\n${leaf}\n${body}`;
  const result = extractAbapFiles(new Map([['src/zinherit.prog.abap', source]]));
  assert.deepEqual(result.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  return { result, source };
};
const calls = (g: AbapExtraction, name: string) => g.edges.filter(e => e.relation === 'calls' && g.nodes.find(n => n.id === e.target)?.name === name).flatMap(e => e.callSites ?? []);

test('inherited public/protected references support bare, ME, classic and constructor uses', () => {
  for (const section of ['PUBLIC', 'PROTECTED']) {
    const { result } = parse(`CLASS parent DEFINITION. ${section} SECTION. DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD run.
ref->ping( value = 'bare' ). CALL METHOD me->ref->ping EXPORTING value = 'me'.
CREATE OBJECT ref. CREATE OBJECT me->ref. ref = NEW #( ). me->ref = NEW #( ). ENDMETHOD. ENDCLASS.`);
    assert.deepEqual(calls(result, 'PING').map(s => s.arguments), [{ VALUE: "'bare'" }, { VALUE: "'me'" }]);
    assert.equal(calls(result, 'CONSTRUCTOR').length, 4, section);
    assert.ok(calls(result, 'PING').every(s => s.receiverType?.basis === 'inherited_attribute'));
    assert.equal(result.unresolvedCalls.length, 0);
  }
});

test('inherited public CLASS-DATA supports qualified calls and construction outside the hierarchy', () => {
  const { result } = parse(`CLASS parent DEFINITION. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS middle DEFINITION INHERITING FROM parent. ENDCLASS.
CLASS child DEFINITION INHERITING FROM middle. ENDCLASS.
child=>ref->ping( ). CALL METHOD child=>ref->ping. CREATE OBJECT child=>ref. child=>ref = NEW #( ).`);
  assert.equal(calls(result, 'PING').length, 2);
  assert.equal(calls(result, 'CONSTRUCTOR').length, 2);
  assert.equal(calls(result, 'PING')[0].receiverType?.via?.length, 3);
});

test('local unknown variables mask inherited attributes but explicit ME remains independent', () => {
  const { result } = parse(`CLASS parent DEFINITION. PROTECTED SECTION. DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. PUBLIC SECTION. METHODS run IMPORTING ref TYPE REF TO object. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD run. ref->ping( ). me->ref->ping( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(calls(result, 'PING').length, 1);
  assert.equal(result.unresolvedCalls.length, 1);
});

test('an inherited attribute takes precedence over a program global of the same name', () => {
  const { result } = parse(`DATA ref TYPE REF TO object.
CLASS parent DEFINITION. PROTECTED SECTION. DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD run. ref->ping( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(calls(result, 'PING').length, 1);
  assert.match(calls(result, 'PING')[0].receiverType!.source.text, /DATA ref TYPE REF TO leaf/);
});

test('an inherited generic attribute masks a typed program global', () => {
  const { result } = parse(`DATA ref TYPE REF TO leaf.
CLASS parent DEFINITION. PROTECTED SECTION. DATA ref TYPE REF TO object. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD run. ref->ping( ). me->ref->ping( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(calls(result, 'PING').length, 0);
  assert.equal(result.unresolvedCalls.length, 2);
});

test('private attributes stay in the declaring class; unrelated access to protected CLASS-DATA stays open', () => {
  const { result } = parse(`CLASS parent DEFINITION. PUBLIC SECTION. METHODS run. PROTECTED SECTION. CLASS-DATA shared TYPE REF TO leaf.
PRIVATE SECTION. DATA secret TYPE REF TO leaf. ENDCLASS.
CLASS parent IMPLEMENTATION. METHOD run. secret->ping( ). ENDMETHOD. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. PUBLIC SECTION. METHODS child_run. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD child_run. secret->ping( ). me->secret->ping( ). parent=>shared->ping( ). child=>shared->ping( ). ENDMETHOD. ENDCLASS.
parent=>shared->ping( ). child=>shared->ping( ).`);
  assert.equal(calls(result, 'PING').length, 3);
  assert.equal(result.unresolvedCalls.length, 4);
});

test('each class keeps its own same-named private reference without retyping base methods', () => {
  const { result } = parse(`CLASS other DEFINITION. PUBLIC SECTION. METHODS ping. ENDCLASS.
CLASS parent DEFINITION. PUBLIC SECTION. METHODS base_run. PRIVATE SECTION. DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. PUBLIC SECTION. METHODS child_run. PRIVATE SECTION. DATA ref TYPE REF TO other. ENDCLASS.
CLASS parent IMPLEMENTATION. METHOD base_run. ref->ping( ). ENDMETHOD. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD child_run. ref->ping( ). ENDMETHOD. ENDCLASS.`);
  const targets = Object.fromEntries(result.edges.filter(e => e.relation === 'calls').map(e => [
    result.nodes.find(n => n.id === e.source)?.name, result.nodes.find(n => n.id === e.target)?.owner,
  ]));
  assert.deepEqual(targets, { BASE_RUN: 'LEAF', CHILD_RUN: 'OTHER' });
});

test('inherited instance DATA cannot be used with a class selector', () => {
  const { result } = parse(`CLASS parent DEFINITION. PUBLIC SECTION. DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. ENDCLASS.
child=>ref->ping( ). CREATE OBJECT child=>ref. child=>ref = NEW #( ).`);
  assert.equal(calls(result, 'PING').length, 0);
  assert.equal(calls(result, 'CONSTRUCTOR').length, 0);
  assert.equal(result.unresolvedCalls.length, 2);
});

test('an invisible private base attribute does not hide a program variable from the child', () => {
  for (const type of ['leaf', 'object']) {
    const { result } = parse(`DATA ref TYPE REF TO leaf.
CLASS parent DEFINITION. PRIVATE SECTION. DATA ref TYPE REF TO ${type}. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD run. ref->ping( ). me->ref->ping( ). ENDMETHOD. ENDCLASS.`);
    assert.equal(calls(result, 'PING').length, 1);
    assert.equal(calls(result, 'PING')[0].receiverType?.basis, 'declaration');
    assert.equal(result.unresolvedCalls.length, 1);
  }
});

test('protected static access from a sibling carries both declaration paths', () => {
  const { result } = parse(`CLASS parent DEFINITION. PROTECTED SECTION. CLASS-DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS sibling DEFINITION INHERITING FROM parent. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD run. sibling=>ref->ping( ). ENDMETHOD. ENDCLASS.`);
  const proof = calls(result, 'PING')[0]?.receiverType;
  assert.equal(proof?.basis, 'inherited_attribute');
  assert.equal(proof?.via?.length, 3);
  for (const name of ['parent', 'child', 'sibling']) assert.ok(proof?.via?.some(e => e.text.startsWith(`CLASS ${name} DEFINITION`)));
});

test('missing, ambiguous and cyclic ancestry never borrows a same-named program global', () => {
  for (const header of ['CLASS child DEFINITION INHERITING FROM absent. PUBLIC SECTION. METHODS run. ENDCLASS.',
    'CLASS child DEFINITION INHERITING FROM child. PUBLIC SECTION. METHODS run. ENDCLASS.',
    'CLASS parent DEFINITION. ENDCLASS. CLASS parent DEFINITION. ENDCLASS. CLASS child DEFINITION INHERITING FROM parent. PUBLIC SECTION. METHODS run. ENDCLASS.']) {
    const { result } = parse(`DATA ref TYPE REF TO leaf. ${header}
CLASS child IMPLEMENTATION. METHOD run. ref->ping( ). me->ref->ping( ). ENDMETHOD. ENDCLASS.`);
    assert.equal(calls(result, 'PING').length, 0);
    assert.equal(result.unresolvedCalls.length, 2);
  }
});

test('the attribute type is resolved at its base declaration despite child-local types and classes', () => {
  const result = extractAbapFiles(new Map([
    ['src/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS.'],
    ['src/zparent.clas.abap', 'CLASS zparent DEFINITION PUBLIC. PROTECTED SECTION. DATA ref TYPE REF TO zleaf. ENDCLASS.'],
    ['src/zinherit.prog.abap', `REPORT zinherit. CLASS zleaf DEFINITION. PUBLIC SECTION. METHODS ping. ENDCLASS.
CLASS child DEFINITION INHERITING FROM zparent. PUBLIC SECTION. METHODS run. PRIVATE SECTION. TYPES zleaf TYPE i. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD run. ref->ping( ). me->ref->ping( ). ENDMETHOD. ENDCLASS.`],
  ]));
  const edges = result.edges.filter(e => e.relation === 'calls');
  assert.equal(edges.length, 1);
  assert.equal(result.nodes.find(n => n.id === edges[0].target)?.path, 'src/zleaf.clas.abap');
  assert.equal(edges[0].callSites?.length, 2);
  assert.ok(edges[0].callSites?.every(s => s.receiverType?.source.path === 'src/zparent.clas.abap'));
});

test('inherited type and ancestry excerpts are original and independently validated, including NEW #', () => {
  const { result, source } = parse(`CLASS parent DEFINITION. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. ENDCLASS.
child=>ref->ping( ). child=>ref = NEW #( ).`);
  const site = structuredClone(calls(result, 'PING')[0]);
  assert.equal(site.receiverType?.via?.length, 2);
  assert.ok(callSiteExcerpts(site).every(e => validExcerpt(e, source)));
  site.receiverType!.via![0].span = 'L1-L1';
  assert.equal(callSiteExcerpts(site).every(e => validExcerpt(e, source)), false);
  const constructor = calls(result, 'CONSTRUCTOR')[0];
  assert.equal(constructor.construction?.inferredType?.via?.length, 2);
  assert.ok(callSiteExcerpts(constructor).every(e => validExcerpt(e, source)));
});

test('a formerly unknown external inherited receiver retains its occurrence identity', () => {
  const source = `REPORT zinherit. CLASS parent DEFINITION. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO absent. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD run. ref->ping( ). me->ref->ping( ). child=>ref->ping( ). ENDMETHOD. ENDCLASS.`;
  const missing = extractAbapFiles(new Map([['src/zinherit.prog.abap', source.replace('CLASS-DATA ref TYPE REF TO absent.', '')]]));
  const typed = extractAbapFiles(new Map([['src/zinherit.prog.abap', source]]));
  assert.deepEqual(typed.unresolvedCalls.map(r => r.id), missing.unresolvedCalls.map(r => r.id));
  assert.ok(typed.unresolvedCalls.every(r => r.reason === 'missing_target' && r.site.receiverType?.name === 'ABSENT'));
});

test('inherited CREATE OBJECT with a missing class preserves its original target and identity', () => {
  const source = `REPORT zinherit. CLASS parent DEFINITION. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO absent. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD run. CREATE OBJECT ref. CREATE OBJECT me->ref. CREATE OBJECT child=>ref. ENDMETHOD. ENDCLASS.`;
  const missing = extractAbapFiles(new Map([['src/zinherit.prog.abap', source.replace('CLASS-DATA ref TYPE REF TO absent.', '')]]));
  const typed = extractAbapFiles(new Map([['src/zinherit.prog.abap', source]]));
  assert.equal(typed.unresolvedCalls.length, 3);
  assert.deepEqual(typed.unresolvedCalls.map(r => r.id), missing.unresolvedCalls.map(r => r.id));
  assert.deepEqual(typed.unresolvedCalls.map(r => r.targetName), missing.unresolvedCalls.map(r => r.targetName));
  assert.ok(typed.unresolvedCalls.every(r => r.reason === 'missing_target' && r.site.receiverType?.name === 'ABSENT'));
});

test('changing only a base attribute removes stale edges under AST reuse', () => {
  const input = new Map([
    ['src/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS.'],
    ['src/zparent.clas.abap', 'CLASS zparent DEFINITION PUBLIC. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO zleaf. ENDCLASS.'],
    ['src/zinherit.prog.abap', 'REPORT zinherit. CLASS child DEFINITION INHERITING FROM zparent. ENDCLASS. child=>ref->ping( ).'],
  ]);
  const session = new AbapParseSession();
  assert.equal(calls(extractAbapFiles(input, session), 'PING').length, 1);
  input.set('src/zparent.clas.abap', input.get('src/zparent.clas.abap')!.replace('PUBLIC SECTION', 'PRIVATE SECTION'));
  const updated = extractAbapFiles(input, session);
  assert.deepEqual(updated, extractAbapFiles(input));
  assert.equal(calls(updated, 'PING').length, 0);
  assert.equal(updated.unresolvedCalls.length, 1);
});

test('persisted MCP shows inherited declaration and hierarchy and refreshes base-only changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-inherited-attributes-'));
  try {
    mkdirSync(join(root, 'src'));
    const source = join(root, 'src/zinherit.prog.abap');
    const code = `REPORT zinherit.\n${leaf}\nCLASS parent DEFINITION. PUBLIC SECTION. CLASS-DATA ref TYPE REF TO leaf. ENDCLASS.
CLASS child DEFINITION INHERITING FROM parent. ENDCLASS.
child=>ref->ping( ). child=>ref->missing( ).`;
    writeFileSync(source, code);
    await buildGraph(root);
    const full = await callTool(root, 'graft_trace_calls', { symbol: 'PING', direction: 'in' });
    assert.equal(full.isError, false, full.text);
    assert.match(full.text, /Reference declaration/);
    assert.match(full.text, /Attribute inheritance/);
    assert.match(full.text, /CLASS child DEFINITION INHERITING FROM parent/);
    const compact = await callTool(root, 'graft_trace_calls', { symbol: 'PING', direction: 'in', evidence: false });
    assert.doesNotMatch(compact.text, /Reference declaration|Attribute inheritance/);
    const open = await callTool(root, 'graft_unresolved_calls', { query: 'MISSING', evidence: true });
    assert.equal(open.isError, false, open.text);
    assert.match(open.text, /Attribute inheritance/);
    const revision = open.text.match(/inventory:[a-f0-9]{64}/)?.[0];
    assert.ok(revision);
    writeFileSync(source, code.replace('CLASS-DATA ref TYPE REF TO leaf', 'CLASS-DATA ref TYPE REF TO object'));
    const trace = await callTool(root, 'graft_trace_calls', { symbol: 'PING', direction: 'in' });
    assert.equal(trace.isError, false, trace.text);
    assert.match(trace.text, /no indexed callers/);
    const old = await callTool(root, 'graft_unresolved_calls', { revision, offset: 1 });
    assert.equal(old.isError, true);
    assert.match(old.text, /Inventory changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
