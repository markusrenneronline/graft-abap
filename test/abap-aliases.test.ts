import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAbapFiles } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';

const parse = (source: string) => {
  const result = extractAbapFiles(new Map([['src/za.prog.abap', `REPORT za.\n${source}`]]));
  assert.deepEqual(result.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  return result;
};

test('class aliases resolve to implemented interface methods and retain formal defaults', () => {
  const result = parse(`INTERFACE lif. METHODS act IMPORTING value TYPE string DEFAULT 'default'. ENDINTERFACE.
CLASS cls DEFINITION. PUBLIC SECTION. INTERFACES lif. ALIASES execute FOR lif~act. METHODS run. ENDCLASS.
CLASS cls IMPLEMENTATION. METHOD lif~act. ENDMETHOD.
METHOD run. execute( ). me->execute( value = 'explicit' ). ENDMETHOD. ENDCLASS.`);
  assert.equal(result.unresolvedCalls.length, 0);
  const calls = result.edges.filter(e => e.relation === 'calls');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callSites?.length, 2);
  const target = result.nodes.find(n => n.id === calls[0].target)!;
  assert.equal(target.name, 'LIF~ACT');
  assert.equal(target.abapParameters?.[0].defaultValue, "'default'");
});

test('alias spellings in METHOD implementations and nested interface aliases share one target', () => {
  const result = parse(`INTERFACE inner. METHODS act. ENDINTERFACE.
INTERFACE middle. INTERFACES inner. ALIASES forward FOR inner~act. ENDINTERFACE.
INTERFACE outer. INTERFACES middle. ALIASES forward FOR middle~forward. ENDINTERFACE.
CLASS cls DEFINITION. PUBLIC SECTION. INTERFACES outer. ALIASES execute FOR outer~forward. METHODS run. ENDCLASS.
CLASS cls IMPLEMENTATION. METHOD execute. ENDMETHOD.
METHOD run. execute( ). me->inner~act( ). me->outer~forward( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(result.unresolvedCalls.length, 0);
  const calls = result.edges.filter(e => e.relation === 'calls');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callSites?.length, 3);
  assert.equal(result.nodes.find(n => n.id === calls[0].target)?.name, 'INNER~ACT');
});

test('inherited aliases dispatch to the child redefinition and shadow builtin names', () => {
  const result = parse(`INTERFACE lif. METHODS act RETURNING VALUE(result) TYPE i. ENDINTERFACE.
CLASS base DEFINITION. PUBLIC SECTION. INTERFACES lif. ALIASES lines FOR lif~act. ENDCLASS.
CLASS base IMPLEMENTATION. METHOD lif~act. ENDMETHOD. ENDCLASS.
CLASS child DEFINITION INHERITING FROM base. PUBLIC SECTION. METHODS lif~act REDEFINITION. METHODS run. ENDCLASS.
CLASS child IMPLEMENTATION. METHOD lif~act. ENDMETHOD.
METHOD run. DATA(a) = lines( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(result.unresolvedCalls.length, 0);
  const call = result.edges.find(e => e.relation === 'calls')!;
  const target = result.nodes.find(n => n.id === call.target)!;
  assert.equal(target.owner, 'CHILD');
  assert.equal(target.name, 'LIF~ACT');
});

test('alias changes match a cold parse and a missing interface target stays unresolved', () => {
  const source = (target: string) => `CLASS cls DEFINITION. PUBLIC SECTION. INTERFACES lif. ALIASES execute FOR lif~${target}. METHODS run. ENDCLASS.
CLASS cls IMPLEMENTATION. METHOD lif~first. ENDMETHOD. METHOD lif~second. ENDMETHOD.
METHOD run. execute( ). ENDMETHOD. ENDCLASS.`;
  const sources = new Map([['src/za.prog.abap', `REPORT za. ${source('first')}`]]);
  const session = new AbapParseSession(); extractAbapFiles(sources, session);
  sources.set('src/za.prog.abap', `REPORT za. ${source('second')}`);
  const changed = extractAbapFiles(sources, session);
  assert.deepEqual(changed, extractAbapFiles(sources));
  const call = changed.edges.find(e => e.relation === 'calls')!;
  assert.equal(changed.nodes.find(n => n.id === call.target)?.name, 'LIF~SECOND');
  sources.set('src/za.prog.abap', `REPORT za. ${source('absent')}`);
  const missing = extractAbapFiles(sources, session);
  assert.equal(missing.edges.filter(e => e.relation === 'calls').length, 0);
  assert.equal(missing.unresolvedCalls.length, 1);
});

test('cyclic aliases terminate with an explicit unresolved reference', () => {
  const result = parse(`INTERFACE lif. INTERFACES lif. ALIASES a FOR lif~b. ALIASES b FOR lif~a. ENDINTERFACE.
CLASS cls DEFINITION. PUBLIC SECTION. INTERFACES lif. ALIASES execute FOR lif~a. METHODS run. ENDCLASS.
CLASS cls IMPLEMENTATION. METHOD run. execute( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(result.unresolvedCalls.length, 1);
  assert.equal(result.unresolvedCalls[0].reason, 'resolution_incomplete');
  assert.equal(result.edges.filter(e => e.relation === 'calls').length, 0);
});

test('nested interface references point to declarations, never an arbitrary implementing class', () => {
  const result = parse(`INTERFACE inner. METHODS act. ENDINTERFACE.
INTERFACE outer. INTERFACES inner. ALIASES forward FOR inner~act. ENDINTERFACE.
DATA ref TYPE REF TO outer.
ref->forward( ).
CLASS cls DEFINITION. PUBLIC SECTION. INTERFACES inner. ENDCLASS.
CLASS cls IMPLEMENTATION. METHOD inner~act. ENDMETHOD. ENDCLASS.`);
  assert.equal(result.unresolvedCalls.length, 0);
  const call = result.edges.find(e => e.relation === 'calls')!;
  const target = result.nodes.find(n => n.id === call.target)!;
  assert.equal(target.owner, 'INNER');
  assert.equal(target.name, 'ACT');
});

test('data aliases are not mistaken for methods or unshadowed builtins', () => {
  const result = parse(`INTERFACE lif. DATA value TYPE i. ENDINTERFACE.
CLASS cls DEFINITION. PUBLIC SECTION. INTERFACES lif. ALIASES lines FOR lif~value. METHODS run. ENDCLASS.
CLASS cls IMPLEMENTATION. METHOD run. DATA(count) = lines( table ). ENDMETHOD. ENDCLASS.`);
  assert.equal(result.edges.filter(e => e.relation === 'calls').length, 0);
  assert.equal(result.unresolvedCalls.length, 1);
});

test('unrelated and ambiguous interface aliases never redirect a call to another implementation', () => {
  const result = parse(`INTERFACE first. METHODS act. ENDINTERFACE.
INTERFACE other. INTERFACES first. ALIASES forward FOR first~act. ENDINTERFACE.
CLASS cls DEFINITION. PUBLIC SECTION. INTERFACES first. METHODS run. ENDCLASS.
CLASS cls IMPLEMENTATION. METHOD first~act. ENDMETHOD.
METHOD run. me->other~forward( ). ENDMETHOD. ENDCLASS.`);
  assert.equal(result.edges.filter(e => e.relation === 'calls').length, 0);
  assert.equal(result.unresolvedCalls.length, 1);
  const ambiguous = extractAbapFiles(new Map([
    ['src/a/zif.intf.abap', 'INTERFACE zif PUBLIC. ALIASES forward FOR zmissing~first. ENDINTERFACE.'],
    ['src/b/zif.intf.abap', 'INTERFACE zif PUBLIC. ALIASES forward FOR zmissing~second. ENDINTERFACE.'],
    ['src/zc.prog.abap', `REPORT zc. CLASS cls DEFINITION. PUBLIC SECTION. INTERFACES zif. METHODS run. ENDCLASS.
CLASS cls IMPLEMENTATION. METHOD zmissing~first. ENDMETHOD. METHOD zmissing~second. ENDMETHOD.
METHOD run. me->zif~forward( ). ENDMETHOD. ENDCLASS.`],
  ]));
  assert.equal(ambiguous.edges.filter(e => e.relation === 'calls').length, 0);
  assert.equal(ambiguous.unresolvedCalls.length, 1);
});
