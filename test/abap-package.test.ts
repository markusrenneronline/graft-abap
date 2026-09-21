import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { REQUIRED, buildPackage, included, sha256 } from '../scripts/package-abap.mjs';
import { verifyPackage } from '../scripts/verify-abap-package.mjs';
import { smokeInstallation } from '../scripts/smoke-abap-install.mjs';

function fixture() {
  const parent = realpathSync.native(tmpdir());
  const base = realpathSync.native(mkdtempSync(join(parent, 'graft-package-test ')));
  const repo = join(base, 'source repo'); mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  const put = (path: string, body = `fixture ${path}\n`, root = repo) => {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body);
  };
  git('init', '-q');
  for (const path of REQUIRED) put(path);
  put('pilot/run.mjs', "const pilotVersion = '0.18.0-abap-test';\n");
  put('src/z.txt', 'source\n');
  put('pilot/config.json', '{"private":"must not ship"}');
  put('src/.env', 'private-test-value');
  put('.gitignore', 'node_modules/\nlocal/\n');
  git('add', '.'); git('commit', '-qm', 'Fixture');
  put('local/private.txt'); put('node_modules/private.txt');
  return { base, repo, git, put, clean() { assert.equal(dirname(base), parent); rmSync(base, { recursive: true, force: true }); } };
}

test('source package selects committed files, excludes local payloads and is reproducible', () => {
  const f = fixture();
  try {
    const a = buildPackage(f.repo, join(f.base, 'out a'));
    const b = buildPackage(f.repo, join(f.base, 'out b'));
    assert.equal(a.archiveSha256, b.archiveSha256);
    assert.equal(readFileSync(a.manifest, 'utf8'), readFileSync(b.manifest, 'utf8'));
    const manifest = JSON.parse(readFileSync(a.manifest, 'utf8'));
    assert.ok(manifest.files.some(file => file.path === 'src/z.txt'));
    for (const path of ['pilot/config.json', 'src/.env', 'local/private.txt', 'node_modules/private.txt']) assert.ok(!manifest.files.some(file => file.path === path), path);
    assert.ok(!readFileSync(a.manifest, 'utf8').includes(f.repo));
  } finally { f.clean(); }
});

test('actual Git ZIP file bytes match the manifest even with core.autocrlf enabled', () => {
  const f = fixture();
  try {
    f.git('config', 'core.autocrlf', 'true');
    const result = buildPackage(f.repo, join(f.base, 'out'));
    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'));
    const zip = readFileSync(result.archive);
    // Independently read the central directory of this small Git-created ZIP.
    // The fixture cannot exceed classic ZIP sizes; no external unzip tool needed.
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(end >= 0);
    const count = zip.readUInt16LE(end + 10);
    let offset = zip.readUInt32LE(end + 16);
    let checked = 0;
    for (let i = 0; i < count; i++) {
      assert.equal(zip.readUInt32LE(offset), 0x02014b50);
      const method = zip.readUInt16LE(offset + 10), size = zip.readUInt32LE(offset + 20);
      const nameLength = zip.readUInt16LE(offset + 28), extraLength = zip.readUInt16LE(offset + 30), commentLength = zip.readUInt16LE(offset + 32);
      const local = zip.readUInt32LE(offset + 42);
      const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      offset += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith('/')) continue;
      assert.equal(zip.readUInt32LE(local), 0x04034b50);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      assert.ok(method === 0 || method === 8);
      const body = method === 0 ? zip.subarray(start, start + size) : inflateRawSync(zip.subarray(start, start + size));
      const expected = manifest.files.find(file => 'graft-abap/' + file.path === name);
      assert.ok(expected, name); assert.equal(sha256(body), expected.sha256, name); checked++;
    }
    assert.equal(checked, manifest.fileCount);
    assert.equal(f.git('config', '--get', 'core.autocrlf').trim(), 'true', 'user config remains untouched');
  } finally { f.clean(); }
});

