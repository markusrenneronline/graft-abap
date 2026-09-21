import { test } from "node:test";
import assert from "node:assert/strict";
import { ABAPObject, Config, MemoryFile, Registry, Version, type ABAPFile } from "@abaplint/core";
import { localAssignmentsBeforeCall } from "../src/graph/abap-assignments.js";
import type { ControlContextV1, SourceExcerptV1 } from "../src/graph/types.js";

type Statement = ReturnType<ABAPFile["getStatements"]>[number];

function fixture(body: string) {
  const source = `REPORT zassignments.\n${body}`;
  const registry = new Registry(Config.getDefault(Version.v750))
    .addFile(new MemoryFile("zassignments.prog.abap", source)).parse();
  const object = registry.getObjects().find(item => item instanceof ABAPObject) as ABAPObject;
  const statements = object.getABAPFiles()[0].getStatements();
  assert.ok(statements.every(statement => statement.get().constructor.name !== "Unknown"), "fixture must parse as ABAP 7.50");
  const offsets: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") offsets.push(i + 1);
  const excerpt = (statement: Statement): SourceExcerptV1 => {
    const first = statement.getFirstToken();
    const last = statement.getLastToken();
    const start = offsets[first.getRow() - 1] + first.getCol() - 1;
    const end = offsets[last.getRow() - 1] + last.getCol() - 1 + last.getStr().length;
    return { path: "zassignments.prog.abap", span: `L${first.getRow()}-L${last.getRow()}`, text: source.slice(start, end) };
  };
  const callIndex = statements.findIndex(statement => statement.concatTokens().toUpperCase().includes("ZCL_SINK=>USE("));
  assert.ok(callIndex >= 0);
  return { statements, callIndex, excerpt };
}

function run(body: string, args: Record<string, string> = { IV_VALUE: "lv_test" }) {
  const data = fixture(body);
  return localAssignmentsBeforeCall(data.statements, data.callIndex, args, () => [], data.excerpt);
}

/** Minimal IF-only fixture context, using shared header objects as the extractor does. */
function runControlled(body: string, args: Record<string, string> = { IV_VALUE: "lv_test" }) {
  const data = fixture(body);
  const stack: ControlContextV1[] = [];
  const contexts = new Map<Statement, ControlContextV1[]>();
  for (const statement of data.statements) {
    const kind = statement.get().constructor.name;
    if (kind === "EndIf") stack.pop();
    if (kind === "Else" || kind === "ElseIf") {
      stack.pop();
      stack.push({ ...data.excerpt(statement), kind: kind.toUpperCase() });
    }
    contexts.set(statement, [...stack]);
    if (kind === "If") stack.push({ ...data.excerpt(statement), kind: "IF" });
  }
  return localAssignmentsBeforeCall(data.statements, data.callIndex, args, statement => contexts.get(statement) ?? [], data.excerpt);
}

test("inline DATA records the actual prior statement including a multiline RHS call", () => {
  const result = run(`DATA(lv_test) = zcl_flags=>flag(\n  iv_value = iv_test\n  iv_default = abap_false ).\nzcl_sink=>use( iv_value = lv_test ).`);
  assert.equal(result.length, 1);
  assert.equal(result[0].variable, "LV_TEST");
  assert.equal(result[0].span, "L2-L4");
  assert.equal(result[0].text, "DATA(lv_test) = zcl_flags=>flag(\n  iv_value = iv_test\n  iv_default = abap_false ).");
});

test("last direct assignment before the statement wins even when all statements share a line", () => {
  const result = run("DATA lv_test TYPE i. lv_test = 1. lv_test = 2. zcl_sink=>use( iv_value = lv_test ). lv_test = 3.");
  assert.deepEqual(result.map(item => item.text), ["lv_test = 2."]);
});

test("assignment containing the current RHS call is not a prior write", () => {
  const result = run("DATA lv_test TYPE i VALUE 1. lv_test = zcl_sink=>use( iv_value = lv_test ).");
  assert.deepEqual(result.map(item => item.text), ["DATA lv_test TYPE i VALUE 1."]);
  assert.deepEqual(run("DATA(lv_test) = zcl_sink=>use( iv_value = lv_test )."), []);
});

