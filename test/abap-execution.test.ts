import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { extractAbapFiles } from '../src/graph/abap.js';
import { AbapParseSession } from '../src/graph/abap-parse-cache.js';
import { formatTraceEvidence, traceChainWarnings } from '../src/graph/trace-evidence.js';
import { analyzeCallChain, analyzeDefaultConditions } from '../src/graph/abap-feasibility.js';
import { queryUnresolvedCalls } from '../src/graph/unresolved-calls.js';
import { buildGraph } from '../src/graph/build.js';
import { callTool } from '../src/mcp/tools.js';
import type { GraphV1 } from '../src/graph/types.js';

function parse(source: string): GraphV1 {
  const result = extractAbapFiles(new Map([
    ['src/zcaller.prog.abap', source],
    ['src/zfg.fugr.zwork.abap', 'FUNCTION zwork. ENDFUNCTION.'],
  ]));
  assert.deepEqual(result.diagnostics.filter(d => d.kind === 'unsupported_statement'), []);
  return { ...result, meta: { version: 1, nodeCount: result.nodes.length, edgeCount: result.edges.length, languages: ['abap'] } };
}

const callbackSource = `REPORT zcaller.
CLASS cls DEFINITION. PUBLIC SECTION.
METHODS run. METHODS callback IMPORTING task TYPE clike. METHODS sink.
ENDCLASS.
CLASS cls IMPLEMENTATION.
METHOD run.
CALL FUNCTION 'ZWORK' STARTING NEW TASK 'T' CALLING me->callback ON END OF TASK EXPORTING value = 'function-only'.
ENDMETHOD.
METHOD callback. sink( ). ENDMETHOD.
METHOD sink. ENDMETHOD.
ENDCLASS.`;

test('aRFC method callbacks carry runtime argument uncertainty and a scheduling boundary', () => {
  const g = parse(callbackSource);
  const callback = g.nodes.find(n => n.name === 'CALLBACK')!;
  const registration = g.edges.find(e => e.relation === 'calls' && e.target === callback.id)!;
  assert.equal(registration.callSites?.[0].execution, 'callback');
  assert.equal(registration.callSites?.[0].argumentsComplete, false);
  assert.deepEqual(registration.callSites?.[0].arguments, {});
  const fn = g.nodes.find(n => n.name === 'ZWORK')!;
  const call = g.edges.find(e => e.relation === 'calls' && e.target === fn.id)!;
  assert.equal(call.callSites?.[0].execution, 'async');
  assert.deepEqual(call.callSites?.[0].arguments, { VALUE: "'function-only'" });
  assert.ok(!g.edges.some(e => e.source === fn.id && e.target === callback.id));
  const run = g.nodes.find(n => n.name === 'RUN')!;
  const output = formatTraceEvidence(g, run, 'out', 2, { maxSites: 1, exitSources: [] });
  assert.match(output, /Execution: callback/);
  assert.match(output, /supplied by the RFC runtime/);
  assert.match(output, /execution boundary: callback/);
  const sink = g.nodes.find(n => n.name === 'SINK')!;
  assert.match((traceChainWarnings(g, run, 'out', 2).get(sink.id) ?? []).join('\n'), /execution boundary: callback/);
  assert.match((traceChainWarnings(g, sink, 'in', 2).get(run.id) ?? []).join('\n'), /execution boundary: callback/);
});

test('FORM callbacks are recorded and remain distinct from normal and ON COMMIT/ROLLBACK calls', () => {
  const g = parse(`REPORT zcaller.
CALL FUNCTION 'ZWORK' STARTING NEW TASK 'T' PERFORMING receive ON END OF TASK.
PERFORM receive USING 'normal'.
PERFORM committed ON COMMIT.
PERFORM rolled_back ON ROLLBACK.
FORM receive USING task TYPE clike. ENDFORM.
FORM committed. ENDFORM.
FORM rolled_back. ENDFORM.`);
  const modes = (name: string) => g.edges.filter(e => e.relation === 'calls' && e.target === g.nodes.find(n => n.name === name)!.id).flatMap(e => e.callSites ?? []).map(s => s.execution);
  assert.deepEqual(modes('RECEIVE'), ['callback', undefined]);
  assert.deepEqual(modes('COMMITTED'), ['on_commit']);
  assert.deepEqual(modes('ROLLED_BACK'), ['on_rollback']);
});

test('update/background/async function modes come from direct AST keywords, never parameter names', () => {
  const g = parse(`REPORT zcaller.
CALL FUNCTION 'ZWORK' IN UPDATE TASK.
CALL FUNCTION 'ZWORK' IN BACKGROUND TASK.
CALL FUNCTION 'ZWORK' IN BACKGROUND UNIT lo_unit.
CALL FUNCTION 'ZWORK' STARTING NEW TASK 'T'.
CALL FUNCTION 'ZWORK' EXPORTING update = update background = background task = task.
CALL FUNCTION 'ZWORK' PARAMETER-TABLE params.
CALL FUNCTION 'ZWORK' EXCEPTION-TABLE exceptions.`);
  const sites = g.edges.filter(e => e.relation === 'calls').flatMap(e => e.callSites ?? []);
  assert.deepEqual(sites.map(s => s.execution), ['update_task', 'background_task', 'async', undefined, undefined, undefined]);
  assert.ok(g.unresolvedCalls!.some(r => r.targetKind === 'function' && r.reason === 'remote' && r.site.execution === 'background_unit'),
    'a matching local function does not establish the destination held by the bgRFC unit');
  assert.match(queryUnresolvedCalls(g, { evidence: false }), /execution: background_unit/);
  assert.equal(sites[0].argumentsComplete, true, 'an ordinary empty list stays complete');
  assert.equal(sites.at(-2)?.argumentsComplete, false);
  assert.equal(sites.at(-1)?.argumentsComplete, false);
});

