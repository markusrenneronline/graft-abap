import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAbapFiles } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';

function extract(body: string) {
  const result = extractAbapFiles(new Map([['src/zdynamic.prog.abap', `REPORT zdynamic.\n${body}`]]));
  assert.deepEqual(result.diagnostics.filter(d => ['parse_error', 'unsupported_statement'].includes(d.kind)), []);
  assert.equal(new Set(result.unresolvedCalls.map(r => r.id)).size, result.unresolvedCalls.length);
  return result;
}

test('dynamic classic calls retain their source, arguments and enclosing conditions without guessing targets', () => {
  const result = extract(`DATA value TYPE string.
value = 'input'.
IF sy-batch = abap_false.
  CALL METHOD lo_ref->(lv_method) EXPORTING iv_value = value.
  CALL METHOD (lv_class)=>(lv_method) PARAMETER-TABLE params.
  CALL FUNCTION lv_function EXPORTING iv_value = value.
  PERFORM (lv_form) IN PROGRAM (lv_program) USING value.
  PERFORM lv_index OF first second.
ENDIF.`);
  assert.equal(result.edges.filter(e => e.relation === 'calls').length, 0);
  assert.deepEqual(result.unresolvedCalls.map(r => r.targetKind).sort(), ['form', 'form', 'function', 'method', 'method']);
  assert.ok(result.unresolvedCalls.every(r => r.reason === 'dynamic_target'));
  assert.ok(result.unresolvedCalls.every(r => r.site.controls?.[0].text === 'IF sy-batch = abap_false.'));
  const call = result.unresolvedCalls.find(r => r.targetName === 'lo_ref->(lv_method)')!;
  assert.ok(call);
  assert.deepEqual(call.site.arguments, { IV_VALUE: 'value' });
  assert.equal(call.site.localAssignments?.[0].text, "value = 'input'.");
  const fn = result.unresolvedCalls.find(r => r.targetKind === 'function')!;
  assert.deepEqual(fn.site.arguments, { IV_VALUE: 'value' });
  assert.ok(result.unresolvedCalls.some(r => r.targetName.includes('lv_index OF first second')));
});

test('unresolved functional receivers keep every occurrence, including repeated chained methods', () => {
  const result = extract(`lo_ref->factory( )->ping( iv = 'one' )->ping( iv = 'two' ).
ls_container-ref->ping( iv = 'three' ).
CALL METHOD lo_ref->child->ping EXPORTING iv = 'four'.`);
  assert.equal(result.edges.filter(e => e.relation === 'calls').length, 0);
  assert.equal(result.unresolvedCalls.length, 5);
  assert.ok(result.unresolvedCalls.every(r => r.reason === 'unresolved_receiver'));
  for (const value of ["'one'", "'two'", "'three'", "'four'"]) {
    assert.ok(result.unresolvedCalls.some(r => r.site.arguments?.IV === value), value);
  }
  const chained = result.unresolvedCalls.filter(r => r.site.arguments?.IV === "'one'" || r.site.arguments?.IV === "'two'");
  assert.notEqual(chained[0].site.occurrence?.column, chained[1].site.occurrence?.column);
  assert.ok(chained.every(r => r.targetName.includes('factory')));
});

test('OF as a normal PERFORM actual is not mistaken for indexed dispatch', () => {
  const result = extract('DATA of TYPE i. PERFORM first USING of. FORM first USING value TYPE i. ENDFORM.');
  assert.equal(result.unresolvedCalls.length, 0);
  assert.equal(result.edges.filter(e => e.relation === 'calls').length, 1);
});

test('dynamic references survive parser reuse and never use runtime-looking string literals as targets', () => {
  const sources = new Map([['src/zdynamic.prog.abap', `REPORT zdynamic.
DATA lv_function TYPE string VALUE 'ZKNOWN'.
CALL FUNCTION lv_function.
" CALL FUNCTION fake.
WRITE 'CALL METHOD ref->(name)'.`], ['src/zfg.fugr.zknown.abap', 'FUNCTION zknown. ENDFUNCTION.']]);
  const session = new AbapParseSession();
  extractAbapFiles(sources, session);
  sources.set('src/other.prog.abap', 'REPORT other.');
  const reused = extractAbapFiles(sources, session);
  assert.deepEqual(reused, extractAbapFiles(sources));
  assert.equal(reused.unresolvedCalls.length, 1);
  assert.equal(reused.unresolvedCalls[0].targetName, 'lv_function');
  assert.equal(reused.unresolvedCalls[0].reason, 'dynamic_target');
  assert.equal(reused.edges.filter(e => e.relation === 'calls').length, 0);
});

test('a DESTINATION parameter name is not RFC dispatch; actual destinations stay explicit', () => {
  const result = extractAbapFiles(new Map([
    ['src/zcaller.prog.abap', `REPORT zcaller.
CALL FUNCTION 'ZKNOWN' EXPORTING destination = destination.
CALL FUNCTION 'ZKNOWN' DESTINATION 'NONE'.
CALL FUNCTION 'ZKNOWN' DESTINATION target.
CALL FUNCTION 'ZKNOWN' DESTINATION IN GROUP DEFAULT.`],
    ['src/zfg.fugr.zknown.abap', 'FUNCTION zknown. ENDFUNCTION.'],
  ]));
  assert.deepEqual(result.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  const sites = result.edges.filter(e => e.relation === 'calls').flatMap(e => e.callSites ?? []);
  assert.equal(sites.length, 2);
  assert.deepEqual(sites[0].arguments, { DESTINATION: 'destination' });
  assert.equal(result.unresolvedCalls.length, 2);
  assert.ok(result.unresolvedCalls.every(r => r.reason === 'remote'));
});
