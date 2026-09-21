import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAbapFiles } from "../src/graph/abap.js";

const target = `CLASS zcl_target DEFINITION PUBLIC.
PUBLIC SECTION.
CLASS-METHODS ping IMPORTING value TYPE string OPTIONAL.
METHODS run.
ENDCLASS.
CLASS zcl_target IMPLEMENTATION.
METHOD ping.
ENDMETHOD.
METHOD run.
ENDMETHOD.
ENDCLASS.`;
const method = (graph: ReturnType<typeof extractAbapFiles>, owner: string, name: string) => graph.nodes.find(n => n.owner === owner && n.name === name)!;

test("ABAP method locations use implementation spans and declarations preserve parameters", () => {
  const graph = extractAbapFiles(new Map([["src/zcl_target.clas.abap", target]]));
  const ping = method(graph, "ZCL_TARGET", "PING");
  assert.equal(ping.span, "L7-L8");
  assert.match(ping.signature!, /IMPORTING value TYPE string OPTIONAL/);
  const changed = extractAbapFiles(new Map([["src/zcl_target.clas.abap", target.replace("TYPE string", "TYPE i")]]));
  assert.equal(ping.id, method(changed, "ZCL_TARGET", "PING").id);
  assert.notEqual(ping.body_hash, method(changed, "ZCL_TARGET", "PING").body_hash);
});

test("ABAP class locals and tests share their abapGit object scope", () => {
  const graph = extractAbapFiles(new Map([
    ["src/zcl_owner.clas.locals_def.abap", "CLASS lcl_helper DEFINITION. PUBLIC SECTION. METHODS go. ENDCLASS."],
    ["src/zcl_owner.clas.locals_imp.abap", "CLASS lcl_helper IMPLEMENTATION. METHOD go. zcl_target=>ping( ). ENDMETHOD. ENDCLASS."],
    ["src/zcl_owner.clas.testclasses.abap", "CLASS ltcl_test DEFINITION FOR TESTING. PRIVATE SECTION. METHODS test FOR TESTING. ENDCLASS. CLASS ltcl_test IMPLEMENTATION. METHOD test. DATA(lo) = NEW lcl_helper( ). lo->go( ). ENDMETHOD. ENDCLASS."],
    ["src/zcl_target.clas.abap", target],
  ]));
  const helper = method(graph, "LCL_HELPER", "GO");
  const run = method(graph, "LTCL_TEST", "TEST");
  assert.equal(helper.path, "src/zcl_owner.clas.locals_imp.abap");
  assert.ok(graph.edges.some(e => e.source === run.id && e.target === helper.id && e.relation === "calls" && e.confidence === "inferred"));
  assert.ok(graph.edges.some(e => e.source === helper.id && e.target === method(graph, "ZCL_TARGET", "PING").id && e.relation === "calls"));
});

test("ABAP ignores commented calls and never guesses dynamic, remote, or untyped receivers", () => {
  const source = `REPORT zcaller.
* zcl_target=>ping( ).
DATA(example) = 'zcl_target=>ping( )'.
lo_unknown->run( ).
CALL METHOD me->(lv_method).
CALL FUNCTION lv_function.
CALL FUNCTION 'Z_LOCAL' DESTINATION 'REMOTE'.
zcl_target=>ping( ).`;
  const graph = extractAbapFiles(new Map([
    ["src/zcaller.prog.abap", source], ["src/zcl_target.clas.abap", target],
    ["src/zfunc.fugr.z_local.abap", "FUNCTION z_local. ENDFUNCTION."],
  ]));
  assert.equal(graph.edges.filter(e => e.relation === "calls").length, 1);
  assert.equal(graph.edges.find(e => e.relation === "calls")?.target, method(graph, "ZCL_TARGET", "PING").id);
  assert.ok(graph.diagnostics.some(d => d.kind === "unresolved_receiver"));
  assert.ok(graph.diagnostics.some(d => d.kind === "dynamic_call"));
  assert.ok(graph.diagnostics.some(d => d.kind === "remote_call"));
});

