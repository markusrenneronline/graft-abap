import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
// The child runs dist: seed with that same extractor identity so fresh-query
// tests do not accidentally exercise a source-to-dist cache migration.
import { buildGraph } from '../dist/graph/build.js';

const TARGET = `CLASS zcl_target DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION.
CLASS-METHODS ping.
ENDCLASS.
CLASS zcl_target IMPLEMENTATION.
METHOD ping.
ENDMETHOD.
ENDCLASS.`;

async function fixture(abap = true) {
  const base = mkdtempSync(join(tmpdir(), 'graft-lazy-abap-')), root = join(base, 'repo'), out = join(base, 'graph');
  mkdirSync(join(root, 'src'), { recursive: true });
  if (abap) {
    writeFileSync(join(root, 'src/zcl_target.clas.abap'), TARGET);
    writeFileSync(join(root, 'src/zcaller.prog.abap'), 'REPORT zcaller.\nSTART-OF-SELECTION.\nzcl_target=>ping( ).\n');
    await buildGraph(root, { contextDir: out, onlyDirs: ['src'] });
  } else writeFileSync(join(root, 'src/sample.ts'), 'export function answer() { return 42; }');
  return {
    root, out,
    // Each probe has a fresh ESM cache; the parent may already use the parser.
    async probe(body: string, mode: 'allow' | 'fail' | 'mutate' = 'allow') {
      const log = join(base, 'loads.txt'), hook = join(base, 'loader.mjs'), preload = join(base, 'preload.mjs'), entry = join(base, 'probe.mjs');
      writeFileSync(hook, `import { appendFileSync } from 'node:fs';
export async function load(url, context, next) {
 if (['abap', 'abap-parse-cache', 'abap-assignments'].some(name => url.endsWith('/dist/graph/' + name + '.js')) || url.includes('/node_modules/@abaplint/')) {
  appendFileSync(${JSON.stringify(log)}, url + '\\n');
  if (${JSON.stringify(mode)} === 'fail') throw new Error('fixture ABAP parser unavailable');
  if (${JSON.stringify(mode)} === 'mutate' && url.endsWith('/dist/graph/abap.js')) {
   appendFileSync(${JSON.stringify(join(root, 'src/zcaller.prog.abap'))}, '* changed during parser import\\n');
  }
 }
 return next(url, context);
}`);
      writeFileSync(preload, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hook).href)});`);
      const moduleUrl = (name: string) => JSON.stringify(new URL(`../dist/${name}.js`, import.meta.url).href);
      writeFileSync(entry, `import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph } from ${moduleUrl('graph/build')};
import { checkGraph } from ${moduleUrl('graph/check')};
import { ensureFreshGraph } from ${moduleUrl('graph/refresh')};
import { readGraph, wiringPath } from ${moduleUrl('graph/write')};
import { callTool } from ${moduleUrl('mcp/tools')};
const root = ${JSON.stringify(root)}, out = ${JSON.stringify(out)}, opts = { contextDir: out, onlyDirs: ['src'] };
${body}
console.log('probe complete');
`);
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(preload).href, entry], {
        timeout: 30000, windowsHide: true,
        env: { ...process.env, DO_NOT_TRACK: '1', GRAFT_NO_UPKEEP: '1', GRAFT_NO_SAVINGS: '1', GRAFT_NO_GITIGNORE: '1', GRAFT_NO_IGNORE: '1', GRAFT_STRUCTURAL_ONLY: '1', GRAFT_SOURCE_STATE: '', GRAFT_NO_REFRESH: '0' },
      });
      assert.match(stdout, /probe complete/);
      return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    },
    saved() {
      return Object.fromEntries(readdirSync(out, { recursive: true, withFileTypes: true }).filter(item => item.isFile()).map(item => {
        const file = join(item.parentPath, item.name);
        return [relative(out, file), readFileSync(file).toString('base64')];
      }));
    },
    cleanup() {
      assert.ok(!relative(resolve(tmpdir()), resolve(base)).startsWith('..'));
      assert.ok(base.includes('graft-lazy-abap-'));
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('non-ABAP build and check work even when the ABAP parser cannot load', async () => {
  const f = await fixture(false);
  try {
    const loads = await f.probe(`await buildGraph(root, opts);