test('missing/remote/dynamic callback and function targets retain execution metadata in inventory', () => {
  const g = parse(`REPORT zcaller.
CALL FUNCTION 'ZWORK' STARTING NEW TASK 'T' DESTINATION 'REMOTE' CALLING lo_ref->(lv_method) ON END OF TASK.
CALL FUNCTION lv_fn IN UPDATE TASK.
CALL FUNCTION 'ZWORK' STARTING NEW TASK 'T' PERFORMING absent ON END OF TASK.`);
  assert.ok(g.unresolvedCalls!.some(r => r.targetKind === 'function' && r.reason === 'remote' && r.site.execution === 'async'));
  assert.ok(g.unresolvedCalls!.some(r => r.targetKind === 'function' && r.reason === 'dynamic_target' && r.site.execution === 'update_task'));
  assert.ok(g.unresolvedCalls!.some(r => r.targetKind === 'method' && r.reason === 'dynamic_target' && r.site.execution === 'callback'));
  assert.ok(g.unresolvedCalls!.some(r => r.targetKind === 'form' && r.site.execution === 'callback'));
  assert.match(queryUnresolvedCalls(g, { evidence: false }), /execution: callback/);
});

test('scheduling boundaries suppress immediate parameter-default reasoning even with legacy-looking actuals', () => {
  const g = parse(callbackSource);
  const cb = g.nodes.find(n => n.name === 'CALLBACK')!;
  cb.abapParameters = [{ name: 'IV_TEST', direction: 'IMPORTING', defaultValue: 'abap_false' }];
  const incoming = g.edges.find(e => e.relation === 'calls' && e.target === cb.id)!;
  const outgoing = g.edges.find(e => e.relation === 'calls' && e.source === cb.id)!;
  incoming.callSites![0] = { ...incoming.callSites![0], arguments: {}, argumentsComplete: true, execution: 'callback' };
  outgoing.callSites![0] = { ...outgoing.callSites![0], unchangedParameters: ['IV_TEST'], controls: [{ path: 'src/zcaller.prog.abap', span: 'L9-L9', text: 'IF iv_test = abap_true.', kind: 'IF' }] };
  assert.deepEqual(analyzeCallChain(g, [incoming, outgoing]), []);
  outgoing.callSites![0].execution = 'on_commit';
  assert.deepEqual(analyzeDefaultConditions(g, outgoing), []);
});

test('mode changes invalidate evidence in a reused parser and match a cold parse', () => {
  const sources = new Map([['src/zcaller.prog.abap', "REPORT zcaller. CALL FUNCTION 'ZWORK'."], ['src/zfg.fugr.zwork.abap', 'FUNCTION zwork. ENDFUNCTION.']]);
  const session = new AbapParseSession(); extractAbapFiles(sources, session);
  sources.set('src/zcaller.prog.abap', "REPORT zcaller. CALL FUNCTION 'ZWORK' IN UPDATE TASK.");
  const changed = extractAbapFiles(sources, session);
  assert.deepEqual(changed, extractAbapFiles(sources));
  assert.equal(changed.edges.find(e => e.relation === 'calls')?.callSites?.[0].execution, 'update_task');
});

test('execution warnings survive a mixed edge site cap and an empty evidence selection', () => {
  const g = parse(`REPORT zcaller.
PERFORM receive USING 'normal'.
CALL FUNCTION 'ZWORK' STARTING NEW TASK 'T' PERFORMING receive ON END OF TASK.
FORM receive USING task TYPE clike. ENDFORM.`);
  const seed = g.nodes.find(n => n.name === 'RECEIVE')!;
  const caller = g.nodes.find(n => n.name === 'ZCALLER')!;
  const output = formatTraceEvidence(g, seed, 'in', 1, { maxSites: 1 });
  assert.match(output, /execution boundary: callback/);
  assert.match(output, /showing 1 of 2/);
  assert.match((traceChainWarnings(g, seed, 'in', 1).get(caller.id) ?? []).join('\n'), /at least one recorded site/);
});

test('persisted execution metadata reaches compact and filtered MCP traces', async () => {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, 'graft-abap-execution-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/zcaller.prog.abap'), callbackSource);
    writeFileSync(join(root, 'src/zfg.fugr.zwork.abap'), 'FUNCTION zwork. ENDFUNCTION.');
    await buildGraph(root);
    for (const args of [
      { symbol: 'CLS=>SINK', direction: 'in', depth: 2, evidence: false },
      { symbol: 'CLS=>RUN', direction: 'out', depth: 2, evidence_targets: [], exit_sources: [] },
    ]) {
      const result = await callTool(root, 'graft_trace_calls', args);
      assert.equal(result.isError, false, result.text);
      assert.match(result.text, /execution boundary: callback/);
      assert.doesNotMatch(result.text, /possibly infeasible/);
    }
    const detailed = await callTool(root, 'graft_trace_calls', { symbol: 'CLS=>CALLBACK', direction: 'in' });
    assert.equal(detailed.isError, false);
    assert.match(detailed.text, /supplied by the RFC runtime/);
  } finally {
    assert.equal(dirname(root), parent);
    rmSync(root, { recursive: true, force: true });
  }
});
