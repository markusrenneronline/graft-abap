import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REQUIRED, included } from '../scripts/package-abap.mjs';
import { publishPackage } from '../scripts/publish-abap.mjs';

function fixture() {
  const parent = realpathSync.native(tmpdir());
  const base = realpathSync.native(mkdtempSync(join(parent, 'graft-publish-test ')));
  const repo = join(base, 'source repo'), target = join(base, 'delivery repo');
  const gitIn = (root: string) => (...args: string[]) => {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  const put = (root: string, path: string, body = `fixture ${path}\n`) => {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body);
  };
  for (const root of [repo, target]) {
    mkdirSync(root); const git = gitIn(root);
    git('init', '-q');
    // publishPackage commits with the repository's own identity.
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false');
  }
  // This machine has a global core.autocrlf=true; without this the source repo's own
  // `git add` would normalize src/z.txt's CRLF line before publishPackage ever sees it.
  // The target repo keeps the global setting: its .gitattributes (`* -text`) must be
  // what prevents conversion there. The working-tree read of src/z.txt cannot show that
  // (cpSync copies bytes as-is either way); the committed-blob assertion is what proves it.
  gitIn(repo)('config', 'core.autocrlf', 'false');
  for (const path of REQUIRED) put(repo, path);
  put(repo, 'pilot/run.mjs', "const pilotVersion = '0.18.0-abap-test';\n");
  put(repo, 'src/z.txt', 'source\r\nwith crlf\n');
  put(repo, 'pilot/config.json', '{"private":"must not ship"}');
  put(repo, '.gitignore', 'node_modules/\nlocal/\n');
  gitIn(repo)('add', '.'); gitIn(repo)('commit', '-qm', 'Fixture');
  put(target, '.gitignore', 'node_modules/\n');
  put(target, 'old.txt', 'stale\n');
  gitIn(target)('add', '.'); gitIn(target)('commit', '-qm', 'Old delivery');
  return { base, repo, target, source: gitIn(repo), delivery: gitIn(target), put,
    clean() { assert.equal(dirname(base), parent); rmSync(base, { recursive: true, force: true }); } };
}

test('publish replaces the delivery content with the verified package, commits and tags', () => {
  const f = fixture();
  try {
    f.put(f.target, 'node_modules/x.js', 'leftover\n');
    const result = publishPackage(f.repo, f.target);
    assert.equal(result.version, '0.18.0-abap-test');
    const expected = f.source('ls-files').split('\n').filter(path => path && included(path)).concat('.gitattributes').sort();
    assert.deepEqual(f.delivery('ls-files').split('\n').filter(Boolean).sort(), expected);
    assert.equal(existsSync(join(f.target, 'old.txt')), false);
    assert.equal(existsSync(join(f.target, 'pilot/config.json')), false);
    assert.equal(existsSync(join(f.target, 'node_modules')), false);
    assert.equal(readFileSync(join(f.target, 'src/z.txt'), 'utf8'), 'source\r\nwith crlf\n');
    assert.equal(f.delivery('cat-file', 'blob', 'HEAD:src/z.txt'), 'source\r\nwith crlf\n');
    assert.equal(readFileSync(join(f.target, '.gitattributes'), 'utf8'), '* -text\n');
    assert.equal(f.delivery('status', '--porcelain'), '');
    assert.equal(f.delivery('tag', '--list').trim(), '0.18.0-abap-test');
    assert.equal(f.delivery('cat-file', '-t', '0.18.0-abap-test').trim(), 'tag');
    assert.match(f.delivery('log', '-1', '--format=%s').trim(), /^graft-abap 0\.18\.0-abap-test \([0-9a-f]{7}\)$/);
    assert.equal(f.delivery('rev-parse', 'HEAD').trim(), result.deliveryCommit);
  } finally { f.clean(); }
});

test('publish refuses a dirty delivery target and leaves it untouched', () => {
  const f = fixture();
  try {
    f.put(f.target, 'draft.txt', 'uncommitted\n');
    assert.throws(() => publishPackage(f.repo, f.target), /uncommitted or untracked/);
    assert.equal(readFileSync(join(f.target, 'old.txt'), 'utf8'), 'stale\n');
    assert.equal(readFileSync(join(f.target, 'draft.txt'), 'utf8'), 'uncommitted\n');
  } finally { f.clean(); }
});

test('publish refuses an already tagged version, a non-repository and a target inside the source', () => {
  const f = fixture();
  try {
    publishPackage(f.repo, f.target);
    const head = f.delivery('rev-parse', 'HEAD');
    assert.throws(() => publishPackage(f.repo, f.target), /Tag already exists/);
    assert.equal(f.delivery('rev-parse', 'HEAD'), head);
    assert.throws(() => publishPackage(f.repo, join(f.base, 'missing')), /root of a Git repository/);
    assert.throws(() => publishPackage(f.repo, f.repo), /outside the source repository/);
    assert.equal(spawnSync('git', ['-C', f.base, 'init', '-q'], { windowsHide: true }).status, 0);
    assert.throws(() => publishPackage(f.repo, f.base), /must not contain the source repository/);
    assert.equal(existsSync(join(f.repo, 'pilot/run.mjs')), true);
  } finally { f.clean(); }
});

test('publish refuses a package whose .gitignore hides package files and leaves the target untouched', () => {
  const f = fixture();
  try {
    f.put(f.repo, '.gitignore', 'node_modules/\nlocal/\nsrc/z.txt\n');
    f.source('commit', '-qam', 'Ignore a tracked file');
    const head = f.delivery('rev-parse', 'HEAD');
    assert.throws(() => publishPackage(f.repo, f.target), (error: unknown) => {
      assert.match(String(error), /hide package files/);
      assert.match(String(error), /src\/z\.txt/);
      return true;
    });
    assert.equal(readFileSync(join(f.target, 'old.txt'), 'utf8'), 'stale\n');
    assert.equal(f.delivery('status', '--porcelain'), '');
    assert.equal(f.delivery('rev-parse', 'HEAD'), head);
    assert.equal(f.delivery('tag', '--list').trim(), '');
  } finally { f.clean(); }
});