test("ABAP formal receiver parameters cannot leak across methods", () => {
  const source = `CLASS zcl_caller DEFINITION PUBLIC.
PUBLIC SECTION.
METHODS first IMPORTING lo TYPE REF TO zcl_target.
METHODS second.
ENDCLASS.
CLASS zcl_caller IMPLEMENTATION.
METHOD first. lo->run( ). ENDMETHOD.
METHOD second. lo->run( ). ENDMETHOD.
ENDCLASS.`;
  const graph = extractAbapFiles(new Map([["src/zcl_caller.clas.abap", source], ["src/zcl_target.clas.abap", target]]));
  const calls = graph.edges.filter(e => e.relation === "calls");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, method(graph, "ZCL_CALLER", "FIRST").id);
});

test("ABAP local classes with identical names are resolved only inside the owning report", () => {
  const report = (name: string) => `REPORT ${name}. CLASS lcl_report DEFINITION. PUBLIC SECTION. CLASS-METHODS run. ENDCLASS. CLASS lcl_report IMPLEMENTATION. METHOD run. ENDMETHOD. ENDCLASS. START-OF-SELECTION. lcl_report=>run( ).`;
  const graph = extractAbapFiles(new Map([["a.prog.abap", report("a")], ["b.prog.abap", report("b")]]));
  const calls = graph.edges.filter(e => e.relation === "calls");
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(graph.nodes.find(n => n.id === call.source)?.path, graph.nodes.find(n => n.id === call.target)?.path);
});

test("ABAP resolves FM literals, scoped FORMs, inheritance and dictionary references", () => {
  const xml = `<?xml version="1.0"?><abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DD02V><TABNAME>ZTABLE</TABNAME><DDTEXT>Example table</DDTEXT></DD02V><DD03P_TABLE><DD03P><FIELDNAME>ID</FIELDNAME><ROLLNAME>ZID</ROLLNAME></DD03P></DD03P_TABLE></asx:values></asx:abap></abapGit>`;
  const graph = extractAbapFiles(new Map([
    ["src/zcl_target.clas.abap", target],
    ["src/zcl_child.clas.abap", "CLASS zcl_child DEFINITION PUBLIC INHERITING FROM zcl_target. PUBLIC SECTION. METHODS execute. ENDCLASS. CLASS zcl_child IMPLEMENTATION. METHOD execute. super->run( ). ENDMETHOD. ENDCLASS."],
    ["src/zcaller.prog.abap", "REPORT zcaller. PERFORM f. CALL FUNCTION 'Z_LOCAL' DESTINATION 'NONE'. FORM f. UPDATE ztable SET id = 1. ENDFORM."],
    ["src/zother.prog.abap", "REPORT zother. FORM f. ENDFORM."],
    ["src/zfunc.fugr.z_local.abap", "FUNCTION z_local. ENDFUNCTION."],
    ["src/ztable.tabl.xml", xml],
  ]));
  assert.equal(graph.nodes.filter(n => n.kind === "file").length, 6);
  assert.ok(graph.edges.some(e => e.relation === "extends"));
  assert.ok(graph.edges.some(e => e.relation === "calls" && e.source === method(graph, "ZCL_CHILD", "EXECUTE").id && e.target === method(graph, "ZCL_TARGET", "RUN").id));
  const table = graph.nodes.find(n => n.name === "ZTABLE" && n.kind === "struct")!;
  assert.match(table.signature!, /ID/);
  assert.ok(graph.edges.some(e => e.relation === "references" && e.target === table.id));
  const formCalls = graph.edges.filter(e => e.relation === "calls" && e.target.includes("#F"));
  assert.equal(formCalls.length, 1);
  assert.match(formCalls[0].target, /zcaller/);
  assert.ok(graph.edges.some(e => e.relation === "calls" && e.target.includes("#Z_LOCAL")));
});

