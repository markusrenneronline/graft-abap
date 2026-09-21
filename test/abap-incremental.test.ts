import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';
import { extractAbapFiles } from '../src/graph/abap.js';
import { formatUnresolvedCalls, unresolvedCallMatches } from '../src/graph/unresolved-calls.js';
import { resolveSymbol } from '../src/graph/traverse.js';

const TARGET = `CLASS zcl_target DEFINITION PUBLIC. PUBLIC SECTION.
CLASS-METHODS ping IMPORTING iv_test TYPE abap_bool DEFAULT abap_false.
ENDCLASS.
CLASS zcl_target IMPLEMENTATION. METHOD ping.
IF iv_test = abap_true. WRITE 'test'. ENDIF.
ENDMETHOD. ENDCLASS.`;
const CALLER = 'REPORT zcaller. zcl_target=>ping( ).';

function sameAsCold(sources: Map<string, string>, session: AbapParseSession) {
  const incremental = extractAbapFiles(sources, session);
  assert.deepEqual(incremental, extractAbapFiles(sources), 'AST reuse must preserve nodes, edges, diagnostics, unresolved references and all evidence');
  return incremental;
}

test('object ASTs are reused while edited defaults and formerly missing targets resolve globally', () => {
  const session = new AbapParseSession();
  const sources = new Map([['src/zcaller.prog.abap', CALLER], ['src/zcl_target.clas.abap', TARGET]]);
  sameAsCold(sources, session);
  assert.equal(session.stats.parsedObjects, 2);
  sameAsCold(sources, session);
  assert.equal(session.stats.parsedObjects, 0);
  assert.equal(session.stats.reusedObjects, 2);
  sources.set('src/zcl_target.clas.abap', TARGET.replace('DEFAULT abap_false', 'DEFAULT abap_true'));
  sameAsCold(sources, session);
  assert.equal(session.stats.parsedObjects, 1);
  assert.equal(session.stats.reusedObjects, 1);
  sources.delete('src/zcl_target.clas.abap');
  const missing = sameAsCold(sources, session);
  assert.equal(session.stats.parsedObjects, 0);
  assert.equal(missing.edges.filter(e => e.relation === 'calls').length, 0);
  assert.equal(missing.unresolvedCalls[0].targetName, 'ZCL_TARGET=>PING');
  sources.set('src/zcl_target.clas.abap', TARGET);
  const restored = sameAsCold(sources, session);
  assert.equal(restored.unresolvedCalls.length, 0);
  assert.equal(restored.edges.filter(e => e.relation === 'calls').length, 1);
});

test('class include changes invalidate their whole object while unrelated callers reuse syntax', () => {
  const session = new AbapParseSession();
  const sources = new Map([
    ['src/zcl_target.clas.abap', TARGET], ['src/zcaller.prog.abap', CALLER],
    ['src/zcl_target.clas.locals_def.abap', 'CLASS lcl_helper DEFINITION. PUBLIC SECTION. METHODS go. ENDCLASS.'],
    ['src/zcl_target.clas.locals_imp.abap', 'CLASS lcl_helper IMPLEMENTATION. METHOD go. ENDMETHOD. ENDCLASS.'],
  ]);
  sameAsCold(sources, session);
  sources.set('src/zcl_target.clas.locals_imp.abap', 'CLASS lcl_helper IMPLEMENTATION. METHOD go. zcl_target=>ping( ). ENDMETHOD. ENDCLASS.');
  sameAsCold(sources, session);
  assert.equal(session.stats.parsedObjects, 1);
  assert.equal(session.stats.parsedFiles, 3);
  assert.equal(session.stats.reusedFiles, 1);
});

