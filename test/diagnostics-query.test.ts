import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAbapFiles } from '../src/graph/abap.js';
import { diagnosticId, queryDiagnostics } from '../src/graph/diagnostics.js';
import { buildGraph } from '../src/graph/build.js';
import { writeWorkspace } from '../src/graph/workspace.js';
import { callTool, TOOLS } from '../src/mcp/tools.js';
import { GRAFT_MCP_TOOL_CANONICAL, GRAFT_MCP_TOOL_NAMES } from '../src/mcp/tool-names.js';
import { mcpInstructions, toolSearchQuery } from '../src/mcp/instructions.js';
import type { GraphV1 } from '../src/graph/types.js';
// @ts-ignore JavaScript evidence verifier
import { verifyDiagnosticEvidence } from '../pilot/evaluate-evidence.mjs';

const path = 'src/pkg/znotices.prog.abap';
const source = 'REPORT znotices.\r\n' + Array.from({ length: 65 }, (_, i) => `  SUBMIT zmissing${i} AND RETURN.`).join('\r\n');
function graph(): GraphV1 {
  const extracted = extractAbapFiles(new Map([[path, source]]));
  return { ...extracted, abap: { files: 1, diagnostics: extracted.diagnostics },
    meta: { version: 1, nodeCount: extracted.nodes.length, edgeCount: extracted.edges.length, languages: ['abap'] } };
}
const ids = (text: string) => [...text.matchAll(/\[(diagnostic:[a-f0-9]+)\]/g)].map(m => m[1]);

test('diagnostics beyond fifty are reachable exactly once with stable filtered identities', () => {
  const g = graph();
  assert.equal(g.abap!.diagnostics.length, 65);
  const pages = [0, 20, 40, 60].map(offset => queryDiagnostics(g, { offset }));
  assert.deepEqual(pages.map(p => ids(p).length), [20, 20, 20, 5]);
  assert.equal(new Set(pages.flatMap(ids)).size, 65);
  assert.match(pages[0], /Next page: offset=20/); assert.doesNotMatch(pages[3], /Next page/);
  const filtered = queryDiagnostics(g, { kind: 'external_call', query: 'ZMISSING64', in: 'src/pkg', evidence: true });
  assert.deepEqual(ids(filtered), [ids(pages[3]).at(-1)]);
  assert.match(filtered, /Recorded source line: src\/pkg\/znotices.prog.abap:L66-L66/);
  assert.match(filtered, /  SUBMIT zmissing64 AND RETURN\./);
  assert.deepEqual(ids(queryDiagnostics(g, { query: ids(filtered)[0] })), ids(filtered));
  assert.match(queryDiagnostics(g, { in: 'src/p' }), /0 matched/);
  assert.match(queryDiagnostics(g, { in: 'src\\pkg' }), /65 matched/);
  assert.match(queryDiagnostics(g, { offset: 100 }), /shown 0/);
  assert.match(queryDiagnostics(g, { kind: 'absent_kind' }), /0 matched/);
});

test('every stored diagnostic source line is exact, optional and independent of identity', () => {
  const g = graph();
  for (const item of g.abap!.diagnostics) {
    assert.equal(item.source?.path, path);
    assert.equal(item.source?.text, source.split(/\r?\n/)[item.line! - 1]);
    const id = diagnosticId(item);
    delete item.source;
    assert.equal(diagnosticId(item), id);
  }
  assert.match(queryDiagnostics(g, { evidence: true }), /Source evidence unavailable in this graph/);
  assert.doesNotMatch(queryDiagnostics(g, {}), /Recorded source line|Source evidence unavailable/);
});