test("ABAP unknown local declarations and generic parameters mask typed class attributes", () => {
  const source = `CLASS zcl_caller DEFINITION PUBLIC.
PUBLIC SECTION.
DATA lo TYPE REF TO zcl_target.
METHODS factory.
METHODS like_decl.
METHODS generic IMPORTING lo TYPE REF TO object.
METHODS generic_value IMPORTING VALUE(lo) TYPE any.
METHODS original.
ENDCLASS.
CLASS zcl_caller IMPLEMENTATION.
METHOD factory.
DATA(lo) = zcl_other=>create( ).
lo->run( ).
ENDMETHOD.
METHOD like_decl.
DATA lo LIKE other.
lo->run( ).
ENDMETHOD.
METHOD generic.
lo->run( ).
ENDMETHOD.
METHOD generic_value.
lo->run( ).
ENDMETHOD.
METHOD original.
lo->run( ).
ENDMETHOD.
ENDCLASS.`;
  const graph = extractAbapFiles(new Map([["src/zcl_caller.clas.abap", source], ["src/zcl_target.clas.abap", target]]));
  const targetCalls = graph.edges.filter(e => e.relation === "calls" && e.target === method(graph, "ZCL_TARGET", "RUN").id);
  assert.deepEqual(targetCalls.map(e => e.source), [method(graph, "ZCL_CALLER", "ORIGINAL").id]);
  assert.equal(graph.diagnostics.filter(d => d.kind === "unresolved_receiver" && d.message.includes("LO->RUN")).length, 4);
});

test("ABAP unknown FORM locals mask program receiver declarations", () => {
  const graph = extractAbapFiles(new Map([
    ["src/zcl_target.clas.abap", target],
    ["src/zcaller.prog.abap", "REPORT zcaller. DATA lo TYPE REF TO zcl_target. FORM f. DATA lo LIKE other. lo->run( ). ENDFORM."],
  ]));
  assert.equal(graph.edges.filter(e => e.relation === "calls").length, 0);
  assert.ok(graph.diagnostics.some(d => d.kind === "unresolved_receiver" && d.message.includes("LO->RUN")));
});

test("ABAP local TYPES mask DDIC names within program, class and method scopes", () => {
  const xml = '<abapGit><DD02V><TABNAME>ZTABLE</TABNAME></DD02V></abapGit>';
  const klass = `CLASS zcl_types DEFINITION PUBLIC.
PUBLIC SECTION.
TYPES ztable TYPE i.
METHODS class_type.
ENDCLASS.
CLASS zcl_types IMPLEMENTATION.
METHOD class_type. DATA value TYPE ztable. ENDMETHOD.
ENDCLASS.`;
  const methodLocal = `CLASS zcl_local DEFINITION PUBLIC.
PUBLIC SECTION.
METHODS local_type.
METHODS global_type.
ENDCLASS.
CLASS zcl_local IMPLEMENTATION.
METHOD local_type. TYPES ztable TYPE i. DATA value TYPE ztable. ENDMETHOD.
METHOD global_type. DATA value TYPE ztable. ENDMETHOD.
ENDCLASS.`;
  const graph = extractAbapFiles(new Map([
    ["src/ztable.tabl.xml", xml],
    ["src/zprogram.prog.abap", "REPORT zprogram. TYPES ztable TYPE i. DATA value TYPE ztable."],
    ["src/zcl_types.clas.abap", klass],
    ["src/zcl_local.clas.abap", methodLocal],
  ]));
  const table = graph.nodes.find(n => n.kind === "struct" && n.name === "ZTABLE")!;
  const references = graph.edges.filter(e => e.relation === "references" && e.target === table.id);
  assert.deepEqual(references.map(e => e.source), [method(graph, "ZCL_LOCAL", "GLOBAL_TYPE").id]);
});

test("ABAP local TYPES do not shadow SQL database object names", () => {
  const graph = extractAbapFiles(new Map([
    ["src/ztable.tabl.xml", '<abapGit><DD02V><TABNAME>ZTABLE</TABNAME></DD02V></abapGit>'],
    ["src/zprogram.prog.abap", "REPORT zprogram. TYPES ztable TYPE i. DATA value TYPE ztable. UPDATE ztable SET id = 1."],
  ]));
  const table = graph.nodes.find(n => n.kind === "struct" && n.name === "ZTABLE")!;
  assert.equal(graph.edges.filter(e => e.relation === "references" && e.target === table.id).length, 1);
});