test("scope slices cannot leak an identically named local from another method", () => {
  const data = fixture(`CLASS lcl DEFINITION. PUBLIC SECTION. METHODS first. METHODS second. ENDCLASS.
CLASS lcl IMPLEMENTATION.
METHOD first. DATA lv_test TYPE i VALUE 1. ENDMETHOD.
METHOD second. zcl_sink=>use( iv_value = lv_test ). ENDMETHOD.
ENDCLASS.`);
  const start = data.statements.findIndex(statement => statement.concatTokens().toUpperCase() === "METHOD SECOND.");
  const scoped = data.statements.slice(start);
  assert.deepEqual(localAssignmentsBeforeCall(scoped, data.callIndex - start, { IV_VALUE: "lv_test" }, () => [], data.excerpt), []);
});

test("MOVE TO and DATA VALUE are direct writes, declaration without VALUE is not", () => {
  assert.deepEqual(run("DATA lv_test TYPE i. zcl_sink=>use( iv_value = lv_test )."), []);
  assert.deepEqual(run("DATA lv_test TYPE i VALUE 1. zcl_sink=>use( iv_value = lv_test ).").map(item => item.text), ["DATA lv_test TYPE i VALUE 1."]);
  assert.deepEqual(run("DATA lv_test TYPE i VALUE 1. MOVE 2 TO lv_test. zcl_sink=>use( iv_value = lv_test ).").map(item => item.text), ["MOVE 2 TO lv_test."]);
});

test("conditional last source assignment keeps its control evidence without evaluating it", () => {
  const data = fixture("DATA lv_test TYPE i VALUE 1. IF iv_flag = abap_true. lv_test = 2. ENDIF. zcl_sink=>use( iv_value = lv_test ).");
  const condition = data.statements.find(statement => statement.get().constructor.name === "If")!;
  const control: ControlContextV1 = { ...data.excerpt(condition), kind: "IF" };
  const result = localAssignmentsBeforeCall(data.statements, data.callIndex, { IV_VALUE: "lv_test" }, () => [control], data.excerpt);
  assert.equal(result[0].text, "lv_test = 2.");
  assert.deepEqual(result[0].controls, [control]);
});

test("component actuals and undeclared attributes/formals are not treated as local scalars", () => {
  const body = "lv_test = 1. me->lv_attr = 2. zcl_sink=>use( iv_value = lv_test ).";
  assert.deepEqual(run(body), []);
  assert.deepEqual(run("DATA lv_test TYPE i VALUE 1. zcl_sink=>use( iv_value = lv_test ).", {
    A: "ls-lv_test", B: "me->lv_test", C: "xsdbool( lv_test = 1 )", D: "'lv_test'",
  }), []);
});

test("field writes, input arguments and comparisons do not masquerade as local assignment", () => {
  const result = run("DATA lv_test TYPE i VALUE 1. ls-lv_test = 9. zcl_other=>pass( lv_test = 7 ). IF lv_test = 0. ENDIF. zcl_sink=>use( iv_value = lv_test ).");
  assert.deepEqual(result.map(item => item.text), ["DATA lv_test TYPE i VALUE 1."]);
});

test("CLEAR FREE and positional FORM output writes suppress older assignments", () => {
  for (const write of ["CLEAR lv_test.", "FREE lv_test.", "PERFORM change CHANGING lv_test."]) {
    assert.deepEqual(run(`DATA lv_test TYPE i VALUE 1. ${write} zcl_sink=>use( iv_value = lv_test ).`), [], write);
  }
  assert.deepEqual(run("DATA lv_test TYPE i VALUE 1. CLEAR lv_test. lv_test = 4. zcl_sink=>use( iv_value = lv_test ).").map(item => item.text), ["lv_test = 4."]);
});

test("SQL and component writes suppress a prior whole-variable assignment", () => {
  assert.deepEqual(run("DATA lv_test TYPE i VALUE 1. SELECT SINGLE field FROM ztab INTO @lv_test. zcl_sink=>use( iv_value = lv_test )."), []);
  assert.deepEqual(run("DATA lv_test TYPE string VALUE 'abc'. lv_test+0(1) = 'd'. zcl_sink=>use( iv_value = lv_test )."), []);
});

test("known address taking and indirect writes conservatively suppress stale evidence", () => {
  for (const alias of ["GET REFERENCE OF lv_test INTO DATA(lr).", "ASSIGN lv_test TO FIELD-SYMBOL(<fs>).", "DATA(lr) = REF #( lv_test ).", "<fs> = 5.", "lr->* = 5."]) {
    assert.deepEqual(run(`DATA lv_test TYPE i VALUE 1. ${alias} zcl_sink=>use( iv_value = lv_test ).`), [], alias);
  }
});

