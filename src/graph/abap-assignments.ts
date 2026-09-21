/** Bounded source evidence, not reaching definitions or runtime value analysis. */
import { Expressions, Nodes, type ABAPFile } from "@abaplint/core";
import type { ControlContextV1, LocalAssignmentV1, SourceExcerptV1 } from "./types.js";

type Statement = ReturnType<ABAPFile["getStatements"]>[number];
type Expression = ReturnType<Statement["findAllExpressionsRecursive"]>[number];

/** Classify an already-tokenized name / supplied actual, never parse source text. */
function simpleName(value: string): string | undefined {
  const name = value.trim().replace(/^!/, "");
  return /^[a-z_][a-z0-9_]*$/i.test(name) ? name.toUpperCase() : undefined;
}

function oneTokenName(expression: Expression | undefined): string | undefined {
  const tokens = expression?.getTokens();
  return tokens?.length === 1 ? simpleName(tokens[0].getStr()) : undefined;
}

function targetName(target: Expression): string | undefined {
  const inline = target.findDirectExpression(Expressions.InlineData);
  if (inline) return oneTokenName(inline.findDirectExpression(Expressions.TargetField));
  return oneTokenName(target);
}

/** A component/substring/table-row write invalidates a prior whole-variable
 * assignment, but LS-LV_TEST never becomes a write to the local LV_TEST. */
function writtenRoot(target: Expression): string | undefined {
  return targetName(target) ?? simpleName(target.getFirstToken().getStr());
}

type Output = NonNullable<LocalAssignmentV1["output"]>;
type Write = { kind: "direct" | "call_output"; output?: Output };

/** Each direction belongs to its immediate parameter container. Do not descend
 * through a ParameterS/Source: a nested invocation owns its own output list. */
function callOutputs(statement: Statement): { target: Expression; output: Output }[] {
  const result: { target: Expression; output: Output }[] = [];
  const directions = new Set(["IMPORTING", "CHANGING", "RECEIVING", "TABLES"]);
  const containers = [
    ...statement.findAllExpressionsRecursive(Expressions.MethodParameters),
    ...statement.findAllExpressionsRecursive(Expressions.FunctionParameters),
  ];
  for (const container of containers) {
    let direction: Output["direction"] | undefined;
    for (const child of container.getChildren()) {
      if (!(child instanceof Nodes.ExpressionNode)) {
        const word = child.getFirstToken().getUpperStr();
        direction = directions.has(word) ? word as Output["direction"] : undefined;
        continue;
      }
      if (!direction) continue;
      const parameters = child.get() instanceof Expressions.ParameterT ? [child]
        : child.get() instanceof Expressions.ParameterListT ? child.findDirectExpressions(Expressions.ParameterT) : [];
      for (const parameter of parameters) {
        const name = oneTokenName(parameter.findDirectExpression(Expressions.ParameterName));
        const target = parameter.findDirectExpression(Expressions.Target);
        if (name && target) result.push({ target, output: { direction, parameter: name } });
      }
    }
  }
  return result;
}

/** Flat earlier lexical candidates, not reaching definitions or proven fallbacks.
 * A later write inside a context replaces older writes in that same/narrower
 * context. Other branches and outer initializations remain separate candidates. */
function priorCandidates(previous: LocalAssignmentV1 | undefined, controls: ControlContextV1[]): LocalAssignmentV1[] {
  if (!previous || !controls.length) return [];
  return [previous, ...(previous.priorAssignments ?? [])].flatMap(candidate => {
    // The extractor shares the header objects across statements. Use identity:
    // distinct identical IF headers on one line have the same public span/text.
    const candidateControls = new Set(candidate.controls ?? []);
    if (controls.every(control => candidateControls.has(control))) return [];
    const { priorAssignments: _priorAssignments, ...flat } = candidate;
    return [flat];
  });
}

/**
 * Last preceding direct assignment / named call output in lexical order, for local variables
 * used as named actuals. `statements` MUST be one processing-scope slice (method,
 * FORM, function, ...); `callIndex` is the current statement's index in that slice.
 * The current statement is excluded: a call on its RHS runs before the LHS write.
 *
 * Only prior DATA / inline DATA declarations establish a local. Attributes,
 * formal parameters and component actuals are not searched as if they were locals.
 * Conditional writes retain earlier candidates outside their lexical context;
 * these are not proven fallbacks, and conditions are never evaluated. Unrecognized
 * intervening writing targets suppress older evidence. Address-taking
 * and indirect writes are conservative barriers, not an alias analysis. Evidence
 * is never a claim about the variable's effective value at the call.
 */