test("ABAP keeps every call occurrence and its nested branch evidence verbatim", () => {
  const source = `REPORT zevidence.
IF lv_outer = abap_true.
  zcl_target=>ping( value = 'outer' ).
  IF lv_inner = 1.
    zcl_target=>ping(
      value = 'inner' ).
  ELSEIF lv_inner = 2.
    zcl_target=>ping( value = 'elseif' ).
  ELSE.
    zcl_target=>ping( value = 'else' ).
  ENDIF.
ENDIF.
zcl_target=>ping( value = 'same' ). zcl_target=>ping( value = 'same' ).`;
  const graph = extractAbapFiles(new Map([["src/zevidence.prog.abap", source], ["src/zcl_target.clas.abap", target]]));
  const calls = graph.edges.filter(e => e.relation === "calls");
  assert.equal(calls.length, 1);
  const sites = calls[0].callSites!;
  assert.equal(sites.length, 6);
  assert.deepEqual(sites.map(s => s.span), ["L3-L3", "L5-L6", "L8-L8", "L10-L10", "L13-L13", "L13-L13"]);
  assert.equal(sites[1].text, "zcl_target=>ping(\n      value = 'inner' ).");
  assert.deepEqual(sites[1].controls?.map(c => c.text), ["IF lv_outer = abap_true.", "IF lv_inner = 1."]);
  assert.deepEqual(sites[2].controls?.[1].priorBranches?.map(c => c.text), ["IF lv_inner = 1."]);
  assert.equal(sites[3].controls?.[1].kind, "ELSE");
  assert.deepEqual(sites[3].controls?.[1].priorBranches?.map(c => c.text), ["IF lv_inner = 1.", "ELSEIF lv_inner = 2."]);
  assert.equal(sites[4].controls, undefined);
  assert.equal(sites[4].text, sites[5].text);
  assert.deepEqual(sites[4].occurrence, { line: 13, column: source.split("\n")[12].indexOf("ping") + 1 });
  assert.deepEqual(sites[5].occurrence, { line: 13, column: source.split("\n")[12].lastIndexOf("ping") + 1 });
  assert.deepEqual(graph, extractAbapFiles(new Map([["src/zcl_target.clas.abap", target], ["src/zevidence.prog.abap", source]])));
});

test("ABAP records CASE branches, loop and exception context for FM and FORM calls", () => {
  const source = `REPORT zevidence.
DO 2 TIMES.
  WHILE lv_active = abap_true.
    LOOP AT itab INTO DATA(item).
      TRY.
        CALL FUNCTION 'Z_LOCAL' EXPORTING iv_value = item.
      CATCH cx_root.
        PERFORM local USING item.
      ENDTRY.
    ENDLOOP.
  ENDWHILE.
ENDDO.
CASE lv_mode.
  WHEN 1.
    PERFORM local USING 1.
  WHEN 2.
    PERFORM local USING 2.
  WHEN OTHERS.
    PERFORM local USING 3.
ENDCASE.
FORM local USING value TYPE i.
ENDFORM.`;
  const graph = extractAbapFiles(new Map([["src/zevidence.prog.abap", source], ["src/zfunc.fugr.z_local.abap", "FUNCTION z_local. ENDFUNCTION."]]));
  const fm = graph.edges.find(e => e.relation === "calls" && e.target.includes("#Z_LOCAL"))!;
  assert.equal(fm.callSites?.[0].text, "CALL FUNCTION 'Z_LOCAL' EXPORTING iv_value = item.");
  assert.deepEqual(fm.callSites?.[0].controls?.map(c => c.kind), ["DO", "WHILE", "LOOP", "TRY"]);
  const form = graph.edges.find(e => e.relation === "calls" && e.target.includes("#LOCAL"))!;
  assert.equal(form.callSites?.length, 4);
  assert.deepEqual(form.callSites?.[0].controls?.map(c => c.kind), ["DO", "WHILE", "LOOP", "TRY", "CATCH"]);
  assert.deepEqual(form.callSites?.[3].controls?.map(c => c.kind), ["CASE", "WHEN OTHERS"]);
  assert.deepEqual(form.callSites?.[3].controls?.[1].priorBranches?.map(c => c.text), ["WHEN 1.", "WHEN 2."]);
});

