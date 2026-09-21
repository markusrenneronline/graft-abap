import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { contentHash } from '../util/id.js';
import { readSourceFile } from '../util/source.js';
import { loadGraphCached } from './load.js';
import { listSourceFiles } from './source-files.js';
import { verifyExport } from './source-state.js';

/** Optional export contract, kept outside the read-only source repository. */
function policy(outDir: string): { sourceState?: string; onlyDirs?: string[] } {
  const path = join(outDir, '.graph', 'source-policy.json');
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.sourceState !== undefined && (typeof value.sourceState !== 'string' || !value.sourceState))
    || (value.onlyDirs !== undefined && (!Array.isArray(value.onlyDirs) || value.onlyDirs.some((v: unknown) => typeof v !== 'string' || !v)))) {
    throw new Error('Invalid source policy; refusing to bypass export protection');
  }
  return value;
}

export function sourceStatePath(outDir: string): string | undefined {
  return process.env.GRAFT_SOURCE_STATE || policy(outDir).sourceState;
}

export function sourceDirectories(outDir: string, explicit?: string[]): string[] | undefined {
  return explicit ?? policy(outDir).onlyDirs
    ?? loadGraphCached(outDir)?.meta?.indexedDirectories;
}

export function verifySourcePolicy(root: string, outDir: string, onlyDirs?: string[]): string | undefined {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Source repository unavailable: ${root}`);
  for (const dir of sourceDirectories(outDir, onlyDirs) ?? []) {
    if (!existsSync(resolve(root, dir))) throw new Error(`Indexed source directory unavailable: ${dir}; last valid graph retained`);
  }
  const statePath = sourceStatePath(outDir);
  return statePath ? verifyExport(root, statePath).generation : undefined;
}

/** An immutable set of decoded source bytes. Revalidate before publishing so a
 * file added, removed, unreadable or rewritten during analysis cannot be blessed
 * by a new freshness fingerprint. */
export class SourceSnapshot {
  readonly generation: string | undefined;
  readonly sources = new Map<string, string | null>();
  constructor(readonly root: string, readonly outDir: string, readonly onlyDirs?: string[]) {
    this.onlyDirs = sourceDirectories(outDir, onlyDirs);
    this.generation = verifySourcePolicy(root, outDir, this.onlyDirs);
  }
  record(path: string, source: string | null): void { this.sources.set(path, source === null ? null : contentHash(source)); }
  assertStable(): void {
    if (verifySourcePolicy(this.root, this.outDir, this.onlyDirs) !== this.generation) throw new Error('Export generation changed during analysis');
    const files = listSourceFiles(this.root, this.outDir, undefined, this.onlyDirs?.length ? new Set(this.onlyDirs) : undefined);
    if (files.length !== this.sources.size) throw new Error('Source file set changed during analysis; last valid graph retained');
    for (const path of files) {
      const source = readSourceFile(path);
      if (!this.sources.has(path) || this.sources.get(path) !== (source === null ? null : contentHash(source))) throw new Error(`Source changed during analysis: ${path}; last valid graph retained`);
    }
    if (verifySourcePolicy(this.root, this.outDir, this.onlyDirs) !== this.generation) throw new Error('Export generation changed before publication');
  }
}
