#!/usr/bin/env node
// Verify a freshly extracted package before installing dependencies or configuring it.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, safePath, included, REQUIRED } from './package-abap.mjs';

export function verifyPackage(root, manifestPath, archivePath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || manifest.fileCount !== manifest.files.length || manifest.prefix !== 'graft-abap/') throw new Error('Invalid package manifest');
  const expected = new Map();
  for (const entry of manifest.files) {
    if (!safePath(entry.path) || !included(entry.path) || expected.has(entry.path)
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid or duplicate manifest entry');
    expected.set(entry.path, entry);
  }
  for (const path of REQUIRED) if (!expected.has(path)) throw new Error(`Required source missing from manifest: ${path}`);
  const actual = [];
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (!safePath(path) || entry.isSymbolicLink()) throw new Error(`Unsafe package entry: ${path}`);
      if (entry.isDirectory()) {
        if (!manifest.files.some(file => file.path.startsWith(path + '/'))) throw new Error(`Unexpected package directory: ${path}`);
        walk(join(directory, entry.name), path + '/');
      } else if (entry.isFile()) actual.push(path);
      else throw new Error(`Unsupported package entry: ${path}`);
    }
  };
  if (lstatSync(root).isSymbolicLink()) throw new Error('Package root must not be a symbolic link');
  walk(root);
  if (actual.length !== expected.size) throw new Error('Package file count differs from manifest');
  for (const path of actual) {
    const entry = expected.get(path);
    if (!entry) throw new Error(`Unexpected package file: ${path}`);
    const data = readFileSync(join(root, path));
    if (data.length !== entry.size || sha256(data) !== entry.sha256) throw new Error(`Package content differs: ${path}`);
  }
  if (sha256(readFileSync(archivePath)) !== manifest.archiveSha256) throw new Error('ZIP checksum differs');
  return { ok: true, version: manifest.version, commit: manifest.commit, files: actual.length, archiveSha256: manifest.archiveSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--archive') throw new Error('Usage: node scripts/verify-abap-package.mjs --manifest /path/manifest.json --archive /path/package.zip');
    console.log(JSON.stringify(verifyPackage(resolve(dirname(fileURLToPath(import.meta.url)), '..'), args[1], args[3]), null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