test("ABAP declaration evidence preserves interface defaults and separate file locations", () => {
  const declaration = "METHODS execute IMPORTING iv_test TYPE abap_bool DEFAULT abap_false.";
  const graph = extractAbapFiles(new Map([
    ["src/zif_worker.intf.abap", `INTERFACE zif_worker PUBLIC.\n${declaration}\nENDINTERFACE.`],
    ["src/zcl_worker.clas.abap", "CLASS zcl_worker DEFINITION PUBLIC. PUBLIC SECTION. INTERFACES zif_worker. ENDCLASS. CLASS zcl_worker IMPLEMENTATION. METHOD zif_worker~execute. ENDMETHOD. ENDCLASS."],
  ]));
  const implementation = method(graph, "ZCL_WORKER", "ZIF_WORKER~EXECUTE");
  assert.equal(implementation.path, "src/zcl_worker.clas.abap");
  assert.deepEqual(implementation.declaration, { path: "src/zif_worker.intf.abap", span: "L2-L2", text: declaration });
  assert.match(implementation.signature!, /DEFAULT abap_false/);
});

test("ABAP chained declarations cannot attribute another method's default to the target", () => {
  const source = `CLASS zcl_chain DEFINITION PUBLIC.
PUBLIC SECTION.
CLASS-METHODS:
  alpha IMPORTING iv_value TYPE string DEFAULT 'A',
  beta IMPORTING iv_value TYPE string DEFAULT 'B'.
ENDCLASS.
CLASS zcl_chain IMPLEMENTATION.
METHOD alpha. ENDMETHOD.
METHOD beta. ENDMETHOD.
ENDCLASS.`;
  const graph = extractAbapFiles(new Map([["src/zcl_chain.clas.abap", source]]));
  const beta = method(graph, "ZCL_CHAIN", "BETA");
  assert.deepEqual(beta.declaration, { path: "src/zcl_chain.clas.abap", span: "L5-L5", text: "beta IMPORTING iv_value TYPE string DEFAULT 'B'." });
  assert.match(beta.signature!, /CLASS-METHODS beta/);
  assert.doesNotMatch(beta.signature!, /alpha|DEFAULT 'A'/);
});

test("ABAP controls do not bleed across methods or guard calls in their own header", () => {
  const source = `CLASS zcl_caller DEFINITION PUBLIC.
PUBLIC SECTION.
METHODS first.
METHODS second.
ENDCLASS.
CLASS zcl_caller IMPLEMENTATION.
METHOD first.
  IF outer = abap_true.
    IF zcl_target=>ping( ) = abap_true.
      zcl_target=>ping( value = 'inside' ).
    ENDIF.
  ENDIF.
ENDMETHOD.
METHOD second.
  zcl_target=>ping( ).
ENDMETHOD.
ENDCLASS.`;
  const graph = extractAbapFiles(new Map([["src/zcl_caller.clas.abap", source], ["src/zcl_target.clas.abap", target]]));
  const first = graph.edges.find(e => e.relation === "calls" && e.source === method(graph, "ZCL_CALLER", "FIRST").id)!;
  assert.equal(first.callSites?.length, 2);
  assert.deepEqual(first.callSites?.[0].controls?.map(c => c.text), ["IF outer = abap_true."]);
  assert.equal(first.callSites?.[1].controls?.length, 2);
  const second = graph.edges.find(e => e.relation === "calls" && e.source === method(graph, "ZCL_CALLER", "SECOND").id)!;
  assert.equal(second.callSites?.[0].controls, undefined);
});

