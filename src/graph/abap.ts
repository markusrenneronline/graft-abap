/**
 * Deterministic ABAP pilot extractor. abaplint supplies the statement/expression
 * AST (including chain expansion); this is deliberately not a SAP compiler or
 * a complete where-used index. Unresolved/dynamic relationships are reported,
 * never guessed from a globally unique method name.
 */
import { ABAPObject, BuiltIn, Config, Expressions, MemoryFile, Nodes, Registry, Release, releaseAtLeast, Version, type ABAPFile } from "@abaplint/core";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { posix } from "node:path";
import { contentHash } from "../util/id.js";
import { localAssignmentsBeforeCall } from "./abap-assignments.js";
import { AbapParseSession } from "./abap-parse-cache.js";
import type { AbapDiagnosticV1, UnresolvedCallV1 } from "./types.js";
import type { AbapParameterV1, CallExecution, CallSiteV1, ControlContextV1, EarlierExitV1, EdgeV1, Kind, NodeV1, Relation, SourceExcerptV1 } from "./types.js";

export type AbapDiagnostic = AbapDiagnosticV1;

export interface AbapExtraction {
  nodes: NodeV1[];
  edges: EdgeV1[];
  diagnostics: AbapDiagnostic[];
  unresolvedCalls: UnresolvedCallV1[];
}

type Statement = ReturnType<ABAPFile["getStatements"]>[number];
type Expression = Nodes.ExpressionNode;
// A present null binding is a declaration with an unknown static type. It masks
// outer declarations and must never be treated like an absent binding.
type Bindings = Map<string, string | null>;
interface ParsedFile { path: string; source: string; group: string; objectName: string; statements: readonly Statement[]; lineOffsets?: number[] }
interface Definition {
  node: NodeV1;
  declaration?: SourceExcerptV1;
  group: string;
  global: boolean;
  base?: string;
  interfaces: string[];
  aliases: Map<string, string>;
  missingDeclaration?: boolean;
  methods: Map<string, Method>;
  bindings: Bindings;
  attributes: Map<string, { statement: Statement; visibility: string }>;
  localTypes: Set<string>;
}
interface ReturnDeclaration { type?: string; owner: Definition; source: SourceExcerptV1 }
interface Method { node: NodeV1; declaration?: string; definition: Definition; implemented: boolean; returning?: ReturnDeclaration; redefinition?: boolean }
interface Scope { node: NodeV1; file: ParsedFile; start: number; end: number; owner?: Definition; bindings: Bindings; localTypes: Set<string>; simpleParameters?: string[] }

const norm = (s: string): string => s.toUpperCase();
const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
const searchable = (s: string): string => clean(s).slice(0, 12_000);
const abap750Builtins = new Set(Object.entries(BuiltIn.methods)
  .filter(([, method]) => !method.release || releaseAtLeast(Release.v750, method.release)).map(([name]) => name));
const text = (s: Statement | Expression): string => s.concatTokens();
const tag = (s: Statement): string => s.get().constructor.name;
const line = (s: Statement): number => s.getFirstToken().getRow();
const endLine = (s: Statement): number => s.getLastToken().getRow();
const tokens = (s: Statement | Expression): string[] => s.getTokens().map(t => t.getUpperStr());
const expressionText = (s: Statement | Expression, type: Parameters<Statement["findFirstExpression"]>[0]): string | undefined => {
  const e = s.findFirstExpression(type);
  return e ? norm(e.concatTokens().replace(/\s+/g, "")) : undefined;
};

function groupOf(path: string): string {
  const match = posix.basename(path).match(/^(.+?)\.(clas|intf|prog|fugr)\./i);
  return match ? `${posix.dirname(path)}/${match[1].toUpperCase()}.${match[2].toUpperCase()}` : path;
}

/** Token positions are one based, with an exclusive end column. */
function sourceSlice(file: ParsedFile, first: Statement | Expression, last: Statement | Expression): string {
  const source = file.source;
  if (!file.lineOffsets) {
    file.lineOffsets = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === "\n") file.lineOffsets.push(i + 1);
  }
  const offsets = file.lineOffsets;
  const start = first.getFirstToken().getStart();
  const end = last.getLastToken().getEnd();
  return source.slice(offsets[start.getRow() - 1] + start.getCol() - 1, offsets[end.getRow() - 1] + end.getCol() - 1);
}

function sourceExcerpt(file: ParsedFile, statement: Statement, first: Statement | Expression = statement): SourceExcerptV1 {
  return { path: file.path, span: `L${first.getFirstToken().getRow()}-L${endLine(statement)}`, text: sourceSlice(file, first, statement) };
}

/** Internal positions distinguish statements/calls on the same line; the public
 * evidence remains a verbatim full statement rather than a synthesized call. */
function occurrenceKey(file: ParsedFile, statement: Statement, invocation: Statement | Expression = statement): string {
  const position = (value: Statement | Expression): string => `${String(value.getFirstToken().getRow()).padStart(10, "0")}:${String(value.getFirstToken().getCol()).padStart(10, "0")}`;
  return `${file.path}\0${position(statement)}\0${position(invocation)}`;
}

interface ControlFrame {
  family: "IF" | "CASE" | "LOOP" | "WHILE" | "DO" | "SELECT" | "PROVIDE" | "TRY";
  head: ControlContextV1;
  branch?: ControlContextV1;
  branches: SourceExcerptV1[];
}

const PROCESSING_BOUNDARIES = new Set(["MethodImplementation", "EndMethod", "Form", "EndForm", "FunctionModule", "EndFunction", "Module", "EndModule", "StartOfSelection", "EndOfSelection", "Initialization", "LoadOfProgram", "AtSelectionScreen", "AtLineSelection", "AtUserCommand", "AtPF", "TopOfPage", "EndOfPage", "Get", "GetLate"]);
const LOOP_CONTEXTS = new Set(["LOOP", "WHILE", "DO", "SELECT", "PROVIDE"]);

/** A lexical header stack, not a CFG: it does not prove reachability, account for
 * earlier exits, evaluate predicates, or turn TRY/CATCH into guards. */
function controlEvidence(file: ParsedFile, scopeFor: (index: number) => Scope): Map<Statement, ControlContextV1[]> {
  const result = new Map<Statement, ControlContextV1[]>();
  let stack: ControlFrame[] = [];
  let previousScope: Scope | undefined;
  const starts: Record<string, ControlFrame["family"]> = { If: "IF", Case: "CASE", Loop: "LOOP", While: "WHILE", Do: "DO", SelectLoop: "SELECT", Provide: "PROVIDE", Try: "TRY" };
  const ends: Record<string, ControlFrame["family"]> = { EndIf: "IF", EndCase: "CASE", EndLoop: "LOOP", EndWhile: "WHILE", EndDo: "DO", EndSelect: "SELECT", EndProvide: "PROVIDE", EndTry: "TRY" };
  const branches: Record<string, ControlFrame["family"]> = { ElseIf: "IF", Else: "IF", When: "CASE", WhenOthers: "CASE", Catch: "TRY", Cleanup: "TRY" };
  const contexts = (frames: ControlFrame[]): ControlContextV1[] => frames.flatMap(frame => frame.family === "IF"
    ? [frame.branch ?? frame.head]
    : [frame.head, ...(frame.branch ? [frame.branch] : [])]);
  const frameIndex = (family: ControlFrame["family"]): number => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].family === family) return i;
    return -1;
  };
  for (let i = 0; i < file.statements.length; i++) {
    const statement = file.statements[i];
    const scope = scopeFor(i);
    const kind = tag(statement);
    if (scope !== previousScope || PROCESSING_BOUNDARIES.has(kind)) stack = [];
    previousScope = scope;
    const end = ends[kind];
    if (end) {
      const index = frameIndex(end);
      if (index >= 0) stack.splice(index);
    }
    const branch = branches[kind];
    const index = branch ? frameIndex(branch) : -1;
    if (index >= 0) {
      stack.splice(index + 1);
      const frame = stack[index];
      // A function called while evaluating a branch header is not inside the
      // body guarded by that same header. CASE/TRY remain outer lexical context.
      result.set(statement, [...contexts(stack.slice(0, index)), ...(branch === "IF" ? [] : [frame.head])]);
      const excerpt = sourceExcerpt(file, statement);
      frame.branch = { ...excerpt, kind: kind === "WhenOthers" ? "WHEN OTHERS" : norm(kind), ...(frame.branches.length ? { priorBranches: [...frame.branches] } : {}) };
      frame.branches.push(excerpt);
    } else result.set(statement, contexts(stack));
    const start = starts[kind];
    if (start) {
      const excerpt = sourceExcerpt(file, statement);
      stack.push({ family: start, head: { ...excerpt, kind: start }, branches: start === "IF" ? [excerpt] : [] });
    }
  }
  return result;
}

/** Source-order evidence only: earlier exits in mutually exclusive branches are
 * retained as evidence too. This does not imply an exit is reached or that the
 * later call is unreachable. Prefix arrays are shared until another exit occurs. */
function earlierExitEvidence(file: ParsedFile, scopeFor: (index: number) => Scope, controls: Map<Statement, ControlContextV1[]>): Map<Statement, EarlierExitV1[]> {
  const result = new Map<Statement, EarlierExitV1[]>();
  let earlier: EarlierExitV1[] = [];
  let previousScope: Scope | undefined;
  for (let i = 0; i < file.statements.length; i++) {
    const statement = file.statements[i];
    const scope = scopeFor(i);
    const statementKind = tag(statement);
    if (scope !== previousScope || PROCESSING_BOUNDARIES.has(statementKind)) earlier = [];
    previousScope = scope;
    result.set(statement, earlier);
    if (!["Return", "Exit", "Check"].includes(statementKind)) continue;
    const context = controls.get(statement) ?? [];
    const inLoop = context.some(control => LOOP_CONTEXTS.has(control.kind));
    const kind = norm(statementKind) as EarlierExitV1["kind"];
    const effect: EarlierExitV1["effect"] = kind === "RETURN" || !inLoop ? "processing_block" : kind === "EXIT" ? "loop_exit" : "loop_iteration";
    earlier = [...earlier, { ...sourceExcerpt(file, statement), kind, effect, ...(context.length ? { controls: context } : {}) }];
  }
  return result;
}

