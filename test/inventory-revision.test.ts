import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAbapFiles } from '../src/graph/abap.js';
import { queryDiagnostics } from '../src/graph/diagnostics.js';
import { queryUnresolvedCalls } from '../src/graph/unresolved-calls.js';
import { buildGraph } from '../src/graph/build.js';
import { callTool } from '../src/mcp/tools.js';
import type { GraphV1 } from '../src/graph/types.js';

const source = 'REPORT zpages.\nSUBMIT zfirst AND RETURN.\nSUBMIT zsecond AND RETURN.\nSUBMIT zthird AND RETURN.\n';
function graph(): GraphV1 {
  const extraction = extractAbapFiles(new Map([['src/zpages.prog.abap', source]]));
  return { ...extraction, abap: { files: 1, diagnostics: extraction.diagnostics },
    meta: { version: 1, nodeCount: extraction.nodes.length, edgeCount: extraction.edges.length, languages: ['abap'] } };
}
const queries = [
  { name: 'diagnostics', query: queryDiagnostics, tool: 'graft_diagnostics' },
  { name: 'unresolved calls', query: queryUnresolvedCalls, tool: 'graft_unresolved_calls' },
];
const revisionOf = (output: string): string => {
  const revision = /^\[Inventory\] revision: (inventory:[a-f0-9]{64})$/m.exec(output)?.[1];
  assert.ok(revision, output); return revision;
};

for (const { name, query, tool } of queries) {
  test(`${name}: pinned pages keep a revision across filters, sizes and evidence display`, () => {
    const g = graph(), first = query(g, { limit: 1 });
    const revision = revisionOf(first);
    assert.ok(first.includes(`revision="${revision}"`), 'next-page instruction includes the snapshot identity');
    for (const args of [{ offset: 1 }, { limit: 2 }, { evidence: true }, { query: 'ZSECOND' }, { in: 'src' }]) {
      const result = query(g, { ...args, revision });
      assert.equal(revisionOf(result), revision);
      assert.match(result, /revision verified/);
      assert.doesNotMatch(result, /unpinned/);
    }
    assert.match(query(g, { offset: 1 }), /pagination is unpinned/);
    assert.match(query(g, { offset: 100, revision }), /shown 0/);
  });

  test(`${name}: content edits and deletion invalidate earlier pages even at equal counts`, () => {
    const g = graph(), revision = revisionOf(query(g, {}));
    if (name === 'diagnostics') g.abap!.diagnostics[0].message += ' changed';
    else g.unresolvedCalls![0].reason = 'dynamic_target';
    assert.throws(() => query(g, { offset: 1, revision }), /Inventory changed.*Restart with offset=0/s);
    assert.throws(() => query(g, { revision }), /Inventory changed/);
    const current = revisionOf(query(g, {}));
    if (name === 'diagnostics') g.abap!.diagnostics.pop();
    else g.unresolvedCalls!.pop();
    assert.throws(() => query(g, { revision: current }), /Inventory changed/);
  });

  test(`${name}: captured source changes invalidate compact pages too`, () => {
    const g = graph(), revision = revisionOf(query(g, {}));
    if (name === 'diagnostics') g.abap!.diagnostics[0].source!.text += ' "comment';
    else g.unresolvedCalls![0].site.text += ' "comment';
    assert.throws(() => query(g, { evidence: false, revision }), /Inventory changed/);
  });

  test(`${name}: reload, object-key order and unrelated graph metadata do not invalidate pages`, () => {
    const g = graph(), revision = revisionOf(query(g, {}));
    const reverseKeys = (value: any): any => Array.isArray(value) ? value.map(reverseKeys)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
    const reloaded: GraphV1 = reverseKeys(JSON.parse(JSON.stringify(g)));
    reloaded.meta.nodeCount = 999;
    reloaded.nodes.reverse(); reloaded.abap!.diagnostics.reverse(); reloaded.unresolvedCalls!.reverse();
    assert.equal(revisionOf(query(reloaded, { revision })), revision);
  });

  test(`${name}: invalid revision types and malformed tokens are explicit errors`, () => {
    for (const revision of [null, 2, true, '', ' ', 'old', 'inventory:' + 'a'.repeat(63), 'inventory:' + 'A'.repeat(64)])
      assert.throws(() => query(graph(), { revision }), /revision must/);
  });

  test(`${name}: MCP refuses page continuation after a real refresh, retains old revision on failed refresh`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'graft-inventory-revision-'));
    try {
      mkdirSync(join(root, 'src')); const file = join(root, 'src/zpages.prog.abap');
      writeFileSync(file, source); await buildGraph(root);
      const first = await callTool(root, tool, { limit: 1 });
      assert.equal(first.isError, false);
      const revision = revisionOf(first.text);
      writeFileSync(file, 'REPORT zpages.\nCLASS broken DEFINITION.');
      const retained = await callTool(root, tool, { offset: 1, limit: 1, revision });
      assert.equal(retained.isError, false); assert.match(retained.text, /not verified current/);
      assert.equal(revisionOf(retained.text), revision);
      writeFileSync(file, source.replace('SUBMIT zfirst AND RETURN.\n', ''));
      const changed = await callTool(root, tool, { offset: 1, limit: 1, revision });
      assert.equal(changed.isError, true); assert.match(changed.text, /Inventory changed/);
      assert.doesNotMatch(changed.text, /shown \d/);
      const restarted = await callTool(root, tool, { limit: 1 });
      assert.equal(restarted.isError, false); assert.notEqual(revisionOf(restarted.text), revision);
      assert.match(restarted.text, /2 matched of 2/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('unresolved revision covers caller labels and source filtering, but not unrelated nodes', () => {
  const g = graph(), revision = revisionOf(queryUnresolvedCalls(g, {}));
  const caller = g.nodes.find(n => n.id === g.unresolvedCalls![0].source)!;
  g.nodes.push({ ...caller, id: 'unrelated', name: 'UNRELATED' });
  assert.equal(revisionOf(queryUnresolvedCalls(g, { revision })), revision);
  caller.name = 'RENAMED';
  assert.throws(() => queryUnresolvedCalls(g, { revision }), /Inventory changed/);
});

test('revision domains and absent diagnostics cannot be confused', () => {
  const g = graph();
  const revision = revisionOf(queryDiagnostics(g, {}));
  assert.throws(() => queryUnresolvedCalls(g, { revision }), /Inventory changed/);
  g.abap!.diagnostics = [];
  const empty = revisionOf(queryDiagnostics(g, {}));
  delete g.abap;
  assert.throws(() => queryDiagnostics(g, { revision: empty }), /Inventory changed/);
});