test("ABAP repeated nested calls in one statement retain distinct serialized positions", () => {
  const statement = "DATA(result) = zcl_other=>combine( a = zcl_target=>ping( ) b = zcl_target=>ping( ) ).";
  const graph = extractAbapFiles(new Map([["src/znested.prog.abap", `REPORT znested.\n${statement}`], ["src/zcl_target.clas.abap", target]]));
  const edge = graph.edges.find(e => e.relation === "calls" && e.target === method(graph, "ZCL_TARGET", "PING").id)!;
  assert.equal(edge.callSites?.length, 2);
  assert.deepEqual(edge.callSites?.map(site => site.text), [statement, statement]);
  assert.deepEqual(edge.callSites?.map(site => site.occurrence), [
    { line: 2, column: statement.indexOf("ping") + 1 },
    { line: 2, column: statement.lastIndexOf("ping") + 1 },
  ]);
});

test("ABAP earlier exits preserve guards and distinguish processing blocks from loops", () => {
  const source = `CLASS zcl_exits DEFINITION PUBLIC.
PUBLIC SECTION.
METHODS first.
METHODS second.
ENDCLASS.
CLASS zcl_exits IMPLEMENTATION.
METHOD first.
IF invalid = abap_true. RETURN. ENDIF.
CHECK allowed = abap_true.
DO 2 TIMES.
  IF failed = abap_true. EXIT. ENDIF.
  CHECK keep = abap_true.
  IF severe = abap_true. RETURN. ENDIF.
ENDDO.
EXIT.
zcl_target=>ping( ).
ENDMETHOD.
METHOD second.
zcl_target=>ping( ).
ENDMETHOD.
ENDCLASS.`;
  const graph = extractAbapFiles(new Map([["src/zcl_exits.clas.abap", source], ["src/zcl_target.clas.abap", target]]));
  const first = graph.edges.find(e => e.relation === "calls" && e.source === method(graph, "ZCL_EXITS", "FIRST").id)!;
  const exits = first.callSites?.[0].earlierExits!;
  assert.deepEqual(exits.map(e => [e.kind, e.effect]), [
    ["RETURN", "processing_block"], ["CHECK", "processing_block"], ["EXIT", "loop_exit"],
    ["CHECK", "loop_iteration"], ["RETURN", "processing_block"], ["EXIT", "processing_block"],
  ]);
  assert.equal(exits[0].text, "RETURN.");
  assert.equal(exits[0].span, "L8-L8");
  assert.deepEqual(exits[0].controls?.map(c => c.text), ["IF invalid = abap_true."]);
  assert.deepEqual(exits[2].controls?.map(c => c.kind), ["DO", "IF"]);
  assert.equal(exits[3].text, "CHECK keep = abap_true.");
  const second = graph.edges.find(e => e.relation === "calls" && e.source === method(graph, "ZCL_EXITS", "SECOND").id)!;
  assert.deepEqual(second.callSites?.[0].earlierExits, []);
});

test("ABAP earlier exits respect same-line ordering, branch context, comments and report events", () => {
  const source = `REPORT zexits.
START-OF-SELECTION.
* RETURN.
DATA(spoof) = 'EXIT. CHECK false.'.
zcl_target=>ping( value = 'before' ). IF flag = abap_true. RETURN. ELSE. CHECK other = abap_true. ENDIF. zcl_target=>ping( value = 'after' ).
END-OF-SELECTION.
zcl_target=>ping( value = 'event' ).`;
  const graph = extractAbapFiles(new Map([["src/zexits.prog.abap", source], ["src/zcl_target.clas.abap", target]]));
  const sites = graph.edges.find(e => e.relation === "calls")!.callSites!;
  assert.equal(sites.length, 3);
  assert.deepEqual(sites[0].earlierExits, []);
  assert.deepEqual(sites[1].earlierExits?.map(e => e.kind), ["RETURN", "CHECK"]);
  assert.deepEqual(sites[1].earlierExits?.[1].controls?.[0].priorBranches?.map(c => c.text), ["IF flag = abap_true."]);
  assert.deepEqual(sites[2].earlierExits, []);
});