export function localAssignmentsBeforeCall(
  statements: readonly Statement[],
  callIndex: number,
  args: Record<string, string> | undefined,
  getControls: (statement: Statement) => ControlContextV1[],
  excerpt: (statement: Statement) => SourceExcerptV1,
): LocalAssignmentV1[] {
  if (!args || !Number.isInteger(callIndex) || callIndex < 0 || callIndex >= statements.length) return [];
  const wanted = new Set(Object.values(args).map(simpleName).filter((name): name is string => !!name));
  if (!wanted.size) return [];
  const declared = new Set<string>();
  const escaped = new Set<string>();
  const latest = new Map<string, LocalAssignmentV1>();

  for (let i = 0; i < callIndex; i++) {
    const statement = statements[i];
    const kind = statement.get().constructor.name;
    const writes = new Map<string, Write>();
    const recognizedTargets = new Set<Expression>();
    if (kind === "Data") {
      for (const definition of statement.findDirectExpressions(Expressions.DataDefinition)) {
        const name = oneTokenName(definition.findDirectExpression(Expressions.DefinitionName));
        if (!name) continue;
        declared.add(name);
        if (definition.findDirectExpression(Expressions.Value)) writes.set(name, { kind: "direct" });
      }
    }
    for (const inline of statement.findAllExpressionsRecursive(Expressions.InlineData)) {
      const name = oneTokenName(inline.findDirectExpression(Expressions.TargetField));
      if (name) declared.add(name);
    }

    // Macro/unknown statement effects cannot safely be projected onto named locals.
    if (kind === "Unknown" || kind === "MacroCall") {
      latest.clear();
      continue;
    }

    const words = statement.getTokens().map(token => token.getUpperStr());
    const refExpressions = statement.findAllExpressionsRecursive(Expressions.Source)
      .filter(source => source.getFirstToken().getUpperStr() === "REF");
    const takesAddress = kind === "Assign" || kind === "GetReference" || words.includes("ASSIGNING") || refExpressions.length > 0;
    if (takesAddress) {
      const dynamicAssign = kind === "Assign" && !!statement.findFirstExpression(Expressions.Dynamic);
      for (const name of wanted) {
        if (dynamicAssign || words.some(word => simpleName(word) === name)) {
          escaped.add(name);
          latest.delete(name);
        }
      }
    }

    const duplicateOutputs = new Set<string>();
    for (const { target, output } of callOutputs(statement)) {
      const name = targetName(target);
      if (!name) continue;
      recognizedTargets.add(target);
      if (writes.has(name)) duplicateOutputs.add(name);
      writes.set(name, { kind: "call_output", output });
    }
    // Multiple outputs for one variable in the same statement have no bounded
    // execution-order proof. A separate direct LHS below can still supersede them.
    for (const name of duplicateOutputs) writes.delete(name);

    // A Move LHS is assigned after RHS invocations, so it supersedes any named
    // output to the same variable in that RHS. The whole current call statement
    // remains excluded by the outer loop.
    if (kind === "Move") {
      for (const target of statement.findDirectExpressions(Expressions.Target)) {
        const name = targetName(target);
        if (name) {
          recognizedTargets.add(target);
          writes.set(name, { kind: "direct" });
        }
      }
    }

    const targets = [
      ...statement.findAllExpressionsRecursive(Expressions.Target),
      ...statement.findAllExpressionsRecursive(Expressions.SimpleTarget),
    ];
    // An indirect target may refer to any local for which this bounded pass has
    // no alias information. Suppress old candidates rather than guess an owner.
    if (targets.some(target => target.getTokens().some(token => {
      const word = token.getUpperStr();
      return word.startsWith("<") || word === "->";
    }))) latest.clear();
    for (const target of targets) {
      const root = writtenRoot(target);
      if (root && (!recognizedTargets.has(target) || !writes.has(root))) latest.delete(root);
    }

    for (const [variable, write] of writes) {
      if (!wanted.has(variable) || !declared.has(variable) || escaped.has(variable)) continue;
      const controls = getControls(statement);
      const priorAssignments = priorCandidates(latest.get(variable), controls);
      latest.set(variable, {
        ...excerpt(statement), variable, ...write,
        ...(controls.length ? { controls } : {}),
        ...(priorAssignments.length ? { priorAssignments } : {}),
      });
    }
  }

  return [...wanted].flatMap(variable => {
    const assignment = latest.get(variable);
    return assignment ? [assignment] : [];
  });
}