test("duplicate actual variables yield one excerpt, and absent arguments yield none", () => {
  const data = fixture("DATA lv_test TYPE i VALUE 1. zcl_sink=>use( iv_value = lv_test ).");
  assert.equal(localAssignmentsBeforeCall(data.statements, data.callIndex, { A: "lv_test", B: "LV_TEST" }, () => [], data.excerpt).length, 1);
  assert.deepEqual(localAssignmentsBeforeCall(data.statements, data.callIndex, undefined, () => [], data.excerpt), []);
});

test("conditional latest write retains the unconditional initialization as a lexical candidate", () => {
  const result = runControlled("DATA lv_test TYPE i VALUE 1. IF iv_flag = abap_true. lv_test = 2. ENDIF. zcl_sink=>use( iv_value = lv_test ).");
  assert.equal(result[0].text, "lv_test = 2.");
  assert.equal(result[0].kind, "direct");
  assert.equal(result[0].controls?.[0].text, "IF iv_flag = abap_true.");
  assert.deepEqual(result[0].priorAssignments?.map(item => item.text), ["DATA lv_test TYPE i VALUE 1."]);
  assert.equal(result[0].priorAssignments?.[0].controls, undefined);
  assert.equal(result[0].priorAssignments?.[0].priorAssignments, undefined);
});

test("same and narrower contexts are pruned while outer candidates remain flat", () => {
  const result = runControlled("DATA lv_test TYPE i VALUE 0. IF iv_a = 1. lv_test = 1. IF iv_b = 1. lv_test = 2. ENDIF. lv_test = 3. ENDIF. zcl_sink=>use( iv_value = lv_test ).");
  assert.equal(result[0].text, "lv_test = 3.");
  assert.deepEqual(result[0].priorAssignments?.map(item => item.text), ["DATA lv_test TYPE i VALUE 0."]);
  const nested = runControlled("DATA lv_test TYPE i VALUE 0. IF iv_a = 1. lv_test = 1. IF iv_b = 1. lv_test = 2. ENDIF. ENDIF. zcl_sink=>use( iv_value = lv_test ).");
  assert.deepEqual(nested[0].priorAssignments?.map(item => item.text), ["lv_test = 1.", "DATA lv_test TYPE i VALUE 0."]);
  assert.ok(nested[0].priorAssignments?.every(item => item.priorAssignments === undefined));
});

test("exclusive branches remain separate candidates without asserting path coverage", () => {
  const result = runControlled("DATA lv_test TYPE i VALUE 0. IF iv_a = 1. lv_test = 1. ELSEIF iv_a = 2. lv_test = 2. ELSE. lv_test = 3. ENDIF. zcl_sink=>use( iv_value = lv_test ).");
  assert.equal(result[0].controls?.[0].kind, "ELSE");
  assert.deepEqual(result[0].priorAssignments?.map(item => item.text), ["lv_test = 2.", "lv_test = 1.", "DATA lv_test TYPE i VALUE 0."]);
  assert.deepEqual(result[0].priorAssignments?.map(item => item.controls?.[0].kind), ["ELSEIF", "IF", undefined]);
});

test("distinct identical IF headers on the same source line are not conflated", () => {
  const result = runControlled("DATA lv_test TYPE i VALUE 0. IF iv_a = 1. lv_test = 1. ENDIF. IF iv_a = 1. lv_test = 2. ENDIF. zcl_sink=>use( iv_value = lv_test ).");
  assert.deepEqual(result[0].priorAssignments?.map(item => item.text), ["lv_test = 1.", "DATA lv_test TYPE i VALUE 0."]);
});

test("unconditional writes and mutation barriers discard older conditional histories", () => {
  const start = "DATA lv_test TYPE i VALUE 0. IF iv_a = 1. lv_test = 1. ENDIF.";
  const unconditional = runControlled(`${start} lv_test = 2. zcl_sink=>use( iv_value = lv_test ).`);
  assert.equal(unconditional[0].text, "lv_test = 2.");
  assert.equal(unconditional[0].priorAssignments, undefined);
  for (const barrier of ["CLEAR lv_test.", "PERFORM change CHANGING lv_test.", "lv_test+0(1) = 'x'."]) {
    const result = runControlled(`${start} ${barrier} IF iv_b = 1. lv_test = 3. ENDIF. zcl_sink=>use( iv_value = lv_test ).`);
    assert.equal(result[0].text, "lv_test = 3.");
    assert.equal(result[0].priorAssignments, undefined, barrier);
  }
});