test('changing inheritance, interfaces, metadata, and duplicate symbols matches a cold registry', () => {
  const session = new AbapParseSession();
  const sources = new Map([
    ['src/zcl_target.clas.abap', TARGET], ['src/zcaller.prog.abap', CALLER],
    ['src/zcl_child.clas.abap', 'CLASS zcl_child DEFINITION INHERITING FROM zcl_target. ENDCLASS. CLASS zcl_child IMPLEMENTATION. ENDCLASS.'],
    ['src/zother.prog.abap', 'REPORT zother. zcl_child=>ping( ).'],
  ]);
  sameAsCold(sources, session);
  sources.set('src/zcl_child.clas.abap', sources.get('src/zcl_child.clas.abap')!.replace('INHERITING FROM zcl_target', ''));
  sameAsCold(sources, session);
  sources.set('src/zif_contract.intf.abap', 'INTERFACE zif_contract PUBLIC. METHODS run. ENDINTERFACE.');
  sameAsCold(sources, session);
  sources.set('src/zcl_target.clas.xml', '<abapGit><CLSNAME>ZCL_TARGET</CLSNAME><DESCRIPT>Changed</DESCRIPT></abapGit>');
  sameAsCold(sources, session);
  sources.set('other/zcl_target.clas.abap', TARGET);
  sameAsCold(sources, session);
  sources.delete('other/zcl_target.clas.abap');
  sameAsCold(sources, session);
});

test('macro definition changes and removals cannot leave cached expanded syntax', () => {
  const session = new AbapParseSession();
  const sources = new Map([
    ['src/zcaller.prog.abap', 'REPORT zcaller.\nDEFINE macro.\n zcl_target=>ping( ).\nEND-OF-DEFINITION.\nmacro.'],
    ['src/zcl_target.clas.abap', TARGET],
  ]);
  sameAsCold(sources, session);
  sources.set('src/zcaller.prog.abap', sources.get('src/zcaller.prog.abap')!.replace('zcl_target=>ping( )', "WRITE 'changed'"));
  sameAsCold(sources, session);
  sources.set('src/zcaller.prog.abap', CALLER);
  sameAsCold(sources, session);
  assert.equal(session.stats.reusedObjects, 0);
  sources.set('src/zcaller.prog.abap', CALLER + '\n* edited');
  sameAsCold(sources, session);
  assert.equal(session.stats.reusedObjects, 1);
});

test('missing-target reference lookup retains source and never invents a call edge', () => {
  const extracted = extractAbapFiles(new Map([['src/zcaller.prog.abap', CALLER]]));
  const graph = { ...extracted, meta: { version: 1 as const, nodeCount: extracted.nodes.length, edgeCount: extracted.edges.length, languages: ['abap'] } };
  assert.equal(graph.edges.filter(e => e.relation === 'calls').length, 0);
  const refs = unresolvedCallMatches(graph, 'zcl_target.ping');
  assert.equal(refs.length, 1);
  assert.equal(unresolvedCallMatches(graph, 'PING').length, 1);
  assert.equal(unresolvedCallMatches(graph, 'zcl_other=>ping').length, 0);
  assert.equal(unresolvedCallMatches(graph, 'PING', 'other/').length, 0);
  assert.match(formatUnresolvedCalls(graph, refs), /not resolved graph edges/);
  assert.match(formatUnresolvedCalls(graph, refs), /zcl_target=>ping\( \)/);
});

test('a qualified missing ABAP method never resolves to the same name in another class', () => {
  const extracted = extractAbapFiles(new Map([['src/zcaller.prog.abap', CALLER], ['src/zcl_other.clas.abap', TARGET.replaceAll('zcl_target', 'zcl_other')]]));
  const graph = { ...extracted, meta: { version: 1 as const, nodeCount: extracted.nodes.length, edgeCount: extracted.edges.length, languages: ['abap'] } };
  for (const query of ['ZCL_TARGET=>PING', 'ZCL_TARGET->PING', 'ZCL_TARGET.PING']) assert.deepEqual(resolveSymbol(graph, query), []);
  assert.equal(resolveSymbol(graph, 'ZCL_OTHER=>PING').length, 1);
  assert.equal(unresolvedCallMatches(graph, 'ZCL_TARGET=>PING').length, 1);
});
