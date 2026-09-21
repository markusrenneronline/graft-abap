/**
 * `graph.json` — the code graph schema (v1).
 *
 * One node per definition (file, class, function, method, interface, type, enum),
 * wired by edges (contains, imports, calls, ...). Field names follow the LSP
 * vocabulary (`name`, `kind`, ...) rather than any one tool's conventions.
 *
 * Two tiers of data live on a node:
 *   - Tier-1 (deterministic, $0): everything from the AST. Rebuilt on every run.
 *   - Tier-2 (one LLM call, cached on `body_hash`): `summary` + `crux`.
 * M1 populates Tier-1 only; Tier-2 fields ship as `pending`/null.
 */

/** What a node represents. LSP SymbolKind, narrowed to what our extractors produce. */
export type Kind =
  | "file"
  | "class"
  | "function"
  | "method"
  | "interface" // TS + Go
  | "type" // TS + Go (type alias / named type)
  | "enum" // TS + PHP + Java
  | "struct" // Go only
  | "trait" // PHP only
  // The generic (tags.scm) breadth tier also emits these — every tree-sitter
  // grammar's tags.scm uses the tree-sitter tags @definition.<X> vocabulary, and
  // module/constant/variable are common across the long tail (Ruby modules,
  // Rust consts, top-level lets, …). Kept distinct rather than coerced so the
  // breadth tier's kinds read truthfully in cards/skeleton.
  | "module"
  | "constant"
  | "variable";

/** How confident we are an edge is true, best-first. The hand-written AST
 * resolver assigns `extracted`/`inferred`; the opt-in LSP enrichment pass
 * (`graft build --lsp`) can promote an edge to compiler-grade `lsp_resolved`
 * (an exact server-confirmed target) or `lsp_dispatch` (an interface/virtual
 * candidate). Order matters: consumers that rank by provenance treat earlier
 * values as stronger. */
export type Confidence = "lsp_resolved" | "lsp_dispatch" | "extracted" | "inferred";

/** Whether the LLM meaning-layer has been computed for a node. */
export type SummaryState = "pending" | "ready" | "stale";

/** The LLM-chosen business-logic excerpt. `code` is the source of truth; `span`
 * is a best-effort pointer that may drift and is never used to re-slice. */
export interface Crux {
  code: string;
  span: string; // e.g. "L189-L196"
}

/** Verbatim source evidence, not a synthesized condition or runtime value. */
export interface SourceExcerptV1 {
  path: string;
  span: string;
  text: string;
}

/** Lexically enclosing control statement. ELSE/ELSEIF/WHEN may also carry the
 * preceding branch headers so their context is not mistaken for an unconditional call. */
export interface ControlContextV1 extends SourceExcerptV1 {
  kind: string;
  priorBranches?: SourceExcerptV1[];
}

export interface EarlierExitV1 extends SourceExcerptV1 {
  kind: "RETURN" | "EXIT" | "CHECK";
  effect: "processing_block" | "loop_exit" | "loop_iteration";
  controls?: ControlContextV1[];
}

export interface AbapParameterV1 {
  name: string;
  direction: string;
  defaultValue?: string;
}

export interface LocalAssignmentV1 extends SourceExcerptV1 {
  variable: string;
  controls?: ControlContextV1[];
  /** Absent on older evidence means a direct assignment. Output writes are
   * identified syntactically; success and returned values are not evaluated. */
  kind?: "direct" | "call_output";
  output?: { direction: "IMPORTING" | "CHANGING" | "RECEIVING" | "TABLES"; parameter?: string };
  /** Earlier lexical candidates outside the latest assignment's controls.
   * This is source history, not a complete set of reaching definitions. */
  priorAssignments?: LocalAssignmentV1[];
}

export type CallExecution = 'callback' | 'async' | 'update_task' | 'background_task' | 'background_unit' | 'on_commit' | 'on_rollback';

export interface CallSiteV1 extends SourceExcerptV1 {
  /** Explicit asynchronous/deferred invocation or callback registration.
   * Absence preserves older graph semantics; it is not proof of synchronous execution. */
  execution?: CallExecution;
  /** Static receiver type and source. An absent basis preserves pilot.12's
   * RETURNING meaning. CAST success and runtime subtypes are not inferred. */
  receiverType?: { name: string; source: SourceExcerptV1; basis?: 'returning' | 'new' | 'cast' | 'inline_returning' | 'inline_cast' | 'declaration' | 'inline_catch' | 'inherited_attribute'; inlineDeclaration?: SourceExcerptV1; via?: SourceExcerptV1[] };
  /** NEW or CREATE OBJECT construction, distinct from following method calls. Implicit
   * forwarding selects a known base constructor without synthesizing nodes. */
  construction?: { className: string; implicitForwarding: boolean;
    /** NEW # typed from a direct assignment's independently declared target. */
    inferredType?: { target: string; source: SourceExcerptV1; inlineDeclaration?: SourceExcerptV1; via?: SourceExcerptV1[] } };
  controls?: ControlContextV1[];
  earlierExits?: EarlierExitV1[];
  /** Direct named actual arguments for this invocation only. Unknown/positional
   * forms leave argumentsComplete false, so defaults cannot be assumed omitted. */
  arguments?: Record<string, string>;
  argumentsComplete?: boolean;
  /** Simple parameters known not to be written before this invocation in the
   * enclosing method. Absence means unknown, never unchanged. */
  unchangedParameters?: string[];
  localAssignments?: LocalAssignmentV1[];
  /** Invocation token position within the full statement excerpt; distinguishes
   * repeated/nested calls on the same source line. One based. */
  occurrence?: { line: number; column: number };
}

