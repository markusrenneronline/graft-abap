import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAbapFiles } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';

test('SUBMIT resolves an exported report and retains the complete source statement', () => {
  const graph = extractAbapFiles(new Map([
    ['src/za.prog.abap', "REPORT za.\nIF sy-batch = abap_false.\nSUBMIT zb WITH p_value = 'Z' AND RETURN.\nENDIF."],
    ['src/zb.prog.abap', 'REPORT zb.\nPARAMETERS p_value TYPE string.'],
  ]));
  const a = graph.nodes.find(n => n.name === 'ZA')!, b = graph.nodes.find(n => n.name === 'ZB')!;
  const call = graph.edges.find(e => e.source === a.id && e.target === b.id && e.relation === 'calls');
  assert.ok(call); assert.equal(call.callSites![0].text, "SUBMIT zb WITH p_value = 'Z' AND RETURN.");
  assert.match(call.callSites![0].controls![0].text, /sy-batch/);
  assert.equal(graph.unresolvedCalls.length, 0);
});

test('missing, ambiguous and dynamic reports are references, never guessed edges', () => {
  const sources = new Map([
    ['src/za.prog.abap', "REPORT za. SUBMIT external_report AND RETURN. SUBMIT (lv_report) AND RETURN. SUBMIT zb."],
    ['src/one/zb.prog.abap', 'REPORT zb.'], ['src/two/zb.prog.abap', 'REPORT zb.'],
  ]);
  const graph = extractAbapFiles(sources);
  assert.equal(graph.edges.filter(e => e.relation === 'calls').length, 0);
  assert.equal(graph.unresolvedCalls.length, 3);
  for (const [target, reason] of [['EXTERNAL_REPORT', 'missing_target'], ['(lv_report)', 'dynamic_target'], ['ZB', 'ambiguous_target']]) {
    assert.ok(graph.unresolvedCalls.some(r => r.targetName === target && r.reason === reason), JSON.stringify(graph.unresolvedCalls));
  }
  const session = new AbapParseSession(); extractAbapFiles(sources, session);
  sources.delete('src/two/zb.prog.abap');
  const incremental = extractAbapFiles(sources, session);
  assert.deepEqual(incremental, extractAbapFiles(sources));
  assert.equal(incremental.edges.filter(e => e.relation === 'calls').length, 1);
});

test('CALL TRANSACTION uses literal transaction metadata, not same-name reports or variable names', () => {
  const graph = extractAbapFiles(new Map([
    ['src/za.prog.abap', "REPORT za. CALL TRANSACTION 'ZKNOWN' AND SKIP FIRST SCREEN. CALL TRANSACTION 'PA30'. CALL TRANSACTION lv_tcode."],
    ['src/pa30.prog.abap', 'REPORT pa30.'],
    ['src/zknown.tran.xml', '<abapGit><asx:abap><asx:values><TSTC><TCODE>ZKNOWN</TCODE><PGMNA>PA30</PGMNA></TSTC></asx:values></asx:abap></abapGit>'],
  ]));
  const edges = graph.edges.filter(e => e.relation === 'calls');
  assert.equal(edges.length, 1);
  const target = graph.nodes.find(n => n.id === edges[0].target)!;
  assert.equal(target.signature, 'TRANSACTION ZKNOWN');
  assert.ok(graph.unresolvedCalls.some(r => r.targetName === 'PA30' && r.reason === 'missing_transaction_metadata'));
  assert.ok(graph.unresolvedCalls.some(r => r.targetName === 'lv_tcode' && r.reason === 'dynamic_target'));
  assert.equal(graph.diagnostics.filter(d => d.kind === 'parse_error' || d.kind === 'unsupported_statement').length, 0);
});

test('transaction XML edits and duplicate targets change resolution in a reused session', () => {
  const xml = (name: string) => `<abapGit><asx:abap><asx:values><TSTC><TCODE>${name}</TCODE></TSTC></asx:values></asx:abap></abapGit>`;
  const sources = new Map([['src/za.prog.abap', "REPORT za. CALL TRANSACTION 'ZT'."], ['src/zt.tran.xml', xml('ZT')]]);
  const session = new AbapParseSession(); extractAbapFiles(sources, session);
  sources.set('src/other/zt.tran.xml', xml('ZT'));
  assert.deepEqual(extractAbapFiles(sources, session), extractAbapFiles(sources));
  assert.equal(extractAbapFiles(sources, session).unresolvedCalls[0].reason, 'ambiguous_target');
  sources.set('src/zt.tran.xml', xml('ZU')); sources.delete('src/other/zt.tran.xml');
  const changed = extractAbapFiles(sources, session);
  assert.deepEqual(changed, extractAbapFiles(sources));
  assert.equal(changed.unresolvedCalls[0].reason, 'missing_transaction_metadata');
});

test('a function occupying the entire file owns its calls instead of the fallback file node', () => {
  const graph = extractAbapFiles(new Map([
    ['src/zfg.fugr.zentry.abap', 'FUNCTION zentry.\nSUBMIT zmissing AND RETURN.\nCALL FUNCTION \'ZEXT\'.\nENDFUNCTION.'],
  ]));
  const fn = graph.nodes.find(n => n.name === 'ZENTRY')!;
  assert.ok(fn);
  assert.equal(graph.unresolvedCalls.length, 2);
  assert.ok(graph.unresolvedCalls.every(r => r.source === fn.id));
});