test("named method and function outputs supersede direct writes with exact direction and formal", () => {
  for (const [write, direction, parameter] of [
    ["zcl_other=>read( IMPORTING ev = lv_test ).", "IMPORTING", "EV"],
    ["zcl_other=>change( CHANGING cv = lv_test ).", "CHANGING", "CV"],
    ["CALL METHOD zcl_other=>read RECEIVING rv = lv_test.", "RECEIVING", "RV"],
    ["CALL FUNCTION 'Z_F' IMPORTING ev = lv_test.", "IMPORTING", "EV"],
    ["CALL FUNCTION 'Z_F' CHANGING cv = lv_test.", "CHANGING", "CV"],
    ["CALL FUNCTION 'Z_F' TABLES tt = lv_test.", "TABLES", "TT"],
  ]) {
    const result = run(`DATA lv_test TYPE i VALUE 1. ${write} zcl_sink=>use( iv_value = lv_test ).`);
    assert.equal(result[0].text, write);
    assert.equal(result[0].kind, "call_output");
    assert.deepEqual(result[0].output, { direction, parameter });
    assert.equal(result[0].priorAssignments, undefined);
  }
});

test("conditional call output preserves prior candidates and its own lexical controls", () => {
  const result = runControlled("DATA lv_test TYPE i VALUE 1. IF iv_a = 1. zcl_other=>read( IMPORTING ev = lv_test ). ENDIF. zcl_sink=>use( iv_value = lv_test ).");
  assert.equal(result[0].kind, "call_output");
  assert.deepEqual(result[0].output, { direction: "IMPORTING", parameter: "EV" });
  assert.equal(result[0].controls?.[0].text, "IF iv_a = 1.");
  assert.equal(result[0].priorAssignments?.[0].text, "DATA lv_test TYPE i VALUE 1.");
});

test("output inline DATA establishes a local, component and undeclared outputs do not", () => {
  const inline = run("zcl_other=>read( IMPORTING ev = DATA(lv_test) ). zcl_sink=>use( iv_value = lv_test ).");
  assert.equal(inline[0].kind, "call_output");
  assert.equal(inline[0].variable, "LV_TEST");
  assert.deepEqual(run("zcl_other=>read( IMPORTING ev = lv_test ). zcl_sink=>use( iv_value = lv_test )."), []);
  assert.deepEqual(run("DATA lv_test TYPE i VALUE 1. zcl_other=>read( IMPORTING ev = lv_test+0(1) ). zcl_sink=>use( iv_value = lv_test )."), []);
  const unrelated = run("DATA lv_test TYPE i VALUE 1. zcl_other=>read( IMPORTING ev = ls-lv_test ). zcl_sink=>use( iv_value = lv_test ).");
  assert.equal(unrelated[0].kind, "direct");
});

test("nested output lists retain their own formal and direction instead of the outer section", () => {
  const result = run("DATA lv_test TYPE i VALUE 1. zcl_outer=>use( EXPORTING iv = zcl_inner=>read( IMPORTING ev_inner = lv_test ) ). zcl_sink=>use( iv_value = lv_test ).");
  assert.equal(result[0].kind, "call_output");
  assert.deepEqual(result[0].output, { direction: "IMPORTING", parameter: "EV_INNER" });
  assert.equal(result[0].text, "zcl_outer=>use( EXPORTING iv = zcl_inner=>read( IMPORTING ev_inner = lv_test ) ).");
});

test("ambiguous repeated outputs suppress evidence, but the enclosing direct LHS supersedes RHS outputs", () => {
  assert.deepEqual(run("DATA lv_test TYPE i VALUE 1. zcl_other=>read( IMPORTING ev = lv_test CHANGING cv = lv_test ). zcl_sink=>use( iv_value = lv_test )."), []);
  const result = run("DATA lv_test TYPE i VALUE 1. lv_test = zcl_other=>read( IMPORTING ev = lv_test ). zcl_sink=>use( iv_value = lv_test ).");
  assert.equal(result[0].kind, "direct");
  assert.equal(result[0].output, undefined);
  assert.equal(result[0].text, "lv_test = zcl_other=>read( IMPORTING ev = lv_test ).");
});