test("ABAP structured declaration metadata retains directions and raw defaults", () => {
  const source = `CLASS zcl_params DEFINITION PUBLIC.
PUBLIC SECTION.
METHODS execute IMPORTING VALUE(iv_test) TYPE abap_bool DEFAULT abap_false iv_text TYPE string DEFAULT 'Keep Case' EXPORTING ev TYPE i CHANGING cv TYPE i.
METHODS result RETURNING VALUE(rv_value) TYPE string.
ENDCLASS.
CLASS zcl_params IMPLEMENTATION.
METHOD execute. ENDMETHOD.
METHOD result. ENDMETHOD.
ENDCLASS.`;
  const graph = extractAbapFiles(new Map([["src/zcl_params.clas.abap", source]]));
  assert.deepEqual(method(graph, "ZCL_PARAMS", "EXECUTE").abapParameters, [
    { name: "IV_TEST", direction: "IMPORTING", defaultValue: "abap_false" },
    { name: "IV_TEXT", direction: "IMPORTING", defaultValue: "'Keep Case'" },
    { name: "EV", direction: "EXPORTING" }, { name: "CV", direction: "CHANGING" },
  ]);
  assert.deepEqual(method(graph, "ZCL_PARAMS", "RESULT").abapParameters, [{ name: "RV_VALUE", direction: "RETURNING" }]);
});

test("ABAP named actual metadata never includes nested invocation parameters", () => {
  const receiver = `CLASS zcl_params DEFINITION PUBLIC.
PUBLIC SECTION.
CLASS-METHODS outer IMPORTING iv_value TYPE string iv_test TYPE abap_bool DEFAULT abap_false.
CLASS-METHODS inner IMPORTING iv_test TYPE abap_bool RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_params IMPLEMENTATION.
METHOD outer. ENDMETHOD.
METHOD inner. ENDMETHOD.
ENDCLASS.`;
  const source = `REPORT zparams.
zcl_params=>outer( iv_value = zcl_params=>inner( iv_test = abap_true ) ).
zcl_params=>outer( 'positional' ).
CALL METHOD zcl_params=>outer PARAMETER-TABLE params.
zcl_params=>outer( ).
CALL METHOD zcl_params=>outer EXPORTING iv_value = 'classic'.`;
  const graph = extractAbapFiles(new Map([["src/zcl_params.clas.abap", receiver], ["src/zparams.prog.abap", source]]));
  const outerSites = graph.edges.find(e => e.relation === "calls" && e.target === method(graph, "ZCL_PARAMS", "OUTER").id)!.callSites!;
  assert.deepEqual(outerSites[0].arguments, { IV_VALUE: "zcl_params=>inner( iv_test = abap_true )" });
  assert.equal(outerSites[0].argumentsComplete, true);
  assert.equal(outerSites[1].argumentsComplete, false);
  assert.equal(outerSites[2].argumentsComplete, false);
  assert.deepEqual(outerSites[3].arguments, {});
  assert.equal(outerSites[3].argumentsComplete, true);
  assert.deepEqual(outerSites[4].arguments, { IV_VALUE: "'classic'" });
  assert.equal(outerSites[4].argumentsComplete, true);
  const innerSite = graph.edges.find(e => e.relation === "calls" && e.target === method(graph, "ZCL_PARAMS", "INNER").id)!.callSites![0];
  assert.deepEqual(innerSite.arguments, { IV_TEST: "abap_true" });
});