test('bad diagnostic filters fail explicitly instead of silently showing another page', () => {
  const g = graph();
  for (const args of [{ limit: 0 }, { limit: 101 }, { limit: '2' }, { limit: null }, { offset: -1 },
    { offset: 1.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { evidence: 'false' },
    { kind: [] }, { query: 2 }, { query: ' ' }, { in: '' }]) assert.throws(() => queryDiagnostics(g, args));
});

test('missing ABAP inventory and source-less global notices remain explicit', () => {
  const g = graph(); delete g.abap;
  assert.match(queryDiagnostics(g, {}), /no ABAP diagnostic inventory/);
  g.abap = { files: 0, diagnostics: [{ path: '', kind: 'parse_error', message: 'analysis failed' }] };
  assert.match(queryDiagnostics(g, { evidence: true }), /\(analysis\).*parse_error/);
  assert.match(queryDiagnostics(g, { evidence: true }), /Source evidence unavailable/);
});

test('unknown statements retain their original source without asserting a compiler error', () => {
  const raw = 'REPORT znotices.\n  rp-imp-c2-ps.\n';
  const extracted = extractAbapFiles(new Map([[path, raw]]));
  const item = extracted.diagnostics.find(d => d.kind === 'unsupported_statement');
  assert.ok(item); assert.equal(item.source?.text, '  rp-imp-c2-ps.');
  assert.equal(item.source?.span, 'L2-L2');
});

test('MCP diagnostics uses stored evidence during failed refresh and updates after recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-diagnostic-query-'));
  try {
    mkdirSync(join(root, 'src')); const file = join(root, 'src/znotices.prog.abap');
    writeFileSync(file, source);
    await buildGraph(root);
    const schema = TOOLS.find(t => t.name === 'graft_diagnostics')!.inputSchema as { properties: object };
    assert.equal(Object.keys(schema.properties).length, 7);
    const before = await callTool(root, 'graft_diagnostics', { query: 'ZMISSING64', evidence: true });
    assert.equal(before.isError, false); assert.match(before.text, /SUBMIT zmissing64/);
    writeFileSync(file, 'REPORT znotices.\nCLASS broken DEFINITION.');
    const stale = await callTool(root, 'graft_diagnostics', { query: 'ZMISSING64', evidence: true });
    assert.match(stale.text, /not verified current/);
    assert.match(stale.text, /SUBMIT zmissing64/);
    assert.deepEqual(ids(stale.text), ids(before.text));
    writeFileSync(file, 'REPORT znotices.\nSUBMIT znew AND RETURN.');
    const fresh = await callTool(root, 'graft_diagnostics', { evidence: true });
    assert.equal(fresh.isError, false); assert.match(fresh.text, /SUBMIT znew/);
    assert.doesNotMatch(fresh.text, /zmissing64|not verified current/);
    assert.equal((await callTool(root, 'graft_diagnostics', { offset: 'bad' })).isError, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('advertised MCP tools and canonical scoring vocabulary cannot drift apart', () => {
  assert.deepEqual([...GRAFT_MCP_TOOL_CANONICAL].sort(), TOOLS.map(t => t.name).sort());
  assert.ok(GRAFT_MCP_TOOL_NAMES.has('graft_unresolved_calls'));
  assert.ok(GRAFT_MCP_TOOL_NAMES.has('graft_diagnostics'));
  assert.deepEqual(toolSearchQuery('').slice('select:'.length).split(',').sort(), TOOLS.map(t => t.name).sort());
  assert.ok(mcpInstructions().length < 1000);
});

test('diagnostic pagination refuses workspace aggregation instead of returning a misleading empty page', async () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-diagnostic-workspace-'));
  try {
    writeWorkspace(root, { version: 1, children: [] });
    const result = await callTool(root, 'graft_diagnostics', {});
    assert.equal(result.isError, true); assert.match(result.text, /individual repository/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('independent diagnostic verifier detects invented lines, wrong paths, spans and missing files', () => {
  const g = graph();
  assert.deepEqual(verifyDiagnosticEvidence(g, () => source), { total: 65, withEvidence: 65, withoutEvidence: 0, invalid: [] });
  const items = g.abap!.diagnostics;
  items[0].source!.text = items[0].source!.text.trim();
  items[1].source!.span = 'L1-L1';
  items[2].source!.path = 'other.abap';
  items[3].line = 1000;
  items[4].path = 'missing.abap';
  delete items[5].source;
  const report = verifyDiagnosticEvidence(g, (file: string) => { if (file !== path) throw new Error('missing'); return source; });
  assert.equal(report.invalid.length, 5);
  assert.equal(report.withoutEvidence, 1);
});
