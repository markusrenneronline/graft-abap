import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAbapFiles } from '../src/graph/abap.js';
import { queryUnresolvedCalls } from '../src/graph/unresolved-calls.js';
import { buildGraph } from '../src/graph/build.js';
import { callTool, TOOLS } from '../src/mcp/tools.js';
import type { GraphV1 } from '../src/graph/types.js';
// @ts-ignore JavaScript evidence verifier
import { verifyUnresolvedReferences } from '../pilot/evaluate-evidence.mjs';

const source = "REPORT zcaller.\n" + Array.from({ length: 27 }, (_, i) => `SUBMIT zmissing${i} AND RETURN.`).join('\n')
  + "\nCALL TRANSACTION 'PA30'.\nSUBMIT (lv_report).";
function graph(): GraphV1 {
  return { ...extractAbapFiles(new Map([['src/pkg/zcaller.prog.abap', source]])),
    meta: { version: 1, nodeCount: 2, edgeCount: 1, languages: ['abap'] } };
}

test('inventory pages expose every occurrence once in source order and preserve IDs across filters', () => {
  const g = graph();
  const a = queryUnresolvedCalls(g, { limit: 20 });
  const b = queryUnresolvedCalls(g, { offset: 20 });
  const ids = (text: string) => [...text.matchAll(/\[(unresolved:[a-f0-9]+)\]/g)].map(m => m[1]);
  assert.equal(ids(a).length, 20); assert.equal(ids(b).length, 9);
  assert.equal(new Set([...ids(a), ...ids(b)]).size, 29);
  assert.match(a, /Next page: offset=20/); assert.doesNotMatch(b, /Next page/);
  const filtered = queryUnresolvedCalls(g, { query: 'zmissing0', source: 'ZCALLER', in: 'src/pkg', evidence: true });
  assert.equal(ids(filtered).length, 1); assert.equal(ids(filtered)[0], ids(a)[0]);
  assert.match(filtered, /SUBMIT zmissing0 AND RETURN/);
  assert.match(queryUnresolvedCalls(g, { target_kind: 'transaction' }), /1 matched of 29/);
  assert.match(queryUnresolvedCalls(g, { reason: 'dynamic_target' }), /1 matched of 29/);
  assert.match(queryUnresolvedCalls(g, { in: 'src/p' }), /0 matched/);
});

test('bad filters and pagination fail explicitly; evidence is not silently coerced', () => {
  for (const args of [{ limit: 0 }, { offset: -1 }, { limit: 101 }, { offset: 1.5 }, { query: 2 },
    { target_kind: 'typo' }, { reason: 'typo' }, { evidence: 'false' }]) {
    assert.throws(() => queryUnresolvedCalls(graph(), args));
  }
});

test('reference verifier checks every caller, ID and recorded source excerpt', () => {
  const g = graph();
  assert.deepEqual(verifyUnresolvedReferences(g, () => source), { total: 29, invalid: [] });
  g.unresolvedCalls![0].source = 'absent';
  g.unresolvedCalls![1].site.text = 'fabricated statement';
  g.unresolvedCalls!.push(g.unresolvedCalls![2]);
  const invalid = verifyUnresolvedReferences(g, () => source).invalid;
  assert.deepEqual(new Set(invalid.map((r: { reason: string }) => r.reason)), new Set(['missing caller', 'invalid source excerpt', 'duplicate id']));
});

test('MCP inventory is advertised, callable and traceable by missing report name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-unresolved-query-'));
  try {
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/zcaller.prog.abap'), source);
    await buildGraph(root);
    const schema = TOOLS.find(t => t.name === 'graft_unresolved_calls')!.inputSchema as { properties: object };
    assert.equal(Object.keys(schema.properties).length, 9);
    const inventory = await callTool(root, 'graft_unresolved_calls', { query: 'zmissing0', evidence: true });
    assert.equal(inventory.isError, false); assert.match(inventory.text, /SUBMIT zmissing0 AND RETURN/);
    const trace = await callTool(root, 'graft_trace_calls', { symbol: 'ZMISSING0', direction: 'in' });
    assert.equal(trace.isError, false); assert.match(trace.text, /program; missing_target/);
    assert.equal((await callTool(root, 'graft_unresolved_calls', { offset: 'bad' })).isError, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
