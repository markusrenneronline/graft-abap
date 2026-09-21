import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAbapFiles } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';

test('method references distinguish missing owners, duplicate owners and untyped receivers', () => {
  const sources = new Map([
    ['src/zcaller.prog.abap', 'REPORT zcaller. zcl_missing=>ping( ). zcl_dup=>ping( ). lo_ref->ping( ).'],
    ['src/a/zcl_dup.clas.abap', 'CLASS zcl_dup DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS ping. ENDCLASS.'],
    ['src/b/zcl_dup.clas.abap', 'CLASS zcl_dup DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS ping. ENDCLASS.'],
  ]);
  const session = new AbapParseSession();
  const result = extractAbapFiles(sources, session);
  for (const [name, reason] of [['ZCL_MISSING=>PING', 'missing_target'], ['ZCL_DUP=>PING', 'ambiguous_target'], ['LO_REF->PING', 'unresolved_receiver']]) {
    assert.ok(result.unresolvedCalls.some(r => r.targetName === name && r.reason === reason));
  }
  sources.delete('src/b/zcl_dup.clas.abap');
  const changed = extractAbapFiles(sources, session);
  assert.deepEqual(changed, extractAbapFiles(sources));
  assert.equal(changed.edges.filter(e => e.relation === 'calls').length, 1);
  assert.equal(changed.unresolvedCalls.length, 2);
});

test('inherited method lookup preserves missing and ambiguous base causes', () => {
  const source = `CLASS zcl_child DEFINITION PUBLIC INHERITING FROM zcl_base.
PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS zcl_child IMPLEMENTATION. METHOD run. me->ping( ). super->ping( ). ENDMETHOD. ENDCLASS.`;
  const sources = new Map([['src/zcl_child.clas.abap', source]]);
  const missing = extractAbapFiles(sources);
  assert.equal(missing.unresolvedCalls.length, 2);
  assert.ok(missing.unresolvedCalls.every(r => r.reason === 'missing_target'));
  assert.ok(missing.unresolvedCalls.some(r => r.targetName === 'ZCL_BASE->PING'));
  const base = 'CLASS zcl_base DEFINITION PUBLIC. PUBLIC SECTION. METHODS ping. ENDCLASS.';
  sources.set('src/a/zcl_base.clas.abap', base); sources.set('src/b/zcl_base.clas.abap', base);
  const ambiguous = extractAbapFiles(sources);
  assert.equal(ambiguous.unresolvedCalls.length, 2);
  assert.ok(ambiguous.unresolvedCalls.every(r => r.reason === 'ambiguous_target'));
});

test('implemented aliases resolve while inheritance cycles remain incomplete', () => {
  const result = extractAbapFiles(new Map([
    ['src/zc.prog.abap', `REPORT zc.
INTERFACE lif. METHODS ping. ENDINTERFACE.
CLASS lcl DEFINITION. PUBLIC SECTION. INTERFACES lif. ALIASES alias FOR lif~ping. METHODS run. ENDCLASS.
CLASS lcl IMPLEMENTATION. METHOD lif~ping. ENDMETHOD. METHOD run. alias( ). ENDMETHOD. ENDCLASS.
CLASS la DEFINITION INHERITING FROM lb. PUBLIC SECTION. CLASS-METHODS run. ENDCLASS.
CLASS lb DEFINITION INHERITING FROM la. ENDCLASS.
CLASS la IMPLEMENTATION. METHOD run. absent( ). ENDMETHOD. ENDCLASS.`],
  ]));
  assert.deepEqual(result.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  assert.equal(result.unresolvedCalls.length, 1);
  assert.ok(result.unresolvedCalls.every(r => r.reason === 'resolution_incomplete'));
  const call = result.edges.find(e => e.relation === 'calls')!;
  assert.equal(result.nodes.find(n => n.id === call.target)?.name, 'LIF~PING');
});

test('interfaces do not hide a uniquely inherited method or explicit implementation', () => {
  const result = extractAbapFiles(new Map([['src/zc.prog.abap', `REPORT zc.
INTERFACE lif. METHODS act. ENDINTERFACE.
CLASS base DEFINITION. PUBLIC SECTION. METHODS ping. ENDCLASS.
CLASS child DEFINITION INHERITING FROM base. PUBLIC SECTION. INTERFACES lif. METHODS run. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD lif~act. ENDMETHOD.
METHOD run. me->ping( ). me->lif~act( ). ENDMETHOD. ENDCLASS.`]]));
  assert.equal(result.unresolvedCalls.length, 0);
  assert.equal(result.edges.filter(e => e.relation === 'calls').length, 2);
});
