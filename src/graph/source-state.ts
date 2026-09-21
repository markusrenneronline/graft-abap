/** Export producer/consumer contract. This module deliberately depends only on
 * Node builtins so its compiled file can also accompany an export script. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ExportState {
  version: 1;
  root: string;
  generation: string;
  status: 'updating' | 'ready';
  files: Record<string, string>;
}

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const canonical = (path: string): string => {
  const result = realpathSync(path);
  return process.platform === 'win32' ? result.toLowerCase() : result;
};

/** Exact inventory, including files the graph does not index. Links are rejected
 * rather than allowing a source generation to escape its root. */
export function exportInventory(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (rel: string): void => {
    const abs = join(root, rel);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) throw new Error(`Export contains a symbolic link: ${rel}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(abs).sort()) visit(`${rel}/${name}`);
    } else if (stat.isFile()) files[rel] = hash(readFileSync(abs));
    else throw new Error(`Unsupported export entry: ${rel}`);
  };
  visit('src'); // missing src is never an intentional empty export
  return files;
}

function writeState(path: string, state: ExportState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
  renameSync(temp, path);
}

function readState(path: string, root: string): ExportState {
  const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!state || typeof state !== 'object') throw new Error('Invalid export state');
  const s = state as ExportState;
  if (s.version !== 1 || !['ready', 'updating'].includes(s.status) || typeof s.generation !== 'string'
    || !s.generation || s.root !== canonical(root) || !s.files || typeof s.files !== 'object' || Array.isArray(s.files)) {
    throw new Error('Invalid export state or repository mismatch');
  }
  for (const [path, value] of Object.entries(s.files)) {
    if (!path.startsWith('src/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')
      || typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid export manifest entry: ${path}`);
  }
  return s;
}

function assertInventory(state: ExportState, root: string): void {
  const actual = exportInventory(root);
  const expectedKeys = Object.keys(state.files).sort();
  const actualKeys = Object.keys(actual).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)
    || expectedKeys.some(path => actual[path] !== state.files[path])) {
    throw new Error('Export is incomplete or modified since its completed generation');
  }
}

export function beginExport(root: string, stagedRoot: string, statePath: string): ExportState {
  const outside = relative(resolve(root), resolve(statePath));
  if (!outside || (!outside.startsWith(`..${sep}`) && outside !== '..' && !isAbsolute(outside))) {
    throw new Error('Export state must be outside the source repository');
  }
  const files = exportInventory(stagedRoot);
  const state: ExportState = { version: 1, root: canonical(root), generation: randomUUID(), status: 'updating', files };
  writeState(statePath, state);
  return state;
}

export function completeExport(root: string, statePath: string, generation: string): void {
  const state = readState(statePath, root);
  if (state.status !== 'updating' || state.generation !== generation) throw new Error('Export generation changed before completion');
  assertInventory(state, root);
  writeState(statePath, { ...state, status: 'ready' });
}

/** Checks both inventory and producer state; a producer entering updating while
 * inventory is being read invalidates this observation. */
export function verifyExport(root: string, statePath: string): ExportState {
  const before = readState(statePath, root);
  if (before.status !== 'ready') throw new Error(`Export ${before.generation} is still updating; last valid graph retained`);
  assertInventory(before, root);
  const after = readState(statePath, root);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('Export generation changed while reading sources');
  return before;
}

// A standalone copy of the compiled module can accompany repo_sync.sh. No
// runtime dependency on the Graft installation or third-party Node packages.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, root, statePath, argument] = process.argv.slice(2);
    if (!root || !statePath) throw new Error('Usage: source-state begin ROOT STATE STAGED | complete ROOT STATE GENERATION | verify ROOT STATE');
    if (command === 'begin' && argument) console.log(beginExport(root, argument, statePath).generation);
    else if (command === 'complete' && argument) completeExport(root, statePath, argument);
    else if (command === 'verify') console.log(verifyExport(root, statePath).generation);
    else throw new Error('Invalid source-state command');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