function declarationParameters(file: ParsedFile, statement: Statement): { parameters: AbapParameterV1[]; simple: string[] } {
  const parameters: AbapParameterV1[] = [];
  const simple: string[] = [];
  const simpleTypes = new Set(["ABAP_BOOL", "C", "I", "STRING", "INT8", "N", "D", "T", "F", "P", "X", "XSTRING", "DECFLOAT16", "DECFLOAT34"]);
  const groups: [Parameters<Statement["findDirectExpression"]>[0], string][] = [[Expressions.MethodDefImporting, "IMPORTING"], [Expressions.MethodDefExporting, "EXPORTING"], [Expressions.MethodDefChanging, "CHANGING"], [Expressions.MethodDefReturning, "RETURNING"]];
  for (const [expression, direction] of groups) {
    const group = statement.findDirectExpression(expression);
    if (!group) continue;
    const declarations = direction === "RETURNING" ? [group] : group.findAllExpressionsRecursive(Expressions.MethodParam);
    for (const declaration of declarations) {
      const name = expressionText(declaration, Expressions.MethodParamName);
      if (!name) continue;
      const defaultExpression = declaration.findFirstExpression(Expressions.Default)?.getChildren().find(child => child instanceof Nodes.ExpressionNode) as Expression | undefined;
      parameters.push({ name, direction, ...(defaultExpression ? { defaultValue: sourceSlice(file, defaultExpression, defaultExpression) } : {}) });
      const type = declaration.findFirstExpression(Expressions.TypeParam);
      const ts = type ? tokens(type) : [];
      if (direction === "IMPORTING" && ts[0] === "TYPE" && simpleTypes.has(ts[1])) simple.push(name);
    }
  }
  return { parameters, simple };
}

/** Visit only argument-list containers; stop at each argument's value. Recursing
 * into Source would incorrectly attribute nested invocation arguments to outer calls. */
function invocationArguments(file: ParsedFile, root?: Expression): Pick<CallSiteV1, "arguments" | "argumentsComplete"> {
  const actuals: Record<string, string> = {};
  let complete = true;
  const containers = new Set(["MethodCallParam", "MethodCallBody", "MethodParameters", "FunctionParameters", "ParameterListS", "ParameterListT", "FunctionExporting", "FunctionImporting", "FunctionChanging", "FunctionTables"]);
  const entries = new Set(["ParameterS", "ParameterT", "FunctionExportingParameter", "FunctionTableParameter"]);
  const keywords = new Set(["(", ")", "EXPORTING", "IMPORTING", "CHANGING", "RECEIVING", "TABLES", "EXCEPTIONS"]);
  const visit = (expression: Expression): void => {
    const kind = expression.get().constructor.name;
    if (entries.has(kind)) {
      const name = expressionText(expression, Expressions.ParameterName);
      const value = expression.findDirectExpression(Expressions.Source) ?? expression.findDirectExpression(Expressions.Target);
      if (!name || !value || Object.hasOwn(actuals, name)) { complete = false; return; }
      actuals[name] = sourceSlice(file, value, value);
      return;
    }
    if (!containers.has(kind)) { complete = false; return; }
    for (const child of expression.getChildren()) {
      if (child instanceof Nodes.ExpressionNode) visit(child);
      else if (!keywords.has(child.getFirstToken().getUpperStr())) complete = false;
    }
  };
  if (root) visit(root);
  return { arguments: actuals, argumentsComplete: complete };
}

/** A deliberately small syntactic non-write check for scalar IMPORTING params.
 * Alias creation, unknown statements or calls involving the value invalidate it;
 * no interprocedural side-effect or reference/heap analysis is claimed. */
function unchangedParameterEvidence(file: ParsedFile, scopeFor: (index: number) => Scope): Map<Statement, string[]> {
  const result = new Map<Statement, string[]>();
  let candidates = new Set<string>();
  let previousScope: Scope | undefined;
  const readStatements = new Set(["If", "ElseIf", "Case", "When", "While", "Check", "Assert", "Write"]);
  for (let i = 0; i < file.statements.length; i++) {
    const statement = file.statements[i];
    const scope = scopeFor(i);
    const kind = tag(statement);
    if (scope !== previousScope || PROCESSING_BOUNDARIES.has(kind)) candidates = new Set(scope.simpleParameters ?? []);
    previousScope = scope;
    if (["Comment", "Empty"].includes(kind)) { result.set(statement, [...candidates]); continue; }
    const ts = tokens(statement);
    if (["Unknown", "MacroCall", "MacroContent", "NativeSQL", "Assign", "GetReference"].includes(kind)
      || ts.includes("REF") || (ts.includes("PARAMETER") && ts.includes("TABLE")) || statement.findFirstExpression(Expressions.Dynamic)) candidates.clear();
    for (const name of [...candidates]) {
      if (!ts.includes(name)) continue;
      const targets = statement.findAllExpressionsRecursive(Expressions.Target);
      if (targets.some(target => tokens(target).includes(name))) { candidates.delete(name); continue; }
      const referencedInCall = statement.findAllExpressionsRecursive(Expressions.MethodCallChain).some(call => tokens(call).includes(name));
      if (referencedInCall || (!["Move", ...readStatements].includes(kind))) candidates.delete(name);
    }
    // Include potential writes in the current statement conservatively, even if
    // an individual nested invocation's execution order could precede that write.
    result.set(statement, [...candidates].sort());
  }
  return result;
}

function closing(statements: readonly Statement[], from: number, end: string): number {
  for (let i = from + 1; i < statements.length; i++) if (tag(statements[i]) === end) return i;
  return from;
}

function makeNode(path: string, id: string, name: string, kind: Kind, span: string, signature: string | null, body: string, exported: boolean, owner?: string): NodeV1 {
  return { id, name, kind, path, span, signature, exported, origin: "ast", body_hash: contentHash(body), body_text: searchable(body), ...(owner ? { owner } : {}), summary_state: "pending", summary: null, crux: null };
}

/** Extract declared reference types; infer inline NEW only where ABAP fixes the variable's static type. */
function collectBindings(statement: Statement, target: Bindings, recorded?: (name: string, type: string | null) => void): void {
  const ts = tokens(statement);
  const put = (name: string, type: string | null): void => { target.set(name, type); recorded?.(name, type); };
  // Record every declaration before refining supported reference types. Unknown
  // LIKE/factory/generic types still hide same-named class attributes or globals.
  for (const definition of statement.findAllExpressionsRecursive(Expressions.DataDefinition)) {
    const name = expressionText(definition, Expressions.DefinitionName);
    if (name) put(name, null);
  }
  for (const parameter of statement.findAllExpressionsRecursive(Expressions.MethodParamName)) put(norm(text(parameter)), null);
  for (const inline of statement.findAllExpressionsRecursive(Expressions.InlineData)) {
    const name = expressionText(inline, Expressions.TargetField);
    if (name) put(name, null);
  }
  if (tag(statement) === "FieldSymbol") {
    const name = expressionText(statement, Expressions.FieldSymbol);
    if (name) put(name, null);
  }
  if (["Data", "ClassData", "MethodDef"].includes(tag(statement))) {
    for (let i = 1; i + 3 < ts.length; i++) {
      if (ts[i] !== "TYPE" || ts[i + 1] !== "REF" || ts[i + 2] !== "TO") continue;
      let name = ts[i - 1];
      if (name === ")" && ts[i - 3] === "(") name = ts[i - 2];
      if (name && !["OBJECT", "DATA", "#"].includes(ts[i + 3])) put(name, ts[i + 3]);
    }
  }
  // No flow-sensitive guess from CREATE OBJECT or assignment to a generic ref.
  const source = statement.findDirectExpression(Expressions.Source);
  const chain = source?.findDirectExpression(Expressions.MethodCallChain);
  if (tag(statement) === "Move" && ts[0] === "DATA" && ts[1] === "(" && ts[3] === ")" && ts[4] === "=" && ts[5] === "NEW" && ts[6] !== "#"
    && source?.getChildren().length === 1 && chain?.getChildren().length === 1
    && chain.findDirectExpression(Expressions.NewObject)) put(ts[2], ts[6]);
}

