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

const rootClass = `CLASS cx_root DEFINITION. PUBLIC SECTION. METHODS constructor.
METHODS ping IMPORTING value TYPE string OPTIONAL. ENDCLASS.
CLASS cx_root IMPLEMENTATION. METHOD constructor. ENDMETHOD. METHOD ping. ENDMETHOD. ENDCLASS.`;
const hierarchy = `${rootClass}
CLASS cx_common DEFINITION INHERITING FROM cx_root. ENDCLASS.
CLASS cx_a DEFINITION INHERITING FROM cx_common. ENDCLASS.
CLASS cx_b DEFINITION INHERITING FROM cx_common. ENDCLASS.`;
const parse = (body: string) => {
  const source = `REPORT zcatch.\n${body}`;
  const result = extractAbapFiles(new Map([['src/zcatch.prog.abap', source]]));
  assert.deepEqual(result.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  return { result, source };
};
const calls = (g: AbapExtraction, name: string) => g.edges.filter(e => e.relation === 'calls' && g.nodes.find(n => n.id === e.target)?.name === name).flatMap(e => e.callSites ?? []);

test('single inline CATCH declares the receiver type and preserves functional/classic actuals', () => {
  const { result } = parse(`${rootClass} TRY. CATCH cx_root INTO DATA(err).
err->ping( value = 'functional' ). CALL METHOD err->ping EXPORTING value = 'classic'. ENDTRY.`);
  assert.deepEqual(calls(result, 'PING').map(s => s.arguments), [{ VALUE: "'functional'" }, { VALUE: "'classic'" }]);
  assert.ok(calls(result, 'PING').every(s => s.receiverType?.basis === 'inline_catch'));
  assert.equal(result.unresolvedCalls.length, 0);
});

test('external single CATCH retains the original variable target and explains the missing class', () => {
  const { result } = parse('TRY. CATCH cx_root INTO DATA(err). err->get_text( ). ENDTRY.');
  const ref = result.unresolvedCalls[0];
  assert.equal(ref.targetName, 'ERR->GET_TEXT');
  assert.equal(ref.reason, 'missing_target');
  assert.equal(ref.site.receiverType?.name, 'CX_ROOT');
  assert.match(ref.site.receiverType?.source.text ?? '', /CATCH cx_root INTO DATA\(err\)/);
});

test('BEFORE UNWIND and a call on the same line retain the inline type', () => {
  const { result } = parse(`${rootClass} TRY. CATCH BEFORE UNWIND cx_root INTO DATA(err). err->ping( ). ENDTRY.`);
  assert.equal(calls(result, 'PING').length, 1);
  assert.match(calls(result, 'PING')[0].receiverType?.source.text ?? '', /BEFORE UNWIND/);
});

test('CATCH into an existing generic reference never narrows its static type', () => {
  const { result } = parse(`${rootClass} DATA err TYPE REF TO object. TRY. CATCH cx_root INTO err. err->ping( ). ENDTRY.`);
  assert.equal(calls(result, 'PING').length, 0);
  assert.equal(result.unresolvedCalls[0].reason, 'unresolved_receiver');
  assert.equal(result.unresolvedCalls[0].site.receiverType, undefined);
});

test('multiple CATCH classes use the closest exported common superclass with hierarchy proof', () => {
  const { result } = parse(`${hierarchy} TRY. CATCH cx_a cx_b INTO DATA(err). err->ping( ). ENDTRY.`);
  const receiver = calls(result, 'PING')[0]?.receiverType;
  assert.equal(receiver?.name, 'CX_COMMON');
  assert.equal(receiver?.basis, 'inline_catch');
  assert.equal(receiver?.via?.length, 3);
  for (const name of ['cx_a', 'cx_b', 'cx_common']) assert.ok(receiver!.via!.some(s => s.text.includes(`CLASS ${name} DEFINITION`)));
});

test('multiple CATCH classes may explicitly name their common superclass', () => {
  const { result } = parse(`${hierarchy} TRY. CATCH cx_a cx_common INTO DATA(err). err->ping( ). ENDTRY.`);
  assert.equal(calls(result, 'PING')[0]?.receiverType?.name, 'CX_COMMON');
});

test('unknown ancestry cannot be guessed as CX_ROOT just because a same-name method exists', () => {
  const { result } = parse(`${rootClass}
CLASS cx_a DEFINITION INHERITING FROM missing_a. ENDCLASS.
CLASS cx_b DEFINITION INHERITING FROM missing_b. ENDCLASS.
TRY. CATCH cx_a cx_b INTO DATA(err). err->ping( ). ENDTRY.`);
  assert.equal(calls(result, 'PING').length, 0);
  assert.equal(result.unresolvedCalls[0].reason, 'unresolved_receiver');
});

test('a proven common superclass does not require its own missing ancestor to be exported', () => {
  const { result } = parse(`CLASS cx_common DEFINITION INHERITING FROM external_root. PUBLIC SECTION. METHODS ping. ENDCLASS.
CLASS cx_a DEFINITION INHERITING FROM cx_common. ENDCLASS. CLASS cx_b DEFINITION INHERITING FROM cx_common. ENDCLASS.
TRY. CATCH cx_a cx_b INTO DATA(err). err->ping( ). ENDTRY.`);
  assert.equal(calls(result, 'PING')[0]?.receiverType?.name, 'CX_COMMON');
});

test('cyclic ancestry and repeated CATCH class names remain untyped', () => {
  for (const clause of ['cx_a cx_b', 'cx_a cx_a']) {
    const { result } = parse(`CLASS cx_a DEFINITION INHERITING FROM cx_b. PUBLIC SECTION. METHODS ping. ENDCLASS.
CLASS cx_b DEFINITION INHERITING FROM cx_a. ENDCLASS. TRY. CATCH ${clause} INTO DATA(err). err->ping( ). ENDTRY.`);
    assert.equal(calls(result, 'PING').length, 0);
  }
});

test('inline CATCH is available after its declaration, never before it', () => {
  const { result } = parse(`${rootClass} TRY. err->ping( ). CATCH cx_root INTO DATA(err). err->ping( ). ENDTRY. err->ping( ).`);
  assert.equal(calls(result, 'PING').length, 2);
  assert.equal(result.unresolvedCalls.length, 1);
  assert.equal(result.unresolvedCalls[0].site.receiverType, undefined);
});

test('CATCH class operands cannot be mistaken for data type aliases', () => {
  const { result } = parse(`${rootClass} TYPES cx_root TYPE i. TRY. CATCH cx_root INTO DATA(err). err->ping( ). ENDTRY.`);
  assert.equal(calls(result, 'PING').length, 1);
});

test('ambiguous CATCH classes retain type evidence without selecting a target', () => {
  const definition = 'CLASS zcx_error DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS.';
  const result = extractAbapFiles(new Map([
    ['src/a/zcx_error.clas.abap', definition], ['src/b/zcx_error.clas.abap', definition],
    ['src/zcatch.prog.abap', 'REPORT zcatch. TRY. CATCH zcx_error INTO DATA(err). err->ping( ). ENDTRY.'],
  ]));
  assert.equal(calls(result, 'PING').length, 0);
  assert.equal(result.unresolvedCalls[0].reason, 'ambiguous_target');
  assert.equal(result.unresolvedCalls[0].site.receiverType?.name, 'ZCX_ERROR');
});

test('inline CATCH types do not leak across methods and interface operands stay untyped', () => {
  const { result } = parse(`${rootClass}
CLASS caller DEFINITION. PUBLIC SECTION. METHODS first. METHODS second. ENDCLASS.
CLASS caller IMPLEMENTATION. METHOD first. TRY. CATCH cx_root INTO DATA(err). err->ping( ). ENDTRY. ENDMETHOD.
METHOD second. err->ping( ). ENDMETHOD. ENDCLASS.
INTERFACE lif. METHODS ping. ENDINTERFACE. TRY. CATCH lif INTO DATA(other). other->ping( ). ENDTRY.`);
  assert.equal(calls(result, 'PING').length, 1);
  assert.equal(result.unresolvedCalls.length, 2);
  assert.ok(result.unresolvedCalls.every(ref => ref.reason === 'unresolved_receiver'));
});

test('hierarchy evidence is independently checked, including inferred constructor type evidence', () => {
  const { result, source } = parse(`${hierarchy}\nTRY. CATCH cx_a cx_b INTO DATA(err).\nerr->ping( ). err = NEW #( ). ENDTRY.`);
  for (const name of ['PING', 'CONSTRUCTOR']) {
    const site = structuredClone(calls(result, name)[0]);
    assert.ok(site);
    const via = site.receiverType?.via ?? site.construction?.inferredType?.via;
    assert.equal(via?.length, 3);
    assert.ok(callSiteExcerpts(site).every(e => validExcerpt(e, source)));
    via![0].span = 'L1-L1';
    assert.equal(callSiteExcerpts(site).every(e => validExcerpt(e, source)), false);
  }
});

test('changed CATCH ancestry relinks reused caller ASTs like a cold analysis', () => {
  const input = new Map([
    ['src/zcx_base.clas.abap', 'CLASS zcx_base DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS.'],
    ['src/zcx_a.clas.abap', 'CLASS zcx_a DEFINITION PUBLIC INHERITING FROM zcx_base. ENDCLASS.'],
    ['src/zcx_b.clas.abap', 'CLASS zcx_b DEFINITION PUBLIC INHERITING FROM zcx_base. ENDCLASS.'],
    ['src/zcatch.prog.abap', 'REPORT zcatch. TRY. CATCH zcx_a zcx_b INTO DATA(err). err->ping( ). ENDTRY.'],
  ]);
  const session = new AbapParseSession();
  assert.equal(calls(extractAbapFiles(input, session), 'PING').length, 1);
  input.set('src/zcx_b.clas.abap', input.get('src/zcx_b.clas.abap')!.replace('zcx_base', 'missing'));
  const updated = extractAbapFiles(input, session);
  assert.deepEqual(updated, extractAbapFiles(input));
  assert.equal(calls(updated, 'PING').length, 0);
});

test('CATCH and hierarchy evidence persist in MCP trace and open-reference inventory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'graft-catch-'));
  try {
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'src/zcatch.prog.abap'), `REPORT zcatch.\n${hierarchy}\nTRY. CATCH cx_a cx_b INTO DATA(err). err->ping( ). err->absent( ). ENDTRY.`);
    await buildGraph(directory);
    const trace = await callTool(directory, 'graft_trace_calls', { symbol: 'CX_ROOT=>PING', direction: 'in' });
    assert.equal(trace.isError, false, trace.text);
    assert.match(trace.text, /CATCH declaration/);
    assert.match(trace.text, /Receiver type hierarchy/);
    const compact = await callTool(directory, 'graft_trace_calls', { symbol: 'CX_ROOT=>PING', direction: 'in', evidence: false });
    assert.equal(compact.isError, false, compact.text);
    assert.doesNotMatch(compact.text, /CATCH declaration|Receiver type hierarchy/);
    const unresolved = await callTool(directory, 'graft_unresolved_calls', { query: 'ABSENT', evidence: true });
    assert.equal(unresolved.isError, false, unresolved.text);
    assert.match(unresolved.text, /CATCH declaration/);
    assert.match(unresolved.text, /Receiver type hierarchy/);
    const revision = unresolved.text.match(/inventory:[a-f0-9]{64}/)?.[0];
    assert.ok(revision);
    writeFileSync(join(directory, 'src/zcatch.prog.abap'), `REPORT zcatch.\n${hierarchy}\nTRY. CATCH cx_missing INTO DATA(err). err->ping( ). err->absent( ). ENDTRY.`);
    const updated = await callTool(directory, 'graft_trace_calls', { symbol: 'CX_ROOT=>PING', direction: 'in' });
    assert.equal(updated.isError, false, updated.text);
    assert.match(updated.text, /no indexed callers/);
    const oldPage = await callTool(directory, 'graft_unresolved_calls', { revision, offset: 1 });
    assert.equal(oldPage.isError, true, oldPage.text);
    assert.match(oldPage.text, /revision/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