assert.equal((await checkGraph(root, opts)).ok, true);
assert.ok(readGraph(wiringPath(out)).nodes.some(n => n.name === 'answer'));`, 'fail');
    assert.deepEqual(loads, []);
  } finally { f.cleanup(); }
});

test('a fresh ABAP trace returns its call edge without loading the parser', async () => {
  const f = await fixture();
  try {
    const loads = await f.probe(`const reply = await callTool(root, 'graft_trace_calls', { symbol: 'ZCL_TARGET=>PING', direction: 'in' }, out);
assert.equal(reply.isError, false);
assert.match(reply.text, /zcaller/i);
assert.doesNotMatch(reply.text, /not verified current/i);`, 'fail');
    assert.deepEqual(loads, []);
  } finally { f.cleanup(); }
});

test('an explicit ABAP check loads the parser and detects a missing committed call edge', async () => {
  const f = await fixture();
  try {
    const loads = await f.probe(`const graph = readGraph(wiringPath(out));
assert.ok(graph.edges.some(edge => edge.relation === 'calls'));
graph.edges = graph.edges.filter(edge => edge.relation !== 'calls');
writeFileSync(wiringPath(out), JSON.stringify(graph));
const check = await checkGraph(root, opts);
assert.equal(check.ok, false);
assert.ok(check.relationshipsChanged > 0);`);
    assert.ok(loads.some(url => url.includes('/node_modules/@abaplint/')));
  } finally { f.cleanup(); }
});

test('a refresh imports the parser and removes deleted targets from unchanged ABAP callers', async () => {
  const f = await fixture();
  try {
    const loads = await f.probe(`const old = readGraph(wiringPath(out));
assert.ok(old.edges.some(edge => edge.relation === 'calls'));
rmSync(join(root, 'src/zcl_target.clas.abap'));
const refresh = await ensureFreshGraph(root, opts);
assert.equal(refresh.refreshed, true, refresh.note);
assert.ok(!readGraph(wiringPath(out)).edges.some(edge => edge.relation === 'calls'));
const reply = await callTool(root, 'graft_trace_calls', { symbol: 'ZCL_TARGET=>PING' }, out);
assert.match(reply.text, /Unresolved call references/);
assert.match(reply.text, /zcaller/i);
assert.equal((await checkGraph(root, opts)).ok, true);`);
    assert.equal(loads.filter(url => url.endsWith('/dist/graph/abap.js')).length, 1);
  } finally { f.cleanup(); }
});

test('deferred parser failure rejects build/check and retains every saved graph file on refresh', async () => {
  const f = await fixture();
  try {
    const before = f.saved();
    await f.probe(`await assert.rejects(buildGraph(root, opts), /ABAP analysis rejected.*fixture ABAP parser unavailable/);
const check = await checkGraph(root, opts);
assert.equal(check.ok, false);
assert.match(check.errors.join(' '), /fixture ABAP parser unavailable/);
writeFileSync(join(root, 'src/zcaller.prog.abap'), 'REPORT zcaller.\\n* force refresh\\n');
const refresh = await ensureFreshGraph(root, opts);
assert.equal(refresh.refreshed, false);
assert.match(refresh.note, /not verified current.*fixture ABAP parser unavailable/);`, 'fail');
    assert.deepEqual(f.saved(), before);
  } finally { f.cleanup(); }
});

for (const operation of ['build', 'check']) {
  test(`source changes during lazy parser import invalidate ${operation} and preserve the graph`, async () => {
    const f = await fixture();
    try {
      const before = f.saved();
      await f.probe(operation === 'build'
        ? `await assert.rejects(buildGraph(root, opts), /Source changed during analysis/);`
        : `const check = await checkGraph(root, opts); assert.equal(check.ok, false); assert.match(check.errors.join(' '), /Source changed during analysis/);`, 'mutate');
      assert.deepEqual(f.saved(), before);
    } finally { f.cleanup(); }
  });
}
