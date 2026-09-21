import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, basename } from 'node:path';
import { buildGraph } from '../src/graph/build.js';
import { checkGraph } from '../src/graph/check.js';
import { ensureFreshGraph } from '../src/graph/refresh.js';
import { probeDrift } from '../src/graph/fingerprint.js';
import { readGraph, wiringPath } from '../src/graph/write.js';
import { resolveSymbol } from '../src/graph/traverse.js';
import { callTool } from '../src/mcp/tools.js';
import { supportedExtensions } from '../src/graph/source-files.js';

const TARGET = `CLASS zcl_target DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS ping.
ENDCLASS.
CLASS zcl_target IMPLEMENTATION.
  METHOD ping.
  ENDMETHOD.
ENDCLASS.
`;
const CALLER = `REPORT zcaller.
START-OF-SELECTION.
  zcl_target=>ping( ).
`;
const META = `<?xml version="1.0" encoding="utf-8"?>
<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values>
<VSEOCLASS><CLSNAME>ZCL_TARGET</CLSNAME><DESCRIPT>Initial</DESCRIPT></VSEOCLASS>
</asx:values></asx:abap></abapGit>`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graft-abap-test-'));
  const src = join(root, 'src');
  const out = join(root, 'generated');
  mkdirSync(src);
  writeFileSync(join(src, 'zcl_target.clas.abap'), TARGET);
  writeFileSync(join(src, 'zcl_target.clas.xml'), META);
  writeFileSync(join(src, 'zcaller.prog.abap'), CALLER);
  return { root, src, out, cleanup() {
    assert.equal(relative(resolve(tmpdir()), resolve(root)).startsWith('..'), false);
    assert.ok(basename(root).startsWith('graft-abap-test-'));
    rmSync(root, { recursive: true, force: true });
  } };
}

test('ABAP cold and repeated build agree; Graft tools see methods and calls', async () => {
  const f = fixture();
  try {
    assert.ok(supportedExtensions().includes('.abap'));
    const built = await buildGraph(f.root, { contextDir: f.out, onlyDirs: ['src'] });
    assert.deepEqual(built.errors, []);
    assert.equal(built.abap?.files, 3);
    const before = readFileSync(wiringPath(f.out), 'utf8');
    const graph = readGraph(wiringPath(f.out))!;
    const method = resolveSymbol(graph, 'zcl_target=>ping');
    assert.equal(method.length, 1);
    assert.equal(method[0].kind, 'method');
    assert.ok(graph.edges.some(edge => edge.relation === 'calls' && edge.target === method[0].id));
    assert.equal((await checkGraph(f.root, { contextDir: f.out })).ok, true);
    await buildGraph(f.root, { contextDir: f.out, onlyDirs: ['src'] });
    assert.equal(readFileSync(wiringPath(f.out), 'utf8'), before);
    const api = await callTool(f.root, 'graft_file_api', { file: 'zcl_target.clas.abap' }, f.out);
    assert.equal(api.isError, false);
    assert.match(api.text, /ping/i);
    assert.match(api.text, /ABAP pilot/);
    const trace = await callTool(f.root, 'graft_trace_calls', { symbol: 'ZCL_TARGET=>PING' }, f.out);
    assert.equal(trace.isError, false);
    assert.match(trace.text, /zcaller/i);
  } finally { f.cleanup(); }
});

test('ABAP metadata changes are detected and refresh keeps ABAP indexed', async () => {
  const f = fixture();
  try {
    await buildGraph(f.root, { contextDir: f.out, onlyDirs: ['src'] });
    writeFileSync(join(f.src, 'zcl_target.clas.xml'), META.replace('Initial', 'Changed description'));
    assert.ok(probeDrift(f.root, f.out)?.changed.includes('src/zcl_target.clas.xml'));
    assert.equal((await checkGraph(f.root, { contextDir: f.out })).ok, false);
    assert.equal((await ensureFreshGraph(f.root, { contextDir: f.out })).refreshed, true);
    assert.equal((await checkGraph(f.root, { contextDir: f.out })).ok, true);
    assert.equal(resolveSymbol(readGraph(wiringPath(f.out))!, 'ZCL_TARGET.PING').length, 1);
  } finally { f.cleanup(); }
});

