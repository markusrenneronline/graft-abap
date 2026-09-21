#!/usr/bin/env node
// Publish the committed package selection into a separate delivery repository.
// Commits and tags locally; never pushes.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage } from './package-abap.mjs';
import { verifyPackage } from './verify-abap-package.mjs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.stderr.toString('utf8')}`);
  return result.stdout;
}

export function publishPackage(repo, target) {
  repo = realpathSync.native(repo);
  if (!existsSync(join(target, '.git'))) throw new Error('Delivery target must be the root of a Git repository');
  target = realpathSync.native(target);
  const rel = relative(repo, target);
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) throw new Error('Delivery target must be outside the source repository');
  const back = relative(target, repo);
  if (!back || (!isAbsolute(back) && back !== '..' && !back.startsWith('..' + sep))) throw new Error('Delivery target must not contain the source repository');
  const git = (...args) => run('git', ['-C', target, ...args]).toString('utf8');
  if (git('status', '--porcelain').length) throw new Error('Delivery target has uncommitted or untracked files');
  const work = mkdtempSync(join(realpathSync.native(tmpdir()), 'graft-publish-'));
  try {
    const built = buildPackage(repo, join(work, 'package'));
    if (git('tag', '--list', built.version).trim()) throw new Error(`Tag already exists in delivery target: ${built.version}`);
    const manifest = JSON.parse(readFileSync(built.manifest, 'utf8'));
    const stage = join(work, 'stage'); mkdirSync(stage);
    // Tar, not ZIP: GNU tar (Git Bash) cannot unpack ZIP. `-f -` because bsdtar defaults to a tape device.
    const tar = run('git', ['-C', repo, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', built.commit, '--', ...manifest.files.map(file => file.path)]);
    run('tar', ['-xf', '-'], { cwd: stage, input: tar });
    verifyPackage(stage, built.manifest, built.archive);
    // Check before touching the target: evaluates the package's own .gitignore plus the
    // target's/global excludes against the staged tree, without modifying anything.
    const hidden = run('git', ['--git-dir', join(target, '.git'), '--work-tree', stage, 'ls-files', '--others', '--ignored', '--exclude-standard']).toString('utf8').trim();
    if (hidden) throw new Error(`Ignore rules (package .gitignore, global excludes or .git/info/exclude) hide package files: ${hidden.split('\n').join(', ')}`);
    // Only now touch the target. Ignored leftovers (node_modules, dist) go too: this is a delivery repository, not a workspace.
    for (const name of readdirSync(target)) if (name !== '.git') rmSync(join(target, name), { recursive: true, force: true });
    cpSync(stage, target, { recursive: true });
    writeFileSync(join(target, '.gitattributes'), '* -text\n');
    git('add', '-A');
    if (!git('status', '--porcelain').length) throw new Error('Delivery target already contains this package content');
    // Windows checkouts lose the executable bit; restore it from the manifest.
    for (const file of manifest.files) if (file.gitMode === '100755') git('update-index', '--chmod=+x', file.path);
    git('commit', '-q', '-m', `graft-abap ${built.version} (${built.commit.slice(0, 7)})`);
    git('tag', '-a', '-m', `graft-abap ${built.version}`, built.version);
    return { target, version: built.version, sourceCommit: built.commit, deliveryCommit: git('rev-parse', 'HEAD').trim(), fileCount: manifest.fileCount };
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 2 || args[0] !== '--to') throw new Error('Usage: node scripts/publish-abap.mjs --to /absolute/delivery-repository');
    console.log(JSON.stringify(publishPackage(resolve(dirname(fileURLToPath(import.meta.url)), '..'), resolve(args[1])), null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