export interface NodeV1 {
  // identity
  id: string; // path-scoped: "src/cache.ts#Cache.get"
  name: string; // the symbol's own name: "get"
  kind: Kind;
  // method nodes only: the bare name of the immediate enclosing class/receiver
  // ("Cache" for "get"). Lets owner-qualified lookups (resolve.ts's ownerMethod
  // index) key off a stored field instead of re-deriving it by slicing `id`,
  // which breaks once ids can carry a dedup ordinal (`Cache.get~2`).
  owner?: string;

  // location (Tier-1, deterministic)
  path: string; // repo-relative: "src/cache.ts"
  span: string; // whole definition: "L165-L222"
  signature: string | null; // "get(k: string): number" — null for kind:"file"
  /** Original declaration, including parameter defaults, when separate from implementation. */
  declaration?: SourceExcerptV1;
  abapParameters?: AbapParameterV1[];
  exported: boolean;
  // How the node was extracted. "ast" = a first-class hand-written extractor
  // (TS/JS/Python/Go, full-fidelity). "generic" = the tags.scm breadth tier
  // (signature-only; symbols + bare edges, no scope-aware binding).
  origin: "ast" | "generic";
  body_hash: string; // sha256 of the definition text; the Tier-2 re-run trigger
  chars?: number; // byte length of the WHOLE file (file nodes only); the baseline
  //                 `ask` uses to estimate tokens saved vs reading the file whole
  body_text?: string; // searchable whitespace-normalized definition body (Tier-1,
  //                 symbol nodes only, capped). Ranks `ask` queries so a term in
  //                 the code — not just the name/signature — is findable; never
  //                 emitted to the agent (that reads verbatim source via `--source`).
  //                 Absent on file nodes and on graphs built before this field.
  arity?: number; // declared parameter count (method/constructor nodes). Disambiguates
  //                 OVERLOADS, which only Java has among the languages parsed here: two
  //                 same-named methods on one class are otherwise separable only by
  //                 arity, and picking the wrong one turns a delegating overload into a
  //                 self-loop. Absent on graphs built before this field, and on
  //                 languages that do not emit it — resolution then behaves as before.
  variadic?: boolean; // the last parameter is a vararg (`String... xs`), so the declared
  //                 arity is a MINIMUM, not an equality. Never arity-filtered out.

  // meaning (Tier-2, one LLM call)
  summary_state: SummaryState;
  summary: string | null;
  crux: Crux | null;
}

export type Relation =
  | "contains" // file → symbol, class → method (structural)
  | "calls" // function → function it invokes
  | "imports" // file → module
  | "references" // symbol → symbol it names but doesn't call
  | "implements" // TS: class → interface
  | "extends"; // class → base class

export interface EdgeV1 {
  source: string; // node id
  target: string; // node id, or an unresolved module string for imports
  relation: Relation;
  confidence: Confidence;
  /** All distinct known source occurrences for this edge; absent in older graphs. */
  callSites?: CallSiteV1[];
}

/** A ranking scope: a sub-project discovered by project-marker files (`package.json`,
 * `go.mod`, ...). `prefix` is a posix path relative to the graph root ("" = root scope);
 * `label` is the same value without a trailing slash (also "" for root); `markers` lists
 * which marker file(s) were found in that directory. See `src/graph/scopes.ts`. */
export interface ScopeV1 {
  prefix: string;
  label: string;
  markers: string[];
}

/** A syntactically recorded call with no uniquely resolved local target. It is
 * deliberately separate from edges and never makes a runtime reachability claim. */
export interface UnresolvedCallV1 {
  id: string;
  source: string;
  targetName: string;
  targetKind: 'method' | 'function' | 'form' | 'program' | 'transaction';
  reason: 'missing_or_ambiguous' | 'missing_target' | 'ambiguous_target' | 'resolution_incomplete' | 'unresolved_receiver' | 'remote' | 'dynamic_target' | 'missing_transaction_metadata';
  site: CallSiteV1;
}

export interface GraphV1 {
  meta: {
    version: 1;
    nodeCount: number;
    edgeCount: number;
    languages: string[];
    /** Ranking scopes: posix path prefixes relative to the graph root, "" = root scope.
     * Absent (old graphs) ≡ [{ prefix: "", label: "" }]. Sorted by prefix length desc. */
    scopes?: ScopeV1[];
    /** Retain the source scope even when an extractor upgrade invalidates caches. */
    indexedDirectories?: string[];
    /** Content identity shared with the lexical index; absent in old graphs. */
    searchIndexKey?: string;
  };
  nodes: NodeV1[];
  edges: EdgeV1[];
  unresolvedCalls?: UnresolvedCallV1[];
  /** Co-published with the graph so warnings never refer to a different build. */
  abap?: { files: number; diagnostics: AbapDiagnosticV1[] };
}

export interface AbapDiagnosticV1 {
  path: string;
  line?: number;
  /** One-based token column when a diagnostic records a particular occurrence. */
  column?: number;
  kind: string;
  message: string;
  /** Original source line captured with the diagnostic, not loaded during queries. */
  source?: SourceExcerptV1;
}