test("ABAP unchanged parameter metadata abstains after writes, aliases and mutating actuals", () => {
  const bodies: Record<string, string> = {
    safe: "DATA(copy) = iv_test. IF iv_test = abap_true. zcl_target=>ping( ). ENDIF.",
    assigned: "iv_test = abap_true. zcl_target=>ping( ).",
    changed: "zcl_other=>alter( CHANGING cv = iv_test ). zcl_target=>ping( ).",
    aliased: "ASSIGN iv_test TO FIELD-SYMBOL(<alias>). zcl_target=>ping( ).",
    referenced: "GET REFERENCE OF iv_test INTO DATA(reference). zcl_target=>ping( ).",
    nested: "IF zcl_other=>alter( CHANGING cv = iv_test ) = abap_true. zcl_target=>ping( ). ENDIF.",
    dynamic: "CALL METHOD zcl_other=>alter PARAMETER-TABLE params. zcl_target=>ping( ).",
    later: "zcl_target=>ping( value = 'before' ). CLEAR iv_test. zcl_target=>ping( value = 'after' ).",
    repeated: "DO 2 TIMES. IF iv_test = abap_true. zcl_target=>ping( ). ENDIF. iv_test = abap_true. ENDDO.",
  };
  const source = `CLASS zcl_mutation DEFINITION PUBLIC. PUBLIC SECTION. ${Object.keys(bodies).map(name => `METHODS ${name} IMPORTING VALUE(iv_test) TYPE abap_bool DEFAULT abap_false.`).join(" ")} ENDCLASS. CLASS zcl_mutation IMPLEMENTATION. ${Object.entries(bodies).map(([name, body]) => `METHOD ${name}. ${body} ENDMETHOD.`).join(" ")} ENDCLASS.`;
  const graph = extractAbapFiles(new Map([["src/zcl_mutation.clas.abap", source], ["src/zcl_target.clas.abap", target]]));
  const sites = (name: string) => graph.edges.find(e => e.relation === "calls" && e.source === method(graph, "ZCL_MUTATION", name).id && e.target === method(graph, "ZCL_TARGET", "PING").id)!.callSites!;
  assert.deepEqual(sites("SAFE")[0].unchangedParameters, ["IV_TEST"]);
  for (const name of ["ASSIGNED", "CHANGED", "ALIASED", "REFERENCED", "NESTED", "DYNAMIC", "REPEATED"]) assert.deepEqual(sites(name)[0].unchangedParameters, [], name);
  assert.deepEqual(sites("LATER")[0].unchangedParameters, ["IV_TEST"]);
  assert.deepEqual(sites("LATER")[1].unchangedParameters, []);
});

test("ABAP call metadata includes the last prior local actual assignment with its controls", () => {
  const source = `CLASS zcl_assignments DEFINITION PUBLIC.
PUBLIC SECTION.
METHODS first.
METHODS second.
ENDCLASS.
CLASS zcl_assignments IMPLEMENTATION.
METHOD first.
DATA(lv_test) = abap_false.
IF requested = abap_true.
  lv_test = zcl_other=>flag( iv_value = raw_test iv_default = abap_false ).
ENDIF.
zcl_target=>ping( value = lv_test ).
ENDMETHOD.
METHOD second.
zcl_target=>ping( value = lv_test ).
ENDMETHOD.
ENDCLASS.`;
  const graph = extractAbapFiles(new Map([["src/zcl_assignments.clas.abap", source], ["src/zcl_target.clas.abap", target]]));
  const first = graph.edges.find(e => e.relation === "calls" && e.source === method(graph, "ZCL_ASSIGNMENTS", "FIRST").id && e.target === method(graph, "ZCL_TARGET", "PING").id)!.callSites![0];
  assert.equal(first.localAssignments?.length, 1);
  assert.equal(first.localAssignments?.[0].variable, "LV_TEST");
  assert.equal(first.localAssignments?.[0].span, "L10-L10");
  assert.equal(first.localAssignments?.[0].text, "lv_test = zcl_other=>flag( iv_value = raw_test iv_default = abap_false ).");
  assert.deepEqual(first.localAssignments?.[0].controls?.map(c => c.text), ["IF requested = abap_true."]);
  const second = graph.edges.find(e => e.relation === "calls" && e.source === method(graph, "ZCL_ASSIGNMENTS", "SECOND").id && e.target === method(graph, "ZCL_TARGET", "PING").id)!.callSites![0];
  assert.deepEqual(second.localAssignments, []);
});

test("ABAP local assignment evidence respects same-statement evaluation and event boundaries", () => {
  const source = `REPORT zassignments.
START-OF-SELECTION.
DATA(value) = 'old'.
value = zcl_target=>ping( value = value ).
END-OF-SELECTION.
zcl_target=>ping( value = value ).`;
  const graph = extractAbapFiles(new Map([["src/zassignments.prog.abap", source], ["src/zcl_target.clas.abap", target]]));
  const sites = graph.edges.find(e => e.relation === "calls")!.callSites!;
  assert.equal(sites[0].localAssignments?.[0].text, "DATA(value) = 'old'.");
  assert.deepEqual(sites[1].localAssignments, []);
});