test('source package refuses dirty tracked files and uncommitted included source', () => {
  const f = fixture();
  try {
    f.put('src/z.txt', 'changed');
    assert.throws(() => buildPackage(f.repo, join(f.base, 'out')), /Commit tracked changes/);
    f.git('checkout', '--', 'src/z.txt'); f.put('src/new.txt');
    assert.throws(() => buildPackage(f.repo, join(f.base, 'out')), /untracked package source/);
  } finally { f.clean(); }
});

test('source package refuses output inside its repository and existing artifacts', () => {
  const f = fixture();
  try {
    assert.throws(() => buildPackage(f.repo, join(f.repo, 'release')), /outside/);
    buildPackage(f.repo, join(f.base, 'out'));
    assert.throws(() => buildPackage(f.repo, join(f.base, 'out')), /already exists/);
    for (const path of ['../secret', 'src/../secret', 'C:/secret', '/secret', 'src/.npmrc', 'src/.mcp.json']) assert.equal(included(path), false);
  } finally { f.clean(); }
});

test('source package ships the general skill but never client-local skill folders', () => {
  assert.equal(included('skill/graft-abap/SKILL.md'), true);
  assert.equal(included('skill'), false);
  assert.equal(included('.claude/skills/graft-abap/SKILL.md'), false);
  assert.ok(REQUIRED.includes('skill/graft-abap/SKILL.md'));
});

test('project-specific evaluation stays out of the source package', () => {
  assert.equal(included('pilot/evaluate-project.mjs'), false);
  assert.equal(included('pilot/evaluate-evidence.mjs'), true);
  // Content guard: project identifiers must not creep back into the shipped helper file.
  const helper = readFileSync(fileURLToPath(new URL('../pilot/evaluate-evidence.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(helper, /hrcore|casegen|zcl_/i);
});

test('package verification catches source tampering, extra files and archive tampering', () => {
  const f = fixture();
  try {
    const result = buildPackage(f.repo, join(f.base, 'out'));
    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'));
    const root = join(f.base, 'extracted'); mkdirSync(root);
    for (const entry of manifest.files) f.put(entry.path, f.git('show', `HEAD:${entry.path}`), root);
    assert.equal(verifyPackage(root, result.manifest, result.archive).ok, true);
    f.put('src/z.txt', 'tampered\n', root);
    assert.throws(() => verifyPackage(root, result.manifest, result.archive), /content differs/);
    f.put('src/z.txt', 'source\n', root); f.put('secret.txt', 'unexpected', root);
    assert.throws(() => verifyPackage(root, result.manifest, result.archive), /file count/);
    rmSync(join(root, 'secret.txt')); writeFileSync(result.archive, 'broken');
    assert.throws(() => verifyPackage(root, result.manifest, result.archive), /ZIP checksum/);
  } finally { f.clean(); }
});

test('package verification rejects path traversal in a supplied manifest', () => {
  const f = fixture();
  try {
    const result = buildPackage(f.repo, join(f.base, 'out'));
    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'));
    manifest.files[0].path = '../outside';
    writeFileSync(result.manifest, JSON.stringify(manifest));
    assert.throws(() => verifyPackage(f.repo, result.manifest, result.archive), /Invalid or duplicate/);
  } finally { f.clean(); }
});

test('installation smoke uses an external config, protected temporary export and actual stdio MCP', async () => {
  const result = await smokeInstallation();
  assert.equal(result.ok, true);
  assert.equal(result.existingConfigUnchanged, true);
  assert.equal(result.sourceUnchanged, true);
  assert.equal(result.mcp.traceParameters, 9);
});

test('pilot rejects missing config arguments and relative repository paths before building', () => {
  const f = fixture();
  try {
    const run = fileURLToPath(new URL('../pilot/run.mjs', import.meta.url));
    const missing = spawnSync(process.execPath, [run, '--config'], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /--config requires/);
    const config = join(f.base, 'relative.json');
    writeFileSync(config, JSON.stringify({ repository: '../relative', graphDirectory: 'graph', abapVersion: '7.50' }));
    const invalid = spawnSync(process.execPath, [run, '--config', config, 'build'], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /repository must be an absolute path/);
  } finally { f.clean(); }
});