test('unchanged ABAP caller loses its edge when callee is deleted', async () => {
  const f = fixture();
  try {
    await buildGraph(f.root, { contextDir: f.out, onlyDirs: ['src'] });
    const old = resolveSymbol(readGraph(wiringPath(f.out))!, 'ZCL_TARGET.PING')[0].id;
    rmSync(join(f.src, 'zcl_target.clas.abap'));
    await ensureFreshGraph(f.root, { contextDir: f.out });
    const graph = readGraph(wiringPath(f.out))!;
    assert.ok(!graph.nodes.some(node => node.id === old));
    assert.ok(!graph.edges.some(edge => edge.target === old));
    const diagnostics = JSON.parse(readFileSync(join(f.out, '.graph', 'abap-diagnostics.json'), 'utf8'));
    assert.ok(diagnostics.diagnostics.some((item: {message:string}) => /ping|zcl_target/i.test(item.message)));
  } finally { f.cleanup(); }
});

test('ABAP warnings stay separate from build errors and last deletion clears diagnostics', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.src, 'zcaller.prog.abap'), "REPORT zcaller.\nCALL FUNCTION 'SAP_EXTERNAL_FUNCTION'.\n");
    const result = await buildGraph(f.root, { contextDir: f.out, onlyDirs: ['src'] });
    assert.deepEqual(result.errors, []);
    assert.ok((result.abap?.diagnostics ?? 0) > 0);
    for (const name of ['zcaller.prog.abap', 'zcl_target.clas.abap', 'zcl_target.clas.xml']) rmSync(join(f.src, name));
    await ensureFreshGraph(f.root, { contextDir: f.out });
    assert.equal(readGraph(wiringPath(f.out))!.nodes.length, 0);
    assert.equal(JSON.parse(readFileSync(join(f.out, '.graph', 'abap-diagnostics.json'), 'utf8')).diagnostics.length, 0);
    assert.ok(existsSync(f.src));
  } finally { f.cleanup(); }
});

test('ABAP trace evidence persists all call sites and refreshes changed defaults', async () => {
  const f = fixture();
  const source = `CLASS zcl_target DEFINITION PUBLIC.
PUBLIC SECTION.
CLASS-METHODS evaluate IMPORTING iv_test TYPE abap_bool DEFAULT abap_false.
CLASS-METHODS ping IMPORTING value TYPE string.
ENDCLASS.
CLASS zcl_target IMPLEMENTATION.
METHOD evaluate.
  IF iv_test = abap_true.
    ping( value = 'simulation' ).
  ELSE.
    ping( value = 'productive' ).
  ENDIF.
ENDMETHOD.
METHOD ping.
ENDMETHOD.
ENDCLASS.
`;
  try {
    writeFileSync(join(f.src, 'zcl_target.clas.abap'), source);
    writeFileSync(join(f.src, 'zcaller.prog.abap'), 'REPORT zcaller.\nzcl_target=>evaluate( ).\n');
    await buildGraph(f.root, { contextDir: f.out, onlyDirs: ['src'] });
    const graph = readGraph(wiringPath(f.out))!;
    const evaluate = resolveSymbol(graph, 'ZCL_TARGET.EVALUATE')[0];
    const ping = resolveSymbol(graph, 'ZCL_TARGET.PING')[0];
    const call = graph.edges.find(edge => edge.source === evaluate.id && edge.target === ping.id && edge.relation === 'calls')!;
    assert.equal(call.callSites?.length, 2);
    assert.deepEqual(call.callSites?.map(site => site.span), ['L9-L9', 'L11-L11']);
    assert.match(evaluate.declaration?.text ?? '', /DEFAULT abap_false/);
    const args = { symbol: 'ZCL_TARGET.PING', direction: 'in', depth: 2 };
    const detailed = await callTool(f.root, 'graft_trace_calls', args, f.out);
    assert.equal(detailed.isError, false);
    for (const text of ["value = 'simulation'", "value = 'productive'", 'DEFAULT abap_false', 'IF iv_test = abap_true.', 'ELSE.']) assert.ok(detailed.text.includes(text), text);
    const compact = await callTool(f.root, 'graft_trace_calls', { ...args, evidence: false }, f.out);
    assert.equal(compact.isError, false);
    assert.doesNotMatch(compact.text, /value = 'simulation'|Call site \d|```abap/);
    assert.match(compact.text, /\[possibly infeasible: IV_TEST omitted.*DEFAULT abap_false/);
    writeFileSync(join(f.src, 'zcl_target.clas.abap'), source.replace('DEFAULT abap_false', 'DEFAULT abap_true'));
    const refreshed = await callTool(f.root, 'graft_trace_calls', args, f.out);
    assert.equal(refreshed.isError, false);
    assert.match(refreshed.text, /DEFAULT abap_true/);
    assert.doesNotMatch(refreshed.text, /DEFAULT abap_false/);
  } finally { f.cleanup(); }
});
