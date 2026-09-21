import { ABAPObject, Config, MemoryFile, Registry, Version } from '@abaplint/core';
import { contentHash } from '../util/id.js';

export interface AbapParseStats { parsedObjects: number; reusedObjects: number; parsedFiles: number; reusedFiles: number; }

/** Registry owns object-level parsed ASTs. We reuse only that syntax, never
 * resolved Graft edges, bindings, parameters or source evidence. All semantic
 * passes in abap.ts run again against the current global symbol set. */
export class AbapParseSession {
  private registry = new Registry(Config.getDefault(Version.v750));
  private hashes = new Map<string, string>();
  private hadMacros = false;
  stats: AbapParseStats = { parsedObjects: 0, reusedObjects: 0, parsedFiles: 0, reusedFiles: 0 };
  notices: string[] = [];

  parse(sources: Map<string, string>): Registry {
    this.notices = [];
    try {
      const actualFiles = new Map([...this.registry.getFiles()].map(f => [f.getFilename(), f]));
      let changed = false;
      for (const [path, file] of actualFiles) {
        if (!sources.has(path)) { this.registry.removeFile(file); changed = true; }
      }
      const hashes = new Map<string, string>();
      for (const [path, source] of sources) {
        const hash = contentHash(source);
        hashes.set(path, hash);
        if (hash === this.hashes.get(path)) continue;
        const file = new MemoryFile(path, source);
        if (actualFiles.has(path)) this.registry.updateFile(file);
        else this.registry.addFile(file);
        changed = true;
      }
      // Cross-include macro expansion mutates statements in other objects. Until
      // that dependency set is modeled, invalidate all ASTs in macro projects
      // on edits, including removal of the last macro definition.
      const hasMacros = [...sources.values()].some(source => /\bDEFINE\b/i.test(source));
      const objects = [...this.registry.getObjects()].filter(ABAPObject.is);
      if (changed && (hasMacros || this.hadMacros)) for (const object of objects) object.setDirty();
      this.stats = { parsedObjects: 0, reusedObjects: 0, parsedFiles: 0, reusedFiles: 0 };
      for (const object of objects) {
        const files = object.getFiles().filter(file => file.getFilename().toLowerCase().endsWith('.abap')).length;
        if (object.isDirty()) { this.stats.parsedObjects++; this.stats.parsedFiles += files; }
        else { this.stats.reusedObjects++; this.stats.reusedFiles += files; }
      }
      try { this.registry.parse(); }
      catch (error) {
        // Registry.parse also runs an optional global type pass (e.g. incomplete
        // SAP DDIC metadata). Graft uses its own resolver, not those inferred
        // types. Accept that failure only after every object's exact syntax has
        // been parsed, and never after cross-object macro expansion may fail.
        const syntaxComplete = objects.every(object => !object.isDirty() && object.getFiles()
          .filter(file => file.getFilename().endsWith('.abap'))
          .every(file => object.getABAPFiles().some(parsed => parsed.getFilename() === file.getFilename() && parsed.getRaw() === file.getRaw())));
        if (!syntaxComplete || hasMacros || this.hadMacros) throw error;
        this.notices.push(`Optional abaplint type enrichment unavailable; syntax retained and Graft resolution used: ${String(error)}`);
      }
      this.hashes = hashes;
      this.hadMacros = hasMacros;
      return this.registry;
    } catch (error) {
      // Never reuse partially mutated parser state after a failed parse.
      this.registry = new Registry(Config.getDefault(Version.v750));
      this.hashes.clear();
      this.hadMacros = false;
      throw error;
    }
  }
}

// Bounded per-process cache for long-lived MCP servers; separate projects and
// graph directories never share a mutable Registry. CLI cold starts parse once.
const sessions = new Map<string, AbapParseSession>();
export function abapParseSession(key: string, reuse = true): AbapParseSession {
  if (!reuse) { sessions.delete(key); return new AbapParseSession(); }
  const session = sessions.get(key) ?? new AbapParseSession();
  sessions.delete(key);
  sessions.set(key, session);
  if (sessions.size > 4) sessions.delete(sessions.keys().next().value!);
  return session;
}
