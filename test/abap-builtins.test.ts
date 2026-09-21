import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAbapFiles } from '../src/graph/abap.js';

test('unshadowed ABAP 7.50 builtins are not missing methods; nested real calls remain', () => {
  const graph = extractAbapFiles(new Map([['src/zb.prog.abap', `REPORT zb.
CLASS local DEFINITION. PUBLIC SECTION. METHODS run. METHODS text RETURNING VALUE(result) TYPE string. ENDCLASS.
CLASS local IMPLEMENTATION. METHOD text. ENDMETHOD. METHOD run.
DATA(v) = to_upper( text( ) ).
DATA(n) = strlen( condense( v ) ).
DATA(count) = lines( table ).
DATA(found) = xsdbool( line_exists( table[ 1 ] ) ).
ENDMETHOD. ENDCLASS.`]]));
  assert.deepEqual(graph.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  assert.equal(graph.unresolvedCalls.length, 0);
  const calls = graph.edges.filter(e => e.relation === 'calls');
  assert.equal(calls.length, 1);
  assert.equal(graph.nodes.find(n => n.id === calls[0].target)?.name, 'TEXT');
  assert.equal(graph.diagnostics.filter(d => d.kind === 'external_call').length, 0);
});

test('own and inherited methods shadow builtins; qualified and classic calls are not removed', () => {
  const graph = extractAbapFiles(new Map([['src/zb.prog.abap', `REPORT zb.
CLASS base DEFINITION. PUBLIC SECTION. METHODS strlen IMPORTING value TYPE string RETURNING VALUE(result) TYPE i. ENDCLASS.
CLASS child DEFINITION INHERITING FROM base. PUBLIC SECTION. METHODS run. METHODS lines RETURNING VALUE(result) TYPE i. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD lines. ENDMETHOD. METHOD run.
DATA(a) = strlen( 'a' ). DATA(b) = lines( ).
me->strlen( 'b' ). zcl_external=>strlen( 'c' ).
CALL METHOD to_upper.
ENDMETHOD. ENDCLASS.`]]));
  assert.equal(graph.edges.filter(e => e.relation === 'calls').flatMap(e => e.callSites ?? []).length, 3);
  assert.equal(graph.unresolvedCalls.length, 2);
  assert.ok(graph.unresolvedCalls.some(r => r.targetName === 'ZCL_EXTERNAL=>STRLEN'));
  assert.ok(graph.unresolvedCalls.some(r => r.targetName === 'CHILD->TO_UPPER'));
});

test('unknown superclass, missing declaration and post-7.50 functions cannot prove a builtin', () => {
  const graph = extractAbapFiles(new Map([
    ['src/zc.clas.abap', `CLASS zc DEFINITION PUBLIC INHERITING FROM zmissing. PUBLIC SECTION. METHODS run. ENDCLASS.
CLASS zc IMPLEMENTATION. METHOD run. DATA(a) = strlen( 'x' ). ENDMETHOD. ENDCLASS.`],
    ['src/zd.clas.abap', "CLASS zd IMPLEMENTATION. METHOD run. DATA(a) = strlen( 'x' ). ENDMETHOD. ENDCLASS."],
    ['src/zb.prog.abap', 'REPORT zb. DATA(now) = utclong_current( ).'],
  ]));
  assert.equal(graph.unresolvedCalls.length, 3);
  assert.ok(graph.unresolvedCalls.some(r => r.targetName === 'UTCLONG_CURRENT'));
});

test('unqualified builtins in a class implementing an external interface are still builtins', () => {
  const graph = extractAbapFiles(new Map([['src/zc.clas.abap', `CLASS zc DEFINITION PUBLIC.
PUBLIC SECTION. INTERFACES if_http_extension. METHODS run. ENDCLASS.
CLASS zc IMPLEMENTATION. METHOD run. DATA(a) = to_upper( 'x' ). ENDMETHOD. ENDCLASS.`]]));
  assert.equal(graph.unresolvedCalls.length, 0);
  assert.ok(graph.diagnostics.some(d => d.kind === 'external_reference'));
});