export function extractAbapFiles(input: Map<string, string>, session = new AbapParseSession()): AbapExtraction {
  const sources = new Map<string, string>([...input].map(([p, s]): [string, string] => [p.replace(/\\/g, "/"), s]).sort(([a], [b]) => a.localeCompare(b)));
  const nodes: NodeV1[] = [];
  const edges: EdgeV1[] = [];
  const diagnostics: AbapDiagnostic[] = [];
  const unresolvedCalls: UnresolvedCallV1[] = [];
  type BindingDeclaration = { file: ParsedFile; statement: Statement; source: SourceExcerptV1 };
  const bindingDeclarations = new Map<Bindings, Map<string, BindingDeclaration>>();
  const bind = (file: ParsedFile, statement: Statement, bindings: Bindings): void => {
    const declarations = bindingDeclarations.get(bindings) ?? new Map<string, BindingDeclaration>();
    collectBindings(statement, bindings, (name, type) => {
      if (type) declarations.set(name, { file, statement, source: sourceExcerpt(file, statement) });
      else declarations.delete(name);
    });
    bindingDeclarations.set(bindings, declarations);
  };
  const unresolvedIds = new Set<string>();
  const unresolved = (scope: Scope, targetName: string, targetKind: UnresolvedCallV1['targetKind'],
    reason: UnresolvedCallV1['reason'], site: CallSiteV1, occurrence: string): void => {
    const id = `unresolved:${contentHash(`${occurrence}\0${targetKind}\0${targetName}`).slice(0, 16)}`;
    if (unresolvedIds.has(id)) return;
    unresolvedIds.add(id);
    const [line, column] = occurrence.slice(occurrence.lastIndexOf('\0') + 1).split(':').map(Number);
    unresolvedCalls.push({ id, source: scope.node.id, targetName, targetKind, reason, site: { ...site, occurrence: { line, column } } });
  };
  const edgeIndex = new Map<string, EdgeV1>();
  const edgeOccurrenceKeys = new Map<string, Set<string>>();
  const siteOrder = new WeakMap<CallSiteV1, string>();
  const diagnosticKeys = new Set<string>();
  const minted = new Set<string>();
  const files: ParsedFile[] = [];
  const definitions: Definition[] = [];
  const scopes: Scope[] = [];
  const functions = new Map<string, NodeV1[]>();
  const programs = new Map<string, NodeV1[]>();
  const transactions = new Map<string, NodeV1[]>();
  const forms = new Map<string, NodeV1[]>();
  const ddic = new Map<string, NodeV1[]>();
  const programGroups = new Map<string, Set<string>>();
  const includes = new Map<string, string[]>();
  const fileScopes = new Map<string, Scope>();
  const simpleParametersByNode = new Map<NodeV1, string[]>();
  const xmlParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });
  const diagnosticLines = new Map<string, string[]>();
  const diagnostic = (path: string, kind: string, message: string, at?: number, column?: number): void => {
    const key = JSON.stringify([path, at, kind, message, column]);
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    let source: SourceExcerptV1 | undefined;
    if (at && sources.has(path)) {
      let lines = diagnosticLines.get(path);
      if (!lines) { lines = sources.get(path)!.split(/\r?\n/); diagnosticLines.set(path, lines); }
      if (at >= 1 && at <= lines.length) source = { path, span: `L${at}-L${at}`, text: lines[at - 1] };
    }
    diagnostics.push({ path, ...(at ? { line: at } : {}), ...(column ? { column } : {}), kind, message, ...(source ? { source } : {}) });
  };
  const edge = (source: string, target: string, relation: Relation, inferred = false, callSite?: CallSiteV1, occurrence?: string): void => {
    const key = `${source}\0${target}\0${relation}`;
    let value = edgeIndex.get(key);
    if (!value) {
      value = { source, target, relation, confidence: inferred ? "inferred" : "extracted" };
      edgeIndex.set(key, value);
      edges.push(value);
    }
    if (callSite && occurrence) {
      let seen = edgeOccurrenceKeys.get(key);
      if (!seen) { seen = new Set(); edgeOccurrenceKeys.set(key, seen); }
      if (!seen.has(occurrence)) {
        seen.add(occurrence);
        const [line, column] = occurrence.slice(occurrence.lastIndexOf("\0") + 1).split(":").map(Number);
        const site: CallSiteV1 = { ...callSite, occurrence: { line, column } };
        siteOrder.set(site, occurrence);
        (value.callSites ??= []).push(site);
      }
    }
  };
  const mint = (id: string): string => {
    let result = id;
    let n = 2;
    while (minted.has(result)) result = `${id}~${n++}`;
    minted.add(result);
    return result;
  };
  const addIndex = (index: Map<string, NodeV1[]>, key: string, node: NodeV1): void => { index.set(key, [...(index.get(key) ?? []), node]); };
  const create = (file: ParsedFile, start: number, end: number, name: string, kind: Kind, parent?: NodeV1, owner?: string): NodeV1 => {
    const first = file.statements[start];
    const last = file.statements[end];
    const node = makeNode(file.path, mint(`${file.path}#${owner ? `${owner}.` : ""}${name}`), name, kind, `L${line(first)}-L${endLine(last)}`, clean(text(first)), sourceSlice(file, first, last), true, owner);
    nodes.push(node);
    edge(file.path, node.id, "contains");
    if (parent) edge(parent.id, node.id, "contains");
    return node;
  };
  const missingReason = (candidates: NodeV1[]): UnresolvedCallV1['reason'] => candidates.length ? 'ambiguous_target' : 'missing_target';

  // Include all input files in freshness checks, including XML which changes object semantics.
  for (const [path, source] of sources) {
    const node = makeNode(path, path, posix.basename(path), "file", `L1-L${source.split("\n").length}`, null, source, true);
    node.chars = source.length;
    nodes.push(node);
    minted.add(path);
  }

  for (const [path, source] of sources) {
    if (path.toLowerCase().endsWith('.xml')) {
      const validation = XMLValidator.validate(source);
      if (validation !== true) diagnostic(path, 'metadata_error', `Invalid XML: ${validation.err.msg}`, validation.err.line);
    }
  }
  let registry: Registry;
  try { registry = session.parse(sources); }
  catch (error) { diagnostic('', 'parse_error', `abaplint parse was incomplete: ${String(error)}`); return { nodes, edges, diagnostics, unresolvedCalls }; }
  for (const message of session.notices) diagnostic('', 'type_enrichment_unavailable', message);
  for (const object of registry.getObjects()) {
    if (!ABAPObject.is(object)) continue;
    for (const issue of object.getParsingIssues()) {
      diagnostic(issue.getFilename(), 'parse_error', issue.getMessage(), issue.getStart().getRow());
    }
    for (const file of object.getABAPFiles()) {
      const path = file.getFilename().replace(/\\/g, "/");
      const source = sources.get(path);
      if (source === undefined) continue;
      files.push({ path, source, group: groupOf(path), objectName: norm(object.getName()), statements: file.getStatements() });
    }
  }
  const parsedPaths = new Set(files.map(f => f.path));
  for (const [path, source] of sources) {
    if (!path.toLowerCase().endsWith(".abap") || parsedPaths.has(path)) continue;
    // Permit plain .abap snippets while preserving their actual location and identity.
    try {
      const fallback = new Registry(Config.getDefault(Version.v750)).addFile(new MemoryFile("graft_standalone.prog.abap", source)).parse();
      const object = fallback.getFirstObject();
      if (object && ABAPObject.is(object)) {
        const parsed = object.getABAPFiles()[0];
        if (parsed) files.push({ path, source, group: groupOf(path), objectName: norm(posix.basename(path, ".abap")), statements: parsed.getStatements() });
      }
      diagnostic(path, "standalone_source", "Source was parsed without abapGit object metadata; cross-file object grouping is unavailable.");
    } catch (error) { diagnostic(path, "parse_error", `Source could not be parsed: ${String(error)}`); }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Dictionary metadata is parsed as XML, never searched as ABAP text.
  const metadataReferences: { node: NodeV1; names: Set<string> }[] = [];
  for (const [path, source] of sources) {
    const match = posix.basename(path).match(/^(.+)\.(tabl|dtel|doma|ttyp)\.xml$/i);
    if (!match) continue;
    try {
      const xml: unknown = xmlParser.parse(source);
      const properties = new Map<string, string[]>();
      const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (typeof child === "string") properties.set(key, [...(properties.get(key) ?? []), child]);
          else if (Array.isArray(child)) child.forEach(visit);
          else visit(child);
        }
      };
      visit(xml);
      const type = norm(match[2]);
      const name = norm(properties.get(type === "TABL" ? "TABNAME" : type === "DOMA" ? "DOMNAME" : type === "DTEL" ? "ROLLNAME" : "TYPENAME")?.[0] ?? match[1].replace(/#/g, "/"));
      const fields = properties.get("FIELDNAME") ?? [];
      const description = properties.get("DDTEXT")?.[0];
      const signature = `${type} ${name}${description ? ` — ${description}` : ""}${fields.length ? ` (${fields.join(", ")})` : ""}`;
      const node = makeNode(path, mint(`${path}#${name}`), name, type === "TABL" ? "struct" : "type", `L1-L${source.split("\n").length}`, signature, source, true);
      nodes.push(node);
      edge(path, node.id, "contains");
      addIndex(ddic, name, node);
      metadataReferences.push({ node, names: new Set(["ROLLNAME", "DOMNAME", "ROWTYPE", "CHECKTABLE", "REFTABLE", "PRECFIELD"].flatMap(k => properties.get(k) ?? []).map(norm).filter(n => n !== name)) });
    } catch (error) { diagnostic(path, "metadata_error", `DDIC XML could not be parsed: ${String(error)}`); }
  }

  // Transaction metadata denotes the transaction itself. Never infer its runtime
  // target from a coincidentally matching report name or incomplete TSTC data.
  for (const [path, source] of sources) {
    if (!/\.tran\.xml$/i.test(path)) continue;
    try {
      const xml = xmlParser.parse(source);
      const tstc = xml?.abapGit?.['asx:abap']?.['asx:values']?.TSTC;
      if (!tstc || typeof tstc.TCODE !== 'string' || !tstc.TCODE.trim()) {
        diagnostic(path, 'metadata_error', 'Transaction XML has no unambiguous TSTC-TCODE.'); continue;
      }
      const name = norm(tstc.TCODE.trim());
      const node = makeNode(path, mint(`${path}#${name}`), name, 'module', `L1-L${source.split('\n').length}`, `TRANSACTION ${name}`, source, true);
      nodes.push(node); edge(path, node.id, 'contains'); addIndex(transactions, name, node);
    } catch (error) { diagnostic(path, 'metadata_error', `Transaction XML could not be parsed: ${String(error)}`); }
  }

  // Pass 1: class/interface declarations, method declarations and top-level routines.
  for (const file of files) {
    const ss = file.statements;
    let owner: Definition | undefined;
    let visibility = "PUBLIC";
    const fileNode = nodes.find(n => n.id === file.path)!;
    const whole: Scope = { node: fileNode, file, start: 0, end: ss.length - 1, bindings: new Map(), localTypes: new Set() };
    fileScopes.set(file.path, whole);
    scopes.push(whole);
    programGroups.set(file.objectName, new Set([...(programGroups.get(file.objectName) ?? []), file.group]));
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      const t = tag(s);
      if (t === "Unknown") { diagnostic(file.path, "unsupported_statement", "abaplint could not parse this statement for ABAP 7.50; relationships inside it are omitted.", line(s)); continue; }
      if (t === "ClassDefinition" || t === "Interface") {
        const name = expressionText(s, t === "Interface" ? Expressions.InterfaceName : Expressions.ClassName);
        if (!name) continue;
        const end = closing(ss, i, t === "Interface" ? "EndInterface" : "EndClass");
        const node = create(file, i, end, name, t === "Interface" ? "interface" : "class");
        const global = name === file.objectName && /\.(clas|intf)\./i.test(file.path);
        node.exported = global;
        owner = { node, declaration: sourceExcerpt(file, s), group: file.group, global, base: expressionText(s, Expressions.SuperClassName), interfaces: [], aliases: new Map(), methods: new Map(), bindings: new Map(), attributes: new Map(), localTypes: new Set() };
        definitions.push(owner);
        scopes.push({ node, file, start: i, end, owner, bindings: owner.bindings, localTypes: owner.localTypes });
        visibility = "PUBLIC";
        if (end === i) diagnostic(file.path, "incomplete_definition", `${name} has no parsed closing statement.`, line(s));
      } else if (t === "ClassImplementation" || t === "EndClass" || t === "EndInterface") {
        owner = undefined;
      } else if (["Public", "Protected", "Private"].includes(t)) {
        visibility = norm(t);
      } else if (t === "InterfaceDef" && owner) {
        const name = expressionText(s, Expressions.InterfaceName);
        if (name) owner.interfaces.push(name);
      } else if (t === 'Aliases' && owner) {
        const alias = expressionText(s, Expressions.SimpleName);
        const target = expressionText(s, Expressions.Field);
        if (alias && target) owner.aliases.set(alias, target);
      } else if (t === "MethodDef" && owner) {
        const name = expressionText(s, Expressions.MethodName);
        if (!name) continue;
        const node = create(file, i, i, name, "method", owner.node, owner.node.name);
        node.signature = clean(text(s)); // chain-expanded declaration, not a misleading raw prefix
        // Chain-expanded AST statements reuse the METHODS keyword's position.
        // Start at this member's name to avoid attributing a previous member's
        // defaults to this method. The signature retains the normalized keyword.
        node.declaration = sourceExcerpt(file, s, s.getColon() ? s.findFirstExpression(Expressions.MethodName) ?? s : s);
        const parameters = declarationParameters(file, s);
        node.abapParameters = parameters.parameters;
        simpleParametersByNode.set(node, parameters.simple);
        node.body_hash = contentHash(text(s));
        node.body_text = searchable(text(s));
        node.exported = owner.global && visibility === "PUBLIC";
        const returning = s.findDirectExpression(Expressions.MethodDefReturning)?.findFirstExpression(Expressions.TypeParam);
        const returnTokens = returning ? tokens(returning) : [];
        const returnType = returnTokens.length === 4 && returnTokens.slice(0, 3).join(' ') === 'TYPE REF TO'
          && !['OBJECT', 'DATA', '#'].includes(returnTokens[3]) ? returnTokens[3] : undefined;
        const redefinition = !!s.findDirectExpression(Expressions.Redefinition);
        owner.methods.set(name, { node, declaration: text(s), definition: owner, implemented: false, redefinition,
          ...(!redefinition ? { returning: { type: returnType, owner, source: node.declaration } } : {}),
        });
      } else if (["Report", "Program", "FunctionPool"].includes(t)) {
        const name = tokens(s)[1] ?? file.objectName;
        const node = create(file, i, Math.max(i, ss.length - 1), name, "module");
        whole.node = node;
        if (t !== 'FunctionPool') addIndex(programs, norm(name), node);
      } else if (["Form", "FunctionModule", "Module"].includes(t)) {
        const name = t === "FunctionModule" ? tokens(s)[1] : expressionText(s, Expressions.FormName);
        if (!name) continue;
        const end = closing(ss, i, t === "Form" ? "EndForm" : t === "FunctionModule" ? "EndFunction" : "EndModule");
        const node = create(file, i, end, name, t === "Module" ? "module" : "function");
        node.signature = `${t === "FunctionModule" ? "FUNCTION" : t.toUpperCase()} ${clean(text(s)).split(/\s+/).slice(1).join(" ")}`;
        const scope: Scope = { node, file, start: i, end, bindings: new Map(), localTypes: new Set() };
        scopes.push(scope);
        if (t === "FunctionModule") addIndex(functions, name, node);
        if (t === "Form") addIndex(forms, `${file.group}\0${name}`, node);
      } else if (t === "Include") {
        const name = expressionText(s, Expressions.IncludeName);
        if (name) includes.set(file.group, [...(includes.get(file.group) ?? []), name]);
      }
      // Formal parameters belong only to their own method, never to every method of the class.
      if (owner && t !== "MethodDef") {
        bind(file, s, owner.bindings);
        if (['Data', 'ClassData', 'Constant'].includes(t)) {
          for (const definition of s.findAllExpressionsRecursive(Expressions.DataDefinition)) {
            const name = expressionText(definition, Expressions.DefinitionName);
            if (name) owner.attributes.set(name, { statement: s, visibility });
          }
        }
      }
    }
  }

  const definitionCandidates = (name: string, group: string): Definition[] => {
    const local = definitions.filter(d => d.group === group && d.node.name === name);
    return local.length ? local : definitions.filter(d => d.global && d.node.name === name);
  };
  const findDefinition = (name: string, group: string): Definition | undefined => {
    const candidates = definitionCandidates(name, group);
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const interfaceVisible = (owner: Definition, name: string, visited = new Set<string>()): boolean => {
    if (owner.node.kind === 'interface' && owner.node.name === name || owner.interfaces.includes(name)) return true;
    if (visited.has(owner.node.id)) return false;
    visited.add(owner.node.id);
    return [...owner.interfaces, ...(owner.base ? [owner.base] : [])].some(parent => {
      const definition = findDefinition(parent, owner.group);
      return !!definition && interfaceVisible(definition, name, visited);
    });
  };
  const aliasTarget = (owner: Definition, name: string, visited = new Set<string>()): string | undefined => {
    if (visited.has(owner.node.id)) return undefined;
    visited.add(owner.node.id);
    const own = owner.aliases.get(name);
    if (own) return own;
    const [qualifier, member] = name.split('~');
    if (member && interfaceVisible(owner, qualifier)) {
      const intf = findDefinition(qualifier, owner.group);
      const alias = intf?.node.kind === 'interface' ? intf.aliases.get(member) : undefined;
      if (alias) return alias;
    }
    const base = owner.base ? findDefinition(owner.base, owner.group) : undefined;
    return base ? aliasTarget(base, name, visited) : undefined;
  };
  const canonicalMethodName = (owner: Definition, name: string): string | undefined => {
    const seen = new Set<string>();
    while (!seen.has(name)) {
      seen.add(name);
      const target = aliasTarget(owner, name);
      if (!target) return name;
      name = target;
    }
    return undefined; // malformed cyclic alias definitions: never recurse forever
  };
  type MethodResolution = { method: Method } | { reason: UnresolvedCallV1['reason'] };
  const lookupMethod = (owner: Definition, name: string, visited = new Set<string>()): MethodResolution => {
    const canonical = canonicalMethodName(owner, name);
    if (!canonical) return { reason: 'resolution_incomplete' };
    name = canonical;
    const key = `${owner.node.id}\0${name}`;
    if (visited.has(key)) return { reason: 'resolution_incomplete' };
    visited.add(key);
    const own = owner.methods.get(name);
    if (own) return { method: own };
    // A reference typed to a nested interface denotes its declaration, not a
    // guessed concrete class implementation. Class receivers still require an
    // implementation/declaration in their own class hierarchy.
    const [qualifier, member] = name.split('~');
    if (owner.node.kind === 'interface' && member && interfaceVisible(owner, qualifier)) {
      const intf = findDefinition(qualifier, owner.group);
      if (intf?.node.kind === 'interface') return lookupMethod(intf, member, visited);
    }
    let inherited: MethodResolution = { reason: 'missing_target' };
    if (owner.base) {
      const bases = definitionCandidates(owner.base, owner.group);
      inherited = bases.length === 1 ? lookupMethod(bases[0], name, visited)
        : { reason: bases.length ? 'ambiguous_target' : 'missing_target' };
      if ('method' in inherited) return inherited;
    }
    // Incomplete interface definitions/implementations may still prevent
    // selecting a method. Do not report such cases as proven absent targets.
    if (owner.aliases.size || owner.interfaces.length) return { reason: 'resolution_incomplete' };
    return inherited;
  };

  // Pass 2: replace declaration-only method locations with exact implementation spans.
  for (const file of files) {
    const ss = file.statements;
    let owner: Definition | undefined;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      if (tag(s) === "ClassImplementation") {
        const name = expressionText(s, Expressions.ClassName);
        owner = name ? findDefinition(name, file.group) : undefined;
        if (!owner && name) {
          const node = create(file, i, closing(ss, i, "EndClass"), name, "class");
          owner = { node, group: file.group, global: name === file.objectName, interfaces: [], aliases: new Map(), missingDeclaration: true, methods: new Map(), bindings: new Map(), attributes: new Map(), localTypes: new Set() };
          definitions.push(owner);
          diagnostic(file.path, "missing_declaration", `Class ${name} implementation has no class definition in the supplied export.`, line(s));
        }
      } else if (tag(s) === "EndClass") owner = undefined;
      else if (tag(s) === "MethodImplementation") {
        const declaredName = expressionText(s, Expressions.MethodName);
        if (!owner || !declaredName) { diagnostic(file.path, "missing_owner", "Method implementation has no resolved enclosing class.", line(s)); continue; }
        const name = canonicalMethodName(owner, declaredName);
        if (!name) { diagnostic(file.path, 'incomplete_definition', `Method alias ${declaredName} is cyclic; implementation cannot be assigned.`, line(s)); continue; }
        const end = closing(ss, i, "EndMethod");
        let method = owner.methods.get(name) ?? owner.methods.get(declaredName);
        if (!method) {
          const node = create(file, i, end, name, "method", owner.node, owner.node.name);
          method = { node, definition: owner, implemented: false };
          owner.methods.set(name, method);
        }
        owner.methods.set(name, method);
        if (method.implemented) { diagnostic(file.path, "duplicate_definition", `Duplicate implementation ${owner.node.name}~${name} omitted.`, line(s)); continue; }
        method.implemented = true;
        const body = sourceSlice(file, s, ss[end]);
        const node = method.node;
        node.path = file.path;
        node.span = `L${line(s)}-L${endLine(ss[end])}`;
        if (!method.declaration && name.includes("~")) {
          const [interfaceName, methodName] = name.split("~");
          const declaration = findDefinition(interfaceName, file.group)?.methods.get(methodName);
          if (declaration) {
            method.declaration = declaration.declaration;
            method.returning = declaration.returning;
            node.declaration = declaration.node.declaration;
            node.abapParameters = declaration.node.abapParameters;
            simpleParametersByNode.set(node, simpleParametersByNode.get(declaration.node) ?? []);
          }
        }
        node.signature = method.declaration ? clean(`${owner.node.name}~${name}: ${method.declaration}`) : clean(text(s));
        node.body_hash = contentHash(`${method.declaration ?? ""}\n${body}`);
        node.body_text = searchable(`${method.declaration ?? ""}\n${body}`);
        edge(file.path, node.id, "contains");
        const bindings = new Map(owner.bindings);
        bindingDeclarations.set(bindings, new Map(bindingDeclarations.get(owner.bindings)));
        const declaration = method.declaration;
        // Parameter declarations are already parsed in pass 1; locate the matching statement.
        if (declaration) for (const declarationFile of files.filter(f => f.group === file.group)) {
          const ds = declarationFile.statements.find(st => tag(st) === "MethodDef" && text(st) === declaration);
          if (ds) bind(declarationFile, ds, bindings);
        }
        scopes.push({ node, file, start: i, end, owner, bindings, localTypes: new Set(), simpleParameters: simpleParametersByNode.get(node) });
      }
    }
  }

  for (const definition of definitions) {
    const refs = [...(definition.base ? [{ name: definition.base, relation: "extends" as const }] : []), ...definition.interfaces.map(name => ({ name, relation: definition.node.kind === "interface" ? "extends" as const : "implements" as const }))];
    for (const ref of refs) {
      const target = findDefinition(ref.name, definition.group);
      if (target) edge(definition.node.id, target.node.id, ref.relation);
      else diagnostic(definition.node.path, "external_reference", `${ref.relation}: ${ref.name} is not uniquely defined in the supplied export.`, Number(definition.node.span.match(/\d+/)?.[0]));
    }
  }
  for (const { node, names } of metadataReferences) for (const name of names) {
    const candidates = ddic.get(name) ?? [];
    if (candidates.length === 1) edge(node.id, candidates[0].id, "references");
    else diagnostic(node.path, "external_reference", `DDIC dependency ${name} is not uniquely defined in the supplied export.`);
  }

  // A function module may occupy its entire file. On equal spans prefer the
  // explicit routine over the fallback file scope. Prepare once instead of
  // filtering and sorting all project scopes for every statement in every pass.
  const scopesByFile = new Map(files.map(file => [file, scopes.filter(s => s.file === file)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start)
      || Number(a === fileScopes.get(file.path)) - Number(b === fileScopes.get(file.path)))]));
  const scopeFor = (file: ParsedFile, index: number): Scope => scopesByFile.get(file)!
    .find(s => s.start <= index && s.end >= index) ?? fileScopes.get(file.path)!;
  // Declared variables are visible for the containing ABAP processing block.
  for (const file of files) for (let i = 0; i < file.statements.length; i++) {
    if (tag(file.statements[i]) !== "MethodDef") bind(file, file.statements[i], scopeFor(file, i).bindings);
  }
  // TYPES statements inside BEGIN OF ... END OF define structure components,
  // not additional top-level type names. Keep each declaration in its scope.
  for (const file of files) {
    const depths = new Map<Scope, number>();
    for (let i = 0; i < file.statements.length; i++) {
      const statement = file.statements[i];
      const scope = scopeFor(file, i);
      const depth = depths.get(scope) ?? 0;
      if (["Type", "TypeBegin", "TypeEnumBegin"].includes(tag(statement)) && depth === 0) {
        const name = expressionText(statement, Expressions.NamespaceSimpleName);
        if (name) scope.localTypes.add(name);
      }
      if (["TypeBegin", "TypeEnumBegin"].includes(tag(statement))) depths.set(scope, depth + 1);
      else if (["TypeEnd", "TypeEnumEnd"].includes(tag(statement))) depths.set(scope, Math.max(0, depth - 1));
    }
  }
  const localTypeVisible = (scope: Scope, name: string): boolean => scope.localTypes.has(name)
    || !!scope.owner?.localTypes.has(name)
    || files.some(file => file.group === scope.file.group && fileScopes.get(file.path)?.localTypes.has(name));

  // A return type belongs to the declaration's namespace, not the caller's.
  // Missing base declarations cannot prove that a same-name data type is absent.
  const returnTypeShadowed = (owner: Definition, name: string, seen = new Set<string>()): boolean => {
    if (owner.missingDeclaration || seen.has(owner.node.id)) return true;
    seen.add(owner.node.id);
    if (owner.localTypes.has(name) || owner.aliases.has(name) || files.some(file => file.group === owner.group && fileScopes.get(file.path)?.localTypes.has(name))) return true;
    if (!owner.base) return false;
    const base = findDefinition(owner.base, owner.group);
    return !base || returnTypeShadowed(base, name, seen);
  };
  const returnDeclaration = (method: Method, seen = new Set<Method>()): ReturnDeclaration | undefined => {
    if (seen.has(method)) return undefined;
    seen.add(method);
    if (method.returning) return method.returning;
    if (method.redefinition && method.definition.base) {
      const base = findDefinition(method.definition.base, method.definition.group);
      const inherited = base ? lookupMethod(base, method.node.name) : undefined;
      if (inherited && 'method' in inherited) return returnDeclaration(inherited.method, seen);
    }
    return undefined;
  };

  const expressionOwner = (scope: Scope, expression: Expression): Definition | undefined => {
    const type = expression.findDirectExpression(Expressions.TypeNameOrInfer);
    const ts = type ? tokens(type) : [];
    if (ts.length !== 1 || ['#', 'OBJECT', 'DATA'].includes(ts[0]) || localTypeVisible(scope, ts[0])
      || scope.owner && returnTypeShadowed(scope.owner, ts[0]) || expression.findDirectExpression(Expressions.Dereference)) return undefined;
    const owner = findDefinition(ts[0], scope.file.group);
    // NEW can create data references too; an interface cannot be instantiated.
    return expression.get() instanceof Expressions.NewObject && owner?.node.kind !== 'class' ? undefined : owner;
  };
  const constructorTarget = (owner: Definition, seen = new Set<string>()): Method | undefined => {
    if (owner.missingDeclaration || seen.has(owner.node.id)) return undefined;
    seen.add(owner.node.id);
    const own = owner.methods.get('CONSTRUCTOR');
    if (own) return own;
    // Without an explicit declaration ABAP forwards the constructor interface
    // and call to its direct base. No synthetic empty/root constructor nodes.
    const base = owner.base ? findDefinition(owner.base, owner.group) : undefined;
    return base ? constructorTarget(base, seen) : undefined;
  };
  // A fully known chain with no explicit constructor needs no synthetic node.
  // Missing/cyclic ancestry cannot establish that absence.
  const constructorChainKnown = (owner: Definition, seen = new Set<string>()): boolean => {
    if (owner.missingDeclaration || owner.node.kind !== 'class' || seen.has(owner.node.id)) return false;
    seen.add(owner.node.id);
    if (owner.methods.has('CONSTRUCTOR') || !owner.base || owner.base === 'OBJECT') return true;
    const base = findDefinition(owner.base, owner.group);
    return !!base && constructorChainKnown(base, seen);
  };

  // A same-name method (including an alias or an inherited method) hides an
  // ABAP builtin. Missing superclass declarations prevent proving its absence.
  // Interface components use IF~NAME; only an explicit alias adds a bare name.
  const cannotHideBuiltin = (owner: Definition | undefined, name: string, visited = new Set<string>()): boolean => {
    if (!owner) return true;
    if (owner.missingDeclaration || visited.has(owner.node.id) || owner.methods.has(name) || owner.aliases.has(name)) return false;
    visited.add(owner.node.id);
    if (!owner.base) return true;
    const bases = definitionCandidates(owner.base, owner.group);
    return bases.length === 1 && cannotHideBuiltin(bases[0], name, visited);
  };

  // Inline DATA has a compile-time type. Keep its resolved definition and
  // declaration namespace, rather than re-resolving its name in the caller.
  // Bindings become available only after the declaring statement is processed.
  type InlineReference = { owner?: Definition; name: string; group: string; evidence: NonNullable<CallSiteV1['receiverType']> };
  const inlineReferences = new Map<Bindings, Map<string, InlineReference>>();
  const catchReference = (scope: Scope, statement: Statement): InlineReference | undefined => {
    const names = statement.findDirectExpressions(Expressions.ClassName).map(node => norm(text(node)));
    if (!names.length || new Set(names).size !== names.length) return undefined;
    const source = sourceExcerpt(scope.file, statement);
    if (names.length === 1) {
      const candidates = definitionCandidates(names[0], scope.file.group);
      if (candidates.some(owner => owner.node.kind !== 'class' || owner.missingDeclaration)) return undefined;
      return { name: names[0], group: scope.file.group, owner: candidates.length === 1 ? candidates[0] : undefined,
        evidence: { name: names[0], basis: 'inline_catch', source } };
    }
    // The nearest common exported ancestor is enough: ancestry beyond that
    // point is not needed. Missing paths never justify guessing CX_ROOT.
    const lineages: Definition[][] = [];
    for (const name of names) {
      const lineage: Definition[] = [], seen = new Set<Definition>();
      let owner = findDefinition(name, scope.file.group);
      if (!owner) return undefined;
      while (owner) {
        if (seen.has(owner) || owner.node.kind !== 'class' || owner.missingDeclaration || !owner.declaration) return undefined;
        seen.add(owner); lineage.push(owner);
        owner = owner.base ? findDefinition(owner.base, owner.group) : undefined;
      }
      lineages.push(lineage);
    }
    const common = lineages[0].find(candidate => lineages.every(lineage => lineage.includes(candidate)));
    if (!common) return undefined;
    const path = [...new Set(lineages.flatMap(lineage => lineage.slice(0, lineage.indexOf(common) + 1)))];
    return { name: common.node.name, group: common.group, owner: common,
      evidence: { name: common.node.name, basis: 'inline_catch', source, via: path.map(owner => owner.declaration!) } };
  };
  // Attribute lookup follows the declaration hierarchy, not the receiver's
  // runtime class. Unknown declarations stop lookup rather than revealing a
  // same-name program global. Private base attributes are not inherited names.
  const ancestorPath = (start: Definition | undefined, ancestor: Definition): Definition[] | undefined => {
    const path: Definition[] = [], seen = new Set<Definition>();
    for (let owner = start; owner; owner = owner.base ? findDefinition(owner.base, owner.group) : undefined) {
      if (seen.has(owner) || owner.missingDeclaration || owner.node.kind !== 'class') return undefined;
      seen.add(owner); path.push(owner);
      if (owner === ancestor) return path;
    }
    return undefined;
  };
  type AttributeLookup = { bindings: Bindings; via?: SourceExcerptV1[] } | 'absent' | 'unknown';
  const attributeBinding = (start: Definition | undefined, field: string, scope: Scope, requireStatic: boolean): AttributeLookup => {
    if (!start) return 'unknown';
    const path: Definition[] = [], seen = new Set<Definition>();
    let owner: Definition | undefined = start;
    while (owner) {
      if (seen.has(owner) || owner.missingDeclaration || owner.node.kind !== 'class') return 'unknown';
      seen.add(owner); path.push(owner);
      const attribute = owner.attributes.get(field);
      if (attribute) {
        if (attribute.visibility !== 'PRIVATE' || owner === start) {
          if (requireStatic && tag(attribute.statement) !== 'ClassData') return 'unknown';
          const access = attribute.visibility === 'PROTECTED' ? ancestorPath(scope.owner, owner) : undefined;
          if (attribute.visibility === 'PRIVATE' && scope.owner !== owner
            || attribute.visibility === 'PROTECTED' && !access) return 'unknown';
          const proof = [...new Set([...path, ...(access ?? [])])];
          if (proof.some(definition => !definition.declaration)) return 'unknown';
          return { bindings: owner.bindings,
            ...(proof.length > 1 ? { via: proof.map(definition => definition.declaration!) } : {}) };
        }
      } else if (owner.bindings.has(field) || owner.aliases.has(field)) return 'unknown';
      if (!owner.base || owner.base === 'OBJECT') return 'absent';
      owner = findDefinition(owner.base, owner.group);
      if (!owner) return 'unknown';
    }
    return 'absent';
  };
  // A binding's static type belongs to its original declaration. A method-local
  // TYPES name cannot retroactively retype an attribute or formal parameter.
  // Preserve unknown declarations as masks and keep inline return namespaces.
  const referenceBinding = (scope: Scope, receiver: string) => {
    const ownAttribute = receiver.startsWith('ME->');
    const staticAttribute = /^([^=>]+)=>([^=>]+)$/.exec(receiver);
    const attributeOwner = ownAttribute ? scope.owner : staticAttribute ? findDefinition(staticAttribute[1], scope.file.group) : undefined;
    const field = staticAttribute?.[2] ?? (ownAttribute ? receiver.slice(4) : receiver);
    // Only names actually recorded by the AST can match. Do not restrict them
    // with an ASCII identifier regex: ABAP permits namespaced declarations.
    let bindings: Bindings | undefined;
    let via: SourceExcerptV1[] | undefined;
    if (!ownAttribute && !staticAttribute && scope.bindings.has(field)) bindings = scope.bindings;
    else {
      const attribute = attributeBinding(ownAttribute || staticAttribute ? attributeOwner : scope.owner, field, scope, !!staticAttribute);
      if (typeof attribute !== 'string') { bindings = attribute.bindings; via = attribute.via; }
      else if (ownAttribute || staticAttribute || scope.owner && attribute === 'unknown') return undefined;
      else bindings = fileScopes.get(scope.file.path)?.bindings;
    }
    const type = bindings?.get(field);
    const inline = bindings && inlineReferences.get(bindings)?.get(field);
    const declaration = bindings && bindingDeclarations.get(bindings)?.get(field);
    const declarationIndex = declaration ? declaration.file.statements.indexOf(declaration.statement) : -1;
    const declaredScope = declaration && scopeFor(declaration.file, declarationIndex);
    if (inline) return { type: inline.name, owner: inline.owner, evidence: inline.evidence,
      group: inline.group, declaredScope, shadowed: false };
    if (!type || !declaration || !declaredScope) return undefined;
    const shadowed = localTypeVisible(declaredScope, type)
      || !!declaredScope.owner && returnTypeShadowed(declaredScope.owner, type);
    return { type, owner: shadowed ? undefined : findDefinition(type, declaration.file.group),
      group: declaration.file.group, declaredScope, shadowed,
      evidence: { name: type, basis: via ? 'inherited_attribute' : 'declaration', source: declaration.source,
        ...(via ? { via } : {}) } as NonNullable<CallSiteV1['receiverType']> };
  };
  const resolveCall = (scope: Scope, receiver: string | undefined, name: string, isStatic: boolean, at: number, site: CallSiteV1, occurrence: string, unresolvedTarget?: string): Method | undefined => {
    let owner: Definition | undefined;
    let targetOwner = receiver;
    let inferred = false;
    let targetGroup = scope.file.group;
    if (isStatic && receiver) owner = findDefinition(receiver, scope.file.group);
    else if (!receiver || receiver === "ME") owner = scope.owner;
    else if (receiver === "SUPER" && scope.owner?.base) {
      targetOwner = scope.owner.base;
      owner = findDefinition(targetOwner, scope.file.group);
    }
    else if (receiver) {
      const reference = referenceBinding(scope, receiver);
      if (reference && !reference.shadowed) {
        targetOwner = reference.type; targetGroup = reference.group; owner = reference.owner;
        inferred = true; site.receiverType = reference.evidence;
        if (['inline_catch', 'inherited_attribute'].includes(reference.evidence.basis ?? '')) unresolvedTarget ??= `${receiver}->${name}`;
      }
      else {
        unresolved(scope, unresolvedTarget ?? `${receiver}->${name}`, 'method', 'unresolved_receiver', site, occurrence);
        diagnostic(scope.file.path, "unresolved_receiver", `Method ${receiver}->${name} has no supported static receiver type; no call edge was emitted.`, at); return;
      }
    }
    const resolution: MethodResolution = owner ? lookupMethod(owner, name)
      : { reason: targetOwner && definitionCandidates(targetOwner, targetGroup).length > 1 ? 'ambiguous_target' : 'missing_target' };
    if ('method' in resolution) {
      edge(scope.node.id, resolution.method.node.id, "calls", inferred, site, occurrence);
      return resolution.method;
    }
    else {
      const qualifier = owner?.node.name ?? targetOwner ?? scope.owner?.node.name;
      unresolved(scope, unresolvedTarget ?? `${qualifier ? `${qualifier}${isStatic ? '=>' : '->'}` : ''}${name}`, 'method', resolution.reason, site, occurrence);
      diagnostic(scope.file.path, "external_call", `Method ${receiver ? `${receiver}${isStatic ? "=>" : "->"}` : ""}${name} is not resolved in the supplied export.`, at);
    }
  };
  const formGroups = (group: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(group)) return seen;
    seen.add(group);
    for (const include of includes.get(group) ?? []) for (const child of programGroups.get(include) ?? []) formGroups(child, seen);
    return seen;
  };
  const builtins = new Set(["STRING", "XSTRING", "I", "INT8", "C", "N", "D", "T", "F", "P", "X", "ABAP_BOOL", "ABAP_BOOLEAN", "DECFLOAT16", "DECFLOAT34", "ANY", "DATA", "OBJECT"]);
  // Classification only: this never manufactures a constructor or refines a
  // variable type. A declared TYPES alias, including REF TO class, is data.
  const inheritedDataType = (owner: Definition | undefined, name: string, seen = new Set<string>()): boolean => {
    if (!owner || seen.has(owner.node.id)) return false;
    seen.add(owner.node.id);
    if (owner.localTypes.has(name)) return true;
    return !!owner.base && inheritedDataType(findDefinition(owner.base, owner.group), name, seen);
  };
  const knownDataType = (scope: Scope, name: string): boolean => {
    if (localTypeVisible(scope, name) || inheritedDataType(scope.owner, name)) return true;
    if (definitionCandidates(name, scope.file.group).length) return false;
    if (builtins.has(name) && !['ANY', 'DATA', 'OBJECT'].includes(name)) return true;
    const entries = ddic.get(name) ?? [];
    return entries.length === 1 && /^(TABL|DTEL|TTYP) /.test(entries[0].signature ?? '');
  };
  const controlsByFile = new Map(files.map(file => [file, controlEvidence(file, index => scopeFor(file, index))]));
  const earlierExitsByFile = new Map(files.map(file => [file, earlierExitEvidence(file, index => scopeFor(file, index), controlsByFile.get(file)!)]));
  const unchangedParametersByFile = new Map(files.map(file => [file, unchangedParameterEvidence(file, index => scopeFor(file, index))]));
  const processingStarts = new Map<Statement, number>();
  for (const file of files) {
    let previousScope: Scope | undefined;
    let start = 0;
    for (let i = 0; i < file.statements.length; i++) {
      const scope = scopeFor(file, i);
      if (scope !== previousScope || PROCESSING_BOUNDARIES.has(tag(file.statements[i]))) start = i;
      previousScope = scope;
      processingStarts.set(file.statements[i], start);
    }
  }

  // Pass 3: relationship extraction from expression nodes only (comments/literals cannot masquerade as calls).
  for (const file of files) for (let i = 0; i < file.statements.length; i++) {
    const s = file.statements[i];
    if (["Comment", "Unknown", "MacroContent"].includes(tag(s))) continue;
    const scope = scopeFor(file, i);
    const at = line(s);
    const inlineTarget = ['Move', 'Catch'].includes(tag(s)) ? s.findDirectExpression(Expressions.Target)?.findDirectExpression(Expressions.InlineData) : undefined;
    const inlineName = inlineTarget ? expressionText(inlineTarget, Expressions.TargetField) : undefined;
    const inlineSource = inlineName ? s.findDirectExpression(Expressions.Source) : undefined;
    const inlineChain = inlineSource?.getChildren().length === 1 ? inlineSource.findDirectExpression(Expressions.MethodCallChain) : undefined;
    let pendingInline: InlineReference | undefined = inlineName && tag(s) === 'Catch' ? catchReference(scope, s) : undefined;
    const controls = controlsByFile.get(file)?.get(s) ?? [];
    const earlierExits = earlierExitsByFile.get(file)?.get(s) ?? [];
    // A later loop-body write can precede this invocation on a subsequent
    // iteration. Without a CFG, abstain from unchanged claims inside loops.
    const inRepeatedContext = controls.some(control => LOOP_CONTEXTS.has(control.kind)) || ["Loop", "While", "Do", "SelectLoop", "Provide"].includes(tag(s));
    const unchangedParameters = inRepeatedContext ? [] : unchangedParametersByFile.get(file)?.get(s) ?? [];
    const site: CallSiteV1 = { ...sourceExcerpt(file, s), ...(controls.length ? { controls } : {}), earlierExits, unchangedParameters, localAssignments: [], argumentsComplete: false };
    // Only direct grammar keywords classify execution. Nested argument names,
    // string values and callback bodies cannot masquerade as additions.
    const directWords = s.getChildren().filter(child => !(child instanceof Nodes.ExpressionNode)).map(child => child.getFirstToken().getUpperStr());
    const keywordSequence = ` ${directWords.join(' ')} `;
    const hasKeywords = (words: string): boolean => keywordSequence.includes(` ${words} `);
    const functionExecution: CallExecution | undefined = tag(s) !== 'CallFunction' ? undefined
      : hasKeywords('STARTING NEW TASK') ? 'async'
      : hasKeywords('IN UPDATE TASK') ? 'update_task'
      : hasKeywords('IN BACKGROUND TASK') ? 'background_task'
      : hasKeywords('IN BACKGROUND UNIT') ? 'background_unit' : undefined;
    const withAssignments = (callSite: CallSiteV1): CallSiteV1 => {
      const start = processingStarts.get(s) ?? i;
      const assignments = localAssignmentsBeforeCall(file.statements.slice(start, i + 1), i - start, callSite.arguments,
        statement => controlsByFile.get(file)?.get(statement) ?? [], statement => sourceExcerpt(file, statement));
      return { ...callSite, localAssignments: assignments };
    };
    if (tag(s) === 'CreateObject') {
      const target = s.findDirectExpression(Expressions.Target);
      const explicit = s.findDirectExpression(Expressions.ClassName);
      const dynamic = s.findDirectExpression(Expressions.Dynamic);
      const receiver = target ? norm(text(target).replace(/\s+/g, '')) : '?';
      let className = explicit ? norm(text(explicit)) : undefined;
      let reason: UnresolvedCallV1['reason'] | undefined;
      let reference: ReturnType<typeof referenceBinding>;
      if (dynamic) {
        // SAP evaluates literal class names statically too. Their value is
        // case-sensitive and must already be uppercase; never fold 'leaf'.
        const literal = /^\(\s*(['`])([A-Z][A-Z0-9_]*|\/[A-Z0-9_]+\/[A-Z][A-Z0-9_]*)\1\s*\)$/.exec(text(dynamic));
        if (literal) className = literal[2];
        else reason = 'dynamic_target';
      } else if (!explicit) {
        reference = referenceBinding(scope, receiver);
        className = reference?.type;
        if (!reference || reference.shadowed) {
          className = undefined;
          reason = 'unresolved_receiver';
        }
      }
      const candidates = reference?.owner ? [reference.owner] : className ? definitionCandidates(className, reference?.group ?? file.group) : [];
      const owner = candidates.length === 1 ? candidates[0] : undefined;
      if (!reason && !owner) reason = candidates.length ? 'ambiguous_target' : 'missing_target';
      if (!reason && owner && (owner.node.kind !== 'class' || !constructorChainKnown(owner))) reason = 'resolution_incomplete';
      const parameters = invocationArguments(file, s.findDirectExpression(Expressions.ParameterListS));
      if (hasKeywords('PARAMETER - TABLE')) parameters.argumentsComplete = false;
      const constructor = !reason && owner ? constructorTarget(owner) : undefined;
      const constructorSite = withAssignments({ ...site, ...parameters,
        ...(reference && !reference.shadowed ? { receiverType: reference.evidence } : {}),
        ...(constructor && owner ? { construction: { className: owner.node.name, implicitForwarding: constructor.definition !== owner } } : {}),
      });
      // Chain-expanded CREATE OBJECT statements reuse the CREATE token.
      // The target position identifies each original invocation separately.
      const occurrence = occurrenceKey(file, s, target ?? s);
      if (constructor && owner) edge(scope.node.id, constructor.node.id, 'calls', constructor.definition !== owner, constructorSite, occurrence);
      else if (reason) {
        const name = reference?.evidence.basis === 'inherited_attribute' ? receiver : className ?? (dynamic ? text(dynamic) : receiver);
        unresolved(scope, `${name}->CONSTRUCTOR`, 'method', reason, constructorSite, occurrence);
        diagnostic(file.path, reason === 'dynamic_target' ? 'dynamic_call' : 'external_call',
          `CREATE OBJECT ${name}: constructor is not statically resolved in the supplied export (${reason}); source invocation retained.`, at);
      }
    }
    // Visit every NEW once, including standalone and argument-nested creation.
    // The following chain's method actuals must never be constructor actuals.
    for (const creation of s.findAllExpressionsRecursive(Expressions.NewObject)) {
      let owner = expressionOwner(scope, creation);
      let inferredType: NonNullable<CallSiteV1['construction']>['inferredType'];
      const type = creation.findDirectExpression(Expressions.TypeNameOrInfer);
      const typeName = type ? norm(text(type).replace(/\s+/g, '')) : '?';
      let diagnosticType = typeName;
      let dataConstruction = knownDataType(scope, typeName);
      // Contextual # is supported only for a whole assignment RHS, never an
      // argument nested inside it or the beginning of a subsequent call chain.
      const rhs = tag(s) === 'Move' ? s.findDirectExpression(Expressions.Source) : undefined;
      const rhsChain = rhs?.getChildren().length === 1 ? rhs.findDirectExpression(Expressions.MethodCallChain) : undefined;
      if (!owner && type && text(type) === '#' && rhsChain?.getChildren().length === 1
        && rhsChain.findDirectExpression(Expressions.NewObject) === creation) {
        const target = s.findDirectExpression(Expressions.Target);
        const name = target ? norm(text(target).replace(/\s+/g, '')) : '';
        const reference = referenceBinding(scope, name);
        if (reference) {
          diagnosticType = reference.type;
          dataConstruction = !!reference.declaredScope && knownDataType(reference.declaredScope, reference.type);
          if (reference.owner?.node.kind === 'class') {
            owner = reference.owner;
            inferredType = { target: name, source: reference.evidence.source,
              ...(reference.evidence.via ? { via: reference.evidence.via } : {}),
              ...(reference.evidence.inlineDeclaration ? { inlineDeclaration: reference.evidence.inlineDeclaration } : {}) };
          }
        }
      }
      const constructor = owner ? constructorTarget(owner) : undefined;
      if (!owner || !constructor) {
        if (owner ? !constructorChainKnown(owner) : !dataConstruction) {
          const token = creation.getFirstToken();
          const reason = owner ? `Class ${owner.node.name} has incomplete or cyclic constructor ancestry`
            : `Type ${diagnosticType} or its operand context is not uniquely resolved; NEW may create data or an object`;
          diagnostic(file.path, 'unresolved_construction', `NEW ${typeName}: ${reason}; no constructor edge was inferred.`, token.getRow(), token.getCol());
        }
        continue;
      }
      const parameters = creation.findDirectExpression(Expressions.ParameterListS) ?? creation.findDirectExpression(Expressions.Source);
      const constructorSite = withAssignments({ ...site, ...invocationArguments(file, parameters),
        construction: { className: owner.node.name, implicitForwarding: constructor.definition !== owner, ...(inferredType ? { inferredType } : {}) },
      });
      edge(scope.node.id, constructor.node.id, 'calls', constructor.definition !== owner, constructorSite, occurrenceKey(file, s, creation));
    }
    for (const chain of s.findAllExpressionsRecursive(Expressions.MethodCallChain)) {
      const children = chain.getChildren();
      let initialExpression: Expression | undefined;
      let seenCall = false;
      let previousMethod: Method | undefined;
      let prefix: string[] = [];
      let chainPrefix = '';
      for (const child of children) {
        if (child instanceof Nodes.ExpressionNode && child.get() instanceof Expressions.MethodCall) {
          const name = expressionText(child, Expressions.MethodName);
          if (!name) continue;
          const methodSite = withAssignments({ ...site, ...invocationArguments(file, child.findDirectExpression(Expressions.MethodCallParam)) });
          let resolvedMethod: Method | undefined;
          if (seenCall) {
            const declaration = previousMethod && prefix.length === 1 && prefix[0] === '->' ? returnDeclaration(previousMethod) : undefined;
            const returnOwner = declaration?.type && !returnTypeShadowed(declaration.owner, declaration.type)
              ? findDefinition(declaration.type, declaration.owner.group) : undefined;
            if (returnOwner && declaration?.type) {
              methodSite.receiverType = { name: declaration.type, source: declaration.source };
              const resolution = lookupMethod(returnOwner, name);
              if ('method' in resolution) {
                resolvedMethod = resolution.method;
                edge(scope.node.id, resolvedMethod.node.id, 'calls', true, methodSite, occurrenceKey(file, s, child));
              } else {
                unresolved(scope, `${chainPrefix}${name}`, 'method', resolution.reason, methodSite, occurrenceKey(file, s, child));
                diagnostic(file.path, 'external_call', `Chained method ${name} is not resolved in declared return type ${declaration.type}.`, at);
              }
            } else {
              unresolved(scope, `${chainPrefix}${name}`, 'method', 'unresolved_receiver', methodSite, occurrenceKey(file, s, child));
              diagnostic(file.path, "unresolved_receiver", `Chained method ${name} has an unresolved return type; no call edge was emitted.`, at);
            }
          }
          else if (initialExpression && prefix.length === 1 && prefix[0] === '->') {
            const owner = expressionOwner(scope, initialExpression);
            if (owner) {
              const basis = initialExpression.get() instanceof Expressions.NewObject ? 'new' : 'cast';
              methodSite.receiverType = { name: owner.node.name, basis, source: {
                path: file.path, span: `L${initialExpression.getFirstToken().getRow()}-L${initialExpression.getLastToken().getRow()}`,
                text: sourceSlice(file, initialExpression, initialExpression),
              } };
              const resolution = lookupMethod(owner, name);
              if ('method' in resolution) {
                resolvedMethod = resolution.method;
                edge(scope.node.id, resolvedMethod.node.id, 'calls', true, methodSite, occurrenceKey(file, s, child));
              } else {
                unresolved(scope, `${chainPrefix}${name}`, 'method', resolution.reason, methodSite, occurrenceKey(file, s, child));
                diagnostic(file.path, 'external_call', `Method ${name} is not resolved in explicit ${basis.toUpperCase()} type ${owner.node.name}.`, at);
              }
            } else {
              unresolved(scope, `${chainPrefix}${name}`, 'method', 'unresolved_receiver', methodSite, occurrenceKey(file, s, child));
              diagnostic(file.path, 'unresolved_receiver', `Method ${name} has no uniquely resolved object type for its NEW/CAST receiver.`, at);
            }
          }
          else if (prefix.length === 0) {
            if (!abap750Builtins.has(name) || !cannotHideBuiltin(scope.owner, name)) {
              resolvedMethod = resolveCall(scope, undefined, name, false, at, methodSite, occurrenceKey(file, s, child));
            }
          }
          else if (prefix.length === 2 && ["=>", "->"].includes(prefix[1])) resolvedMethod = resolveCall(scope, prefix[0], name, prefix[1] === "=>", at, methodSite, occurrenceKey(file, s, child));
          else if (prefix.length === 4 && prefix[3] === '->'
            && (prefix[1] === '=>' || prefix[0] === 'ME' && prefix[1] === '->')) {
            resolvedMethod = resolveCall(scope, prefix.slice(0, 3).join(''), name, false, at, methodSite, occurrenceKey(file, s, child), `${chainPrefix}${name}`);
          }
          else {
            unresolved(scope, `${chainPrefix}${name}`, 'method', 'unresolved_receiver', methodSite, occurrenceKey(file, s, child));
            diagnostic(file.path, "unresolved_receiver", `Method receiver ${prefix.join("")} for ${name} is not resolved.`, at);
          }
          seenCall = true;
          previousMethod = resolvedMethod;
          prefix = [];
        } else if (!seenCall && child instanceof Nodes.ExpressionNode && (child.get() instanceof Expressions.NewObject || child.get() instanceof Expressions.Cast)) {
          initialExpression = child;
        } else prefix.push(...(child instanceof Nodes.ExpressionNode ? tokens(child) : [child.getFirstToken().getUpperStr()]));
        chainPrefix += child instanceof Nodes.ExpressionNode ? text(child) : child.getFirstToken().getStr();
      }
      if (chain === inlineChain && prefix.length === 0) {
        if (seenCall && previousMethod) {
          const declaration = returnDeclaration(previousMethod);
          const owner = declaration?.type && !returnTypeShadowed(declaration.owner, declaration.type)
            ? findDefinition(declaration.type, declaration.owner.group) : undefined;
          if (owner && declaration) pendingInline = { owner, name: owner.node.name, group: owner.group, evidence: { name: owner.node.name, basis: 'inline_returning',
            source: declaration.source, inlineDeclaration: sourceExcerpt(file, s) } };
        } else if (!seenCall && initialExpression?.get() instanceof Expressions.Cast) {
          const owner = expressionOwner(scope, initialExpression);
          if (owner) pendingInline = { owner, name: owner.node.name, group: owner.group, evidence: { name: owner.node.name, basis: 'inline_cast',
            source: { path: file.path, span: `L${initialExpression.getFirstToken().getRow()}-L${initialExpression.getLastToken().getRow()}`,
              text: sourceSlice(file, initialExpression, initialExpression) }, inlineDeclaration: sourceExcerpt(file, s) } };
        }
      }
    }
    // Classic CALL METHOD uses a separate AST expression from functional calls.
    const methodSource = s.findDirectExpression(Expressions.MethodSource);
    if (methodSource) {
      const ts = tokens(methodSource);
      const methodSite: CallSiteV1 = tag(s) === 'CallFunction' && directWords.includes('CALLING')
        ? { ...site, execution: 'callback', arguments: {}, argumentsComplete: false }
        : withAssignments({ ...site, ...invocationArguments(file, s.findDirectExpression(Expressions.MethodCallBody)) });
      if (methodSource.findFirstExpression(Expressions.Dynamic)) {
        unresolved(scope, text(methodSource), 'method', 'dynamic_target', methodSite, occurrenceKey(file, s, methodSource));
        diagnostic(file.path, "dynamic_call", `Dynamic CALL METHOD ${text(methodSource)} cannot be statically resolved.`, at);
      }
      else if (ts.length === 1) resolveCall(scope, undefined, ts[0], false, at, methodSite, occurrenceKey(file, s, methodSource));
      else if (ts.length === 3 && ["=>", "->"].includes(ts[1])) resolveCall(scope, ts[0], ts[2], ts[1] === "=>", at, methodSite, occurrenceKey(file, s, methodSource));
      else if (ts.length === 5 && ts[3] === '->' && (ts[1] === '=>' || ts[0] === 'ME' && ts[1] === '->')) {
        resolveCall(scope, ts.slice(0, 3).join(''), ts[4], false, at, methodSite, occurrenceKey(file, s, methodSource), text(methodSource));
      }
      else {
        unresolved(scope, text(methodSource), 'method', 'unresolved_receiver', methodSite, occurrenceKey(file, s, methodSource));
        diagnostic(file.path, "unresolved_receiver", `CALL METHOD ${text(methodSource)} has an unsupported receiver chain.`, at);
      }
    }
    if (tag(s) === "CallFunction") {
      const fn = s.findDirectExpression(Expressions.FunctionName);
      const ts = fn ? fn.getTokens() : [];
      const raw = ts[0]?.getStr();
      const functionParameters = s.findDirectExpression(Expressions.FunctionParameters);
      const functionSite = withAssignments({ ...site, ...invocationArguments(file, functionParameters),
        ...(functionExecution ? { execution: functionExecution } : {}),
        ...(hasKeywords('PARAMETER - TABLE') || hasKeywords('EXCEPTION - TABLE') ? { argumentsComplete: false } : {}),
      });
      if (ts.length !== 1 || !raw || !(raw.startsWith("'") && raw.endsWith("'"))) {
        unresolved(scope, fn ? text(fn) : text(s), 'function', 'dynamic_target', functionSite, occurrenceKey(file, s, fn ?? s));
        diagnostic(file.path, "dynamic_call", "Dynamic CALL FUNCTION target cannot be statically resolved.", at);
      }
      else {
        const name = norm(raw.slice(1, -1).replace(/''/g, "'"));
        const candidates = functions.get(name) ?? [];
        const destination = s.findDirectExpression(Expressions.Destination);
        const destinationTokens = destination?.getTokens().map(token => token.getStr());
        const localDestination = destinationTokens?.length === 2 && destinationTokens[1] === "'NONE'";
        if (functionExecution === 'background_unit' || (destination && !localDestination)) {
          unresolved(scope, name, 'function', 'remote', functionSite, occurrenceKey(file, s, fn ?? s));
          diagnostic(file.path, "remote_call", functionExecution === 'background_unit'
            ? `CALL FUNCTION ${name} takes its RFC destination from the background unit; the local implementation is not an exact target.`
            : `CALL FUNCTION ${name} uses an RFC destination; the local implementation is not an exact target.`, at);
        }
        else if (candidates.length === 1) edge(scope.node.id, candidates[0].id, "calls", false, functionSite, occurrenceKey(file, s, fn ?? s));
        else {
          unresolved(scope, name, 'function', missingReason(candidates), functionSite, occurrenceKey(file, s, fn ?? s));
          diagnostic(file.path, "external_call", `Function module ${name} is not uniquely defined in the supplied export.`, at);
        }
      }
      if (directWords.includes('PERFORMING')) {
        const callback = s.findDirectExpression(Expressions.FormName);
        const name = callback ? norm(text(callback)) : '';
        const candidates = [...new Set([...formGroups(file.group)].flatMap(g => forms.get(`${g}\0${name}`) ?? []))];
        const callbackSite: CallSiteV1 = { ...site, execution: 'callback', arguments: {}, argumentsComplete: false };
        const occurrence = occurrenceKey(file, s, callback ?? s);
        if (candidates.length === 1) edge(scope.node.id, candidates[0].id, 'calls', false, callbackSite, occurrence);
        else {
          unresolved(scope, name || text(s), 'form', missingReason(candidates), callbackSite, occurrence);
          diagnostic(file.path, 'external_call', `RFC callback FORM ${name} is not uniquely defined in the caller's program/include scope.`, at);
        }
      }
    }
    if (tag(s) === "Perform") {
      const name = expressionText(s, Expressions.FormName);
      const program = expressionText(s, Expressions.IncludeName);
      const performExecution: CallExecution | undefined = hasKeywords('ON COMMIT') ? 'on_commit' : hasKeywords('ON ROLLBACK') ? 'on_rollback' : undefined;
      const performSite: CallSiteV1 = performExecution ? { ...site, execution: performExecution } : site;
      // Dispatch OF is a direct keyword; an actual parameter named OF is nested
      // in PerformUsing/Changing and must not turn a static call into a dynamic one.
      const indexed = s.getChildren().some(child => !(child instanceof Nodes.ExpressionNode) && child.getFirstToken().getUpperStr() === 'OF');
      if (!name || s.findFirstExpression(Expressions.Dynamic) || indexed) {
        unresolved(scope, text(s), 'form', 'dynamic_target', performSite, occurrenceKey(file, s, s.findFirstExpression(Expressions.FormName) ?? s));
        diagnostic(file.path, "dynamic_call", "Dynamic/indexed PERFORM cannot be statically resolved.", at);
      }
      else {
        const groups = program ? [...(programGroups.get(program) ?? [])].flatMap(g => [...formGroups(g)]) : [...formGroups(file.group)];
        const candidates = [...new Set(groups.flatMap(g => forms.get(`${g}\0${name}`) ?? []))];
        if (candidates.length === 1) edge(scope.node.id, candidates[0].id, "calls", false, performSite, occurrenceKey(file, s, s.findFirstExpression(Expressions.FormName) ?? s));
        else {
          unresolved(scope, program ? `${program}.${name}` : name, 'form', missingReason(candidates), performSite, occurrenceKey(file, s, s.findFirstExpression(Expressions.FormName) ?? s));
          diagnostic(file.path, "external_call", `FORM ${name}${program ? ` IN PROGRAM ${program}` : ""} is not uniquely defined in the program/include scope.`, at);
        }
      }
    }
    if (tag(s) === "Include") {
      const name = expressionText(s, Expressions.IncludeName);
      const groups = name ? programGroups.get(name) : undefined;
      const targets = groups ? files.filter(f => groups.has(f.group) && f.objectName === name) : [];
      if (targets.length) for (const target of targets) edge(file.path, target.path, "references");
      else if (name) diagnostic(file.path, "external_reference", `INCLUDE ${name} is outside the supplied export.`, at);
    }
    for (const table of s.findAllExpressionsRecursive(Expressions.DatabaseTable)) {
      if (table.findFirstExpression(Expressions.Dynamic)) { diagnostic(file.path, "dynamic_reference", "Dynamic SQL table cannot be statically resolved.", at); continue; }
      const name = norm(text(table)).replace(/^\*/, "");
      const candidates = ddic.get(name) ?? [];
      if (candidates.length === 1) edge(scope.node.id, candidates[0].id, "references");
      else diagnostic(file.path, "external_reference", `Database object ${name} is outside the supplied DDIC export.`, at);
    }
    for (const type of s.findAllExpressionsRecursive(Expressions.TypeName)) {
      const name = tokens(type)[0];
      if (!name || builtins.has(name) || name === "#" || localTypeVisible(scope, name)) continue;
      const typeTarget = findDefinition(name, file.group)?.node;
      const candidates = ddic.get(name) ?? [];
      if (typeTarget) edge(scope.node.id, typeTarget.id, "references");
      else if (candidates.length === 1) edge(scope.node.id, candidates[0].id, "references");
      // Local TYPES are not yet indexed: report external-looking names only.
      else if (/^(Z|Y|\/)/.test(name)) diagnostic(file.path, "external_reference", `Type ${name} is not resolved in the supplied class/DDIC export.`, at);
    }
    if (tag(s) === 'Submit') {
      const target = s.findDirectExpression(Expressions.IncludeName);
      const name = target ? norm(text(target).replace(/\s+/g, '')) : undefined;
      if (!name) {
        const dynamic = s.findDirectExpression(Expressions.Dynamic);
        unresolved(scope, dynamic ? text(dynamic) : text(s), 'program', 'dynamic_target', site, occurrenceKey(file, s, dynamic ?? s));
        diagnostic(file.path, 'dynamic_call', 'Dynamic SUBMIT target is recorded but cannot be statically resolved.', at);
      } else {
        const candidates = programs.get(name) ?? [];
        if (candidates.length === 1) edge(scope.node.id, candidates[0].id, 'calls', false, site, occurrenceKey(file, s, target ?? s));
        else {
          unresolved(scope, name, 'program', missingReason(candidates), site, occurrenceKey(file, s, target ?? s));
          diagnostic(file.path, 'external_call', `SUBMIT ${name}: ${candidates.length ? 'multiple report definitions' : 'report definition missing'} in the supplied export; source invocation retained.`, at);
        }
      }
    }
    if (tag(s) === 'CallTransaction') {
      const target = s.findDirectExpression(Expressions.Source);
      const raw = target ? text(target) : '';
      const literal = /^'([^']|'')*'$/.test(raw) || /^`([^`]|``)*`$/.test(raw);
      if (!literal) {
        unresolved(scope, raw || text(s), 'transaction', 'dynamic_target', site, occurrenceKey(file, s, target ?? s));
        diagnostic(file.path, 'dynamic_call', 'CALL TRANSACTION target is not a literal; source invocation retained without guessing its runtime value.', at);
      } else {
        const name = norm(raw.slice(1, -1).replace(/''/g, "'").replace(/``/g, '`'));
        const candidates = transactions.get(name) ?? [];
        if (candidates.length === 1) edge(scope.node.id, candidates[0].id, 'calls', false, site, occurrenceKey(file, s, target ?? s));
        else {
          unresolved(scope, name, 'transaction', candidates.length ? 'ambiguous_target' : 'missing_transaction_metadata', site, occurrenceKey(file, s, target ?? s));
          diagnostic(file.path, 'external_call', `CALL TRANSACTION ${name}: transaction metadata ${candidates.length ? 'ambiguous' : 'missing'} in the supplied export.`, at);
        }
      }
    }
    if (["CallBadi", "MacroCall"].includes(tag(s))) diagnostic(file.path, "unsupported_relationship", `${tag(s)} relationship is not modeled by the ABAP extractor.`, at);
    if (inlineName && pendingInline) {
      const bindings = inlineReferences.get(scope.bindings) ?? new Map<string, InlineReference>();
      bindings.set(inlineName, pendingInline);
      inlineReferences.set(scope.bindings, bindings);
    }
  }

  // Kept deterministic for stable cards, diffs and reproducible coverage reports.
  for (const value of edges) value.callSites?.sort((a, b) => (siteOrder.get(a) ?? "").localeCompare(siteOrder.get(b) ?? ""));
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => `${a.source}\0${a.relation}\0${a.target}`.localeCompare(`${b.source}\0${b.relation}\0${b.target}`));
  diagnostics.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0) || a.kind.localeCompare(b.kind) || a.message.localeCompare(b.message));
  unresolvedCalls.sort((a, b) => a.id.localeCompare(b.id));
  return { nodes, edges, diagnostics, unresolvedCalls };
}
