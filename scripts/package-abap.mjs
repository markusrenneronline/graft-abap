#!/usr/bin/env node
// Offline source distribution from committed blobs; never copies a working directory.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const topFiles = new Set(['package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', 'LICENSE', 'CREDITS.md',
  'README.md', 'README-GRAFT.md', 'TELEMETRY.md', 'SECURITY.md', 'INSTALL-ABAP.md', 'ABAP-EXECUTION.md', 'ABAP-RETURN-CHAINS.md', 'ABAP-OBJECT-EXPRESSIONS.md', 'ABAP-DIAGNOSTICS.md', 'ABAP-BENEFIT-EVALUATION.md']);
const pilotFiles = new Set(['pilot/run.mjs', 'pilot/doctor.mjs', 'pilot/evaluate-evidence.mjs', 'pilot/config.example.json', 'pilot/claude-mcp.example.json']);
export const REQUIRED = ['package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'CREDITS.md', 'INSTALL-ABAP.md',
  'src/graph/abap.ts', 'viewer/tsconfig.json', 'scripts/build-viewer.mjs', 'scripts/package-abap.mjs', 'scripts/publish-abap.mjs', 'scripts/verify-abap-package.mjs',
  'scripts/smoke-abap-install.mjs', 'pilot/run.mjs', 'pilot/doctor.mjs', 'pilot/config.example.json', 'pilot/evaluate-evidence.mjs',
  'skill/graft-abap/SKILL.md'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !/[\\:\x00-\x1f]/.test(path)
    && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..');
}
export function included(path) {
  if (!safePath(path)) return false;
  const parts = path.split('/');
  if (parts.some(part => part.startsWith('.env') || ['node_modules', 'dist', '.git', '.graft', '.claude', '.codex', '.cursor', '.mcp.json', '.npmrc', 'archive', 'local'].includes(part))) return false;
  return topFiles.has(path) || pilotFiles.has(path) || ['src', 'test', 'scripts', 'viewer', 'assets', 'skill'].includes(parts[0]) && parts.length > 1;
}
function git(repo, args, input) {
  const result = spawnSync('git', ['-C', repo, ...args], { input, windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.error ?? result.stderr.toString('utf8')}`);
  return result.stdout;
}
function physical(path) {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return join(physical(parent), path.slice(parent.length).replace(/^[/\\]+/, ''));
}
export function buildPackage(repo, destination) {
  repo = realpathSync.native(repo);
  destination = physical(resolve(destination));
  const rel = relative(repo, destination);
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) throw new Error('Package output must be outside the source repository');
  if (git(repo, ['status', '--porcelain', '--untracked-files=no']).length) throw new Error('Commit tracked changes before packaging');
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
  if (untracked.some(included)) throw new Error('Commit or remove untracked package source files before packaging');
  const commit = git(repo, ['rev-parse', 'HEAD']).toString('utf8').trim();
  const rows = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t');
    const [mode, type, oid] = row.slice(0, tab).split(' ');
    return { path: row.slice(tab + 1), mode, type, oid };
  }).filter(row => included(row.path)).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const row of rows) if (row.type !== 'blob' || !['100644', '100755'].includes(row.mode)) throw new Error(`Unsupported package entry: ${row.path}`);
  const names = new Set(rows.map(row => row.path));
  if (new Set(rows.map(row => row.path.toLowerCase())).size !== rows.length) throw new Error('Case-colliding package paths');
  for (const path of REQUIRED) if (!names.has(path)) throw new Error(`Missing required package source: ${path}`);
  const payload = git(repo, ['cat-file', '--batch'], rows.map(row => row.oid).join('\n') + '\n');
  let offset = 0;
  const bodies = new Map();
  const files = rows.map(row => {
    const end = payload.indexOf(10, offset);
    const [oid, type, length] = payload.subarray(offset, end).toString('ascii').split(' ');
    if (oid !== row.oid || type !== 'blob' || !/^\d+$/.test(length)) throw new Error('Unexpected git blob response');
    const size = Number(length);
    const data = payload.subarray(end + 1, end + 1 + size);
    if (data.length !== size || payload[end + 1 + size] !== 10) throw new Error('Truncated git blob response');
    offset = end + 2 + size;
    bodies.set(row.path, data);
    return { path: row.path, size, sha256: sha256(data), gitMode: row.mode };
  });
  const version = bodies.get('pilot/run.mjs').toString('utf8').match(/const pilotVersion = '([^']+)'/)?.[1];
  if (!version || !/^[a-zA-Z0-9._-]+$/.test(version)) throw new Error('Missing or invalid pilot version');
  const filename = `graft-abap-${version}-${commit.slice(0, 7)}`;
  const archive = join(destination, `${filename}.zip`);
  const manifest = join(destination, `${filename}.manifest.json`);
  if (existsSync(archive) || existsSync(manifest)) throw new Error('Package already exists; refusing to overwrite');
  // `git archive` otherwise applies core.autocrlf on Windows, while the manifest
  // describes committed blob bytes. Never change the user's Git configuration.
  const zip = git(repo, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=zip', '--prefix=graft-abap/', commit, '--', ...files.map(f => f.path)]);
  const inventory = { format: 1, version, commit, prefix: 'graft-abap/', archiveName: `${filename}.zip`,
    archiveSha256: sha256(zip), fileCount: files.length, files,
    scope: 'Source only. No dependencies, build output, local configuration, graph or SAP export. Checksums are not a publisher signature.' };
  mkdirSync(destination, { recursive: true });
  writeFileSync(archive, zip, { flag: 'wx' });
  writeFileSync(manifest, JSON.stringify(inventory, null, 2) + '\n', { flag: 'wx' });
  return { archive, manifest, version, commit, fileCount: files.length, archiveSha256: inventory.archiveSha256, bytes: zip.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 2 || args[0] !== '--out') throw new Error('Usage: node scripts/package-abap.mjs --out /absolute/output-directory');
    console.log(JSON.stringify(buildPackage(resolve(dirname(fileURLToPath(import.meta.url)), '..'), args[1]), null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
