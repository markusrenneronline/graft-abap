import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAbapFiles, type AbapExtraction } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph } from '../src/graph/build.js';
import { callTool } from '../src/mcp/tools.js';
import { callSiteExcerpts, validExcerpt } from '../pilot/evaluate-evidence.mjs';

const leaf = 'CLASS leaf DEFINITION. PUBLIC SECTION. METHODS constructor. METHODS ping. ENDCLASS.';
const parse = (body: string) => {
  const source = `REPORT zscope.\n${leaf}\n${body}`;
  const result = extractAbapFiles(new Map([['src/zscope.prog.abap', source]]));
  assert.deepEqual(result.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  return { result, source };
};
const calls = (g: AbapExtraction, name: string) => g.edges.filter(e => e.relation === 'calls' && g.nodes.find(n => n.id === e.target)?.name === name).flatMap(e => e.callSites ?? []);

test('attribute reference type belongs to its declaration, not a method-local TYPES name', () => {
  const { result } = parse(`CLASS caller DEFINITION. PUBLIC SECTION. DATA ref TYPE REF TO leaf. METHODS run. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. TYPES leaf TYPE i.
ref->ping( ). CALL METHOD ref->ping. CREATE OBJECT ref. CREATE OBJECT me->ref. ref = NEW #( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(calls(result, 'PING').length, 2);
  assert.equal(calls(result, 'CONSTRUCTOR').length, 3);
  assert.equal(result.unresolvedCalls.length, 0);
});

test('formal parameter reference type is resolved in the method signature scope', () => {
  const { result } = parse(`CLASS caller DEFINITION. PUBLIC SECTION. METHODS run CHANGING ref TYPE REF TO leaf. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. TYPES leaf TYPE string.
ref->ping( ). CREATE OBJECT ref. ref = NEW #( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(calls(result, 'PING').length, 1);
  assert.equal(calls(result, 'CONSTRUCTOR').length, 2);
});

test('program reference keeps its type across a class-local type shadow', () => {
  const { result } = parse(`DATA ref TYPE REF TO leaf.
CLASS caller DEFINITION. PUBLIC SECTION. TYPES leaf TYPE string. METHODS run. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. ref->ping( ). CREATE OBJECT ref. ref = NEW #( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(calls(result, 'PING').length, 1);
  assert.equal(calls(result, 'CONSTRUCTOR').length, 2);
});

test('inherited data type cannot be mistaken for a same-named class in a local declaration', () => {
  const { result } = parse(`CLASS parent DEFINITION. PUBLIC SECTION. TYPES leaf TYPE i. ENDCLASS.
CLASS caller DEFINITION INHERITING FROM parent. PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. DATA ref TYPE REF TO leaf.
ref->ping( ). CALL METHOD ref->ping. CREATE OBJECT ref. ref = NEW #( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(calls(result, 'PING').length, 0);
  assert.equal(calls(result, 'CONSTRUCTOR').length, 0);
  assert.equal(result.unresolvedCalls.length, 3);
});

test('unknown base cannot prove absence of a same-named data type', () => {
  const { result } = parse(`CLASS caller DEFINITION INHERITING FROM absent. PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. DATA ref TYPE REF TO leaf. ref->ping( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(calls(result, 'PING').length, 0);
  assert.equal(result.unresolvedCalls[0]?.reason, 'unresolved_receiver');
});

test('unknown local binding still masks an attribute and does not change explicit ME creation', () => {
  const { result } = parse(`CLASS caller DEFINITION. PUBLIC SECTION. DATA ref TYPE REF TO leaf. METHODS run. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD run. DATA ref TYPE REF TO object. TYPES leaf TYPE i.
ref->ping( ). CREATE OBJECT ref. CREATE OBJECT me->ref. ENDMETHOD. ENDCLASS.`);
  assert.equal(calls(result, 'PING').length, 0);
  assert.equal(calls(result, 'CONSTRUCTOR').length, 1);
  assert.equal(result.unresolvedCalls.length, 2);
});

test('reference declaration proof is original source and independently validated', () => {
  const { result, source } = parse(`DATA: number TYPE i, ref TYPE REF TO leaf.
ref->ping( ). CREATE OBJECT ref.`);
  for (const name of ['PING', 'CONSTRUCTOR']) {
    const site = structuredClone(calls(result, name)[0]);
    assert.equal(site.receiverType?.basis, 'declaration');
    assert.match(site.receiverType!.source.text, /ref TYPE REF TO leaf/);
    assert.ok(callSiteExcerpts(site).every(excerpt => validExcerpt(excerpt, source)));
    site.receiverType!.source.span = 'L1-L1';
    assert.equal(callSiteExcerpts(site).every(excerpt => validExcerpt(excerpt, source)), false);
  }
});

test('explicit CREATE OBJECT TYPE uses the invocation namespace independently of target binding', () => {
  const { result } = parse('DATA ref TYPE REF TO object. CREATE OBJECT ref TYPE leaf.');
  assert.equal(calls(result, 'CONSTRUCTOR').length, 1);
  assert.equal(calls(result, 'CONSTRUCTOR')[0].receiverType, undefined);
});

test('AST-declared namespaced reference names remain supported', () => {
  const { result } = parse('DATA /demo/ref TYPE REF TO leaf. /demo/ref->ping( ). CREATE OBJECT /demo/ref. /demo/ref = NEW #( ).');
  assert.equal(calls(result, 'PING').length, 1);
  assert.equal(calls(result, 'CONSTRUCTOR').length, 2);
  assert.equal(result.unresolvedCalls.length, 0);
});

test('declaration changes under reused AST remove stale calls and equal a cold extraction', () => {
  const input = new Map([
    ['src/zleaf.clas.abap', 'CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS.'],
    ['src/zcaller.clas.abap', 'CLASS zcaller DEFINITION PUBLIC. PUBLIC SECTION. DATA ref TYPE REF TO zleaf. METHODS run. ENDCLASS.'],
    ['src/zcaller.clas.locals_imp.abap', 'CLASS zcaller IMPLEMENTATION. METHOD run. TYPES zleaf TYPE i. ref->ping( ). ENDMETHOD. ENDCLASS.'],
  ]);
  const session = new AbapParseSession();
  assert.equal(calls(extractAbapFiles(input, session), 'PING').length, 1);
  input.set('src/zcaller.clas.abap', input.get('src/zcaller.clas.abap')!.replace('REF TO zleaf', 'REF TO object'));
  const updated = extractAbapFiles(input, session);
  assert.deepEqual(updated, extractAbapFiles(input));
  assert.equal(calls(updated, 'PING').length, 0);
  assert.equal(updated.unresolvedCalls.length, 1);
});

test('persisted reference proof reaches trace and unresolved inventory; compact trace omits source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-reference-scope-'));
  try {
    mkdirSync(join(root, 'src'));
    const source = join(root, 'src/zscope.prog.abap');
    writeFileSync(source, `REPORT zscope.\n${leaf}\nDATA ref TYPE REF TO leaf.\nref->ping( ). ref->absent( ).`);
    await buildGraph(root);
    const full = await callTool(root, 'graft_trace_calls', { symbol: 'PING', direction: 'in' });
    assert.equal(full.isError, false, full.text);
    assert.match(full.text, /Reference declaration/);
    assert.match(full.text, /reference declaration; runtime subtype not inferred/);
    assert.match(full.text, /DATA ref TYPE REF TO leaf/);
    const compact = await callTool(root, 'graft_trace_calls', { symbol: 'PING', direction: 'in', evidence: false });
    assert.equal(compact.isError, false, compact.text);
    assert.doesNotMatch(compact.text, /Reference declaration|DATA ref TYPE/);
    const unresolved = await callTool(root, 'graft_unresolved_calls', { query: 'ABSENT', evidence: true });
    assert.equal(unresolved.isError, false, unresolved.text);
    assert.match(unresolved.text, /Reference declaration/);
    assert.match(unresolved.text, /DATA ref TYPE REF TO leaf/);
    writeFileSync(source, `REPORT zscope.\n${leaf}\nDATA ref TYPE REF TO object.\nref->ping( ).`);
    const refreshed = await callTool(root, 'graft_trace_calls', { symbol: 'PING', direction: 'in' });
    assert.equal(refreshed.isError, false, refreshed.text);
    assert.match(refreshed.text, /no indexed callers/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
