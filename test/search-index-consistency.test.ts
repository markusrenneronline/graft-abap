import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph } from '../src/graph/build.js';
import { ensureFreshGraph } from '../src/graph/refresh.js';
import { readGraph, wiringPath } from '../src/graph/write.js';
import { fingerprintPath } from '../src/graph/fingerprint.js';
import { invalidateGraphCaches } from '../src/graph/load.js';
import { askIndexPath, askIndexMatches, readAskIndex } from '../src/ask/index-file.js';
import { ask } from '../src/ask/ask.js';
import { checkGraph } from '../src/graph/check.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'graft-index-consistency-'));
  const out = join(root, 'graph');
  const source = join(root, 'entry.ts');
  const edit = (word: string) => writeFileSync(source, `export function entry() { return "${word}"; }\n`);
  edit('oldquartzword');
  return { root, out, edit, opts: { contextDir: out, graphOnly: true },
    cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test('same IDs with edited bodies reject old index and refresh repairs unchanged sources', async () => {
  const f = fixture();
  try {
    await buildGraph(f.root, f.opts);
    const old = readFileSync(askIndexPath(f.out));
    const oldIds = readGraph(wiringPath(f.out))!.nodes.map(n => n.id);
    f.edit('newamethystword'); await buildGraph(f.root, f.opts);
    const graph = readGraph(wiringPath(f.out))!;
    assert.deepEqual(graph.nodes.map(n => n.id), oldIds);
    writeFileSync(askIndexPath(f.out), old); invalidateGraphCaches(f.out);
    assert.equal(askIndexMatches(graph, readAskIndex(f.out)), false);
    const check = await checkGraph(f.root, { contextDir: f.out });
    assert.equal(check.ok, false); assert.equal(check.searchIndexStale, true);
    const stale = ask(f.root, 'oldquartzword', { contextDir: f.out });
    assert.equal(stale.hits.length, 0, 'old method-body vocabulary must not leak');
    assert.match(stale.note!, /method-body search is incomplete/);
    assert.equal((await ensureFreshGraph(f.root, { contextDir: f.out })).refreshed, true);
    assert.equal(askIndexMatches(graph, readAskIndex(f.out)), true);
    const repaired = ask(f.root, 'newamethystword', { contextDir: f.out });
    assert.ok(repaired.hits.length > 0); assert.doesNotMatch(repaired.note ?? '', /incomplete/);
  } finally { f.cleanup(); }
});

test('failed atomic index write preserves old graph, index and fingerprint, then recovers', async () => {
  const f = fixture();
  try {
    await buildGraph(f.root, f.opts);
    const paths = [wiringPath(f.out), askIndexPath(f.out), fingerprintPath(f.out)];
    const before = paths.map(p => readFileSync(p, 'utf8'));
    const blocker = `${askIndexPath(f.out)}.${process.pid}.tmp`;
    mkdirSync(blocker); f.edit('newamethystword');
    await assert.rejects(buildGraph(f.root, f.opts));
    assert.deepEqual(paths.map(p => readFileSync(p, 'utf8')), before);
    const skipped = await ensureFreshGraph(f.root, { contextDir: f.out });
    assert.equal(skipped.refreshed, false); assert.match(skipped.note!, /not verified current/);
    rmSync(blocker, { recursive: true });
    assert.equal((await ensureFreshGraph(f.root, { contextDir: f.out })).refreshed, true);
    assert.equal(askIndexMatches(readGraph(wiringPath(f.out))!, readAskIndex(f.out)), true);
  } finally { f.cleanup(); }
});

test('malformed token bags and duplicate IDs are rejected; missing index repairs automatically', async () => {
  const f = fixture();
  try {
    await buildGraph(f.root, f.opts);
    const good = JSON.parse(readFileSync(askIndexPath(f.out), 'utf8'));
    for (const modify of [
      (v: typeof good) => { v.docs[0].body = [['x', -1]]; },
      (v: typeof good) => { v.docs[0].body = [['x', 1], ['x', 2]]; },
      (v: typeof good) => { v.docs[0] = null; },
      (v: typeof good) => { v.docs[1].id = v.docs[0].id; },
    ]) {
      const broken = structuredClone(good); modify(broken);
      writeFileSync(askIndexPath(f.out), JSON.stringify(broken));
      assert.equal(readAskIndex(f.out), null);
    }
    rmSync(askIndexPath(f.out)); invalidateGraphCaches(f.out);
    assert.equal((await ensureFreshGraph(f.root, { contextDir: f.out })).refreshed, true);
    assert.equal(askIndexMatches(readGraph(wiringPath(f.out))!, readAskIndex(f.out)), true);
  } finally { f.cleanup(); }
});

test('partial deep checkpoints publish a matching index before processing the next file', async () => {
  const f = fixture();
  const previous = process.env.GRAFT_CRUX_CHECKPOINT_MS;
  process.env.GRAFT_CRUX_CHECKPOINT_MS = '0';
  try {
    writeFileSync(join(f.root, 'second.ts'), 'export function second() { return "checkpointtoken"; }');
    let calls = 0, checkpoints = 0;
    await buildGraph(f.root, { ...f.opts, concurrency: 1, summarizer: {
      async describeFile(input) {
        if (calls++) {
          const graph = readGraph(wiringPath(f.out)); assert.ok(graph?.meta.searchIndexKey);
          assert.equal(askIndexMatches(graph, readAskIndex(f.out)), true); checkpoints++;
        }
        return input.nodes.map(n => ({ id: n.id, summary: `Describes ${n.id}`, crux_start: 0, crux_end: 0 }));
      },
    } });
    assert.ok(checkpoints > 0);
  } finally {
    if (previous === undefined) delete process.env.GRAFT_CRUX_CHECKPOINT_MS; else process.env.GRAFT_CRUX_CHECKPOINT_MS = previous;
    f.cleanup();
  }
});
