import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAnchor, validExcerpt, evidenceBlocks, callSiteExcerpts, requiredEvidence, chainNoticeChecks, structuralListLines, outgoingNoticeChecks, selectorEvidenceChecks, exitFilterStatusChecks, stableEvidenceChecks } from '../pilot/evaluate-evidence.mjs';
import { evidenceId } from '../src/graph/evidence-id.js';

test('evidence evaluation binds branch text to its actual file and line', () => {
  const anchor = { path: 'a.abap', startLine: 4, endLine: 4, contains: 'ELSE.' };
  assert.equal(matchesAnchor({ path: 'b.abap', span: 'L4-L4', text: 'ELSE.' }, anchor), false);
  assert.equal(matchesAnchor({ path: 'a.abap', span: 'L1-L5', text: 'IF test.\nELSE.\nENDIF.\nDATA x.\nDATA y.' }, anchor), false);
  assert.equal(matchesAnchor({ path: 'a.abap', span: 'L3-L5', text: 'ping( ).\nELSE.\npong( ).' }, anchor), true);
});

test('evidence evaluation checks upper line bounds and original text', () => {
  const source = 'REPORT a.\nping( ).\n';
  assert.equal(validExcerpt({ span: 'L2-L2', text: 'ping( ).' }, source), true);
  assert.equal(validExcerpt({ span: 'L2-L999', text: 'ping( ).' }, source), false);
  assert.equal(validExcerpt({ span: 'L0-L2', text: 'ping( ).' }, source), false);
  assert.equal(validExcerpt({ span: 'L2-L2', text: 'pong( ).' }, source), false);
});

test('receiver type source is validated independently of a valid call-site excerpt', () => {
  const source = 'REPORT a.\nNEW leaf( )->ping( ).\n';
  const site = { path: 'a.abap', span: 'L2-L2', text: 'NEW leaf( )->ping( ).',
    receiverType: { name: 'LEAF', basis: 'new', source: { path: 'a.abap', span: 'L1-L1', text: 'NEW leaf( )' } } };
  assert.equal(validExcerpt(site, source), true);
  assert.equal(callSiteExcerpts(site).every(excerpt => validExcerpt(excerpt, source)), false);
  site.receiverType.source.span = 'L2-L2';
  assert.equal(callSiteExcerpts(site).every(excerpt => validExcerpt(excerpt, source)), true);
});

test('evidence evaluation accepts multiline anchors only within their recorded range', () => {
  const excerpt = { path: 'a.abap', span: 'L10-L13', text: 'run(\n  iv_test =\n    abap_false\n).' };
  const anchor = { path: 'a.abap', startLine: 11, endLine: 12, contains: 'iv_test = abap_false' };
  assert.equal(matchesAnchor(excerpt, anchor), true);
  assert.equal(matchesAnchor(excerpt, { ...anchor, endLine: 11 }), false);
});

test('evidence evaluation reads complete source blocks without conflating neighboring locations', () => {
  const output = [
    'src/a.abap appears elsewhere in the response',
    'Enclosing control ELSE: src/b.abap:L4-L4',
    '```abap', 'ELSE.', '```',
    'Call site 1: src/a.abap:L8-L8',
    '````abap', "ping( value = '```' ).", '````',
    'Callee declaration: src/a.abap:L2-L2',
    '```abap', 'unfinished source block',
  ].join('\n');
  const blocks = evidenceBlocks(output);
  assert.equal(blocks.length, 2);
  assert.equal(blocks.some(block => matchesAnchor(block, { path: 'src/a.abap', startLine: 4, endLine: 4, contains: 'ELSE.' })), false);
  assert.equal(blocks[1].text, "ping( value = '```' ).");
});

test('evidence evaluation validates exits and assignments with their own nested branch context', () => {
  const source = 'IF first.\nELSE.\nRETURN.\nENDIF.\nIF second.\nlv_test = flag( ).\nENDIF.\nevaluate( ).';
  const excerpt = (line, text) => ({ path: 'a.abap', span: `L${line}-L${line}`, text });
  const site = { ...excerpt(8, 'evaluate( ).'),
    earlierExits: [{ ...excerpt(3, 'RETURN.'), controls: [{ ...excerpt(2, 'ELSE.'), priorBranches: [excerpt(1, 'IF first.')] }] }],
    localAssignments: [{ ...excerpt(6, 'lv_test = flag( ).'), controls: [{ ...excerpt(5, 'IF second.'), priorBranches: [] }] }] };
  const excerpts = callSiteExcerpts(site);
  assert.equal(excerpts.length, 6);
  assert.ok(excerpts.every(value => validExcerpt(value, source)));
  site.earlierExits[0].controls[0].priorBranches[0].text = 'IF fabricated.';
  assert.equal(callSiteExcerpts(site).filter(value => !validExcerpt(value, source)).length, 1);
});

test('early returns and assignments are required independently of extraction success within represented callers', () => {
  const callers = [{ path: 'caller.abap', span: 'L1-L30' }];
  const sites = [{ path: 'caller.abap', span: 'L20-L22', text: 'target( ).' }];
  for (const kind of ['early_return', 'local_assignment']) {
    assert.equal(requiredEvidence({ kind, path: 'caller.abap', startLine: 10, endLine: 15 }, callers, sites), true);
    assert.equal(requiredEvidence({ kind, path: 'callee.abap', startLine: 10, endLine: 15 }, callers, sites), false);
    assert.equal(requiredEvidence({ kind, path: 'caller.abap', startLine: 23, endLine: 25 }, callers, sites), false);
  }
  assert.equal(requiredEvidence({ kind: 'value_conversion', path: 'helper.abap', startLine: 1, endLine: 4 }, callers, sites), false);
});

test('default warning checks require one site-specific marker and reject a marker for explicit forwarding', () => {
  const omitted = { path: 'http.abap', line: 605, parameter: 'IV_TEST', defaultValue: 'abap_false', guard: 'IF iv_test = abap_true', target: 'RUN_SIMULATION' };
  const explicit = { path: 'http.abap', line: 887, symbol: 'BUILD_TIMEEVAL' };
  const notice = '[possibly infeasible: IV_TEST omitted at http.abap:L605:C80 → DEFAULT abap_false vs. IF iv_test = abap_true; calling RUN_SIMULATION.]';
  assert.equal(chainNoticeChecks(notice, omitted, explicit).passed, true);
  assert.equal(chainNoticeChecks('IV_TEST omitted http.abap:L605:C80 DEFAULT abap_false IF iv_test = abap_true RUN_SIMULATION', omitted, explicit).markerPresent, false);
  const falseNotice = notice.replace('L605:C80', 'L887:C5');
  assert.equal(chainNoticeChecks(`${notice}\n${falseNotice}`, omitted, explicit).noFalseExplicitMarker, false);
});

test('assignment source validation includes recursive history and its prior branch headers', () => {
  const excerpt = (line, text) => ({ path: 'a.abap', span: `L${line}-L${line}`, text });
  const initial = { ...excerpt(1, 'lv_schema = default_schema.'), variable: 'LV_SCHEMA' };
  const output = { ...excerpt(4, 'parse( IMPORTING ev_value = lv_schema ).'), variable: 'LV_SCHEMA', kind: 'call_output',
    output: { direction: 'IMPORTING', parameter: 'EV_VALUE' }, priorAssignments: [initial],
    controls: [{ ...excerpt(3, 'ELSE.'), kind: 'ELSE', priorBranches: [excerpt(2, 'IF supplied.')] }] };
  const latest = { ...excerpt(5, 'lv_schema = normalized.'), variable: 'LV_SCHEMA', priorAssignments: [output] };
  const site = { ...excerpt(6, 'evaluate( ).'), localAssignments: [latest] };
  const source = 'lv_schema = default_schema.\nIF supplied.\nELSE.\nparse( IMPORTING ev_value = lv_schema ).\nlv_schema = normalized.\nevaluate( ).';
  assert.equal(callSiteExcerpts(site).length, 6);
  assert.ok(callSiteExcerpts(site).every(value => validExcerpt(value, source)));
  initial.text = 'lv_schema = fabricated.';
  assert.equal(callSiteExcerpts(site).filter(value => !validExcerpt(value, source)).length, 1);
});

test('outgoing conditional default notices are confined to detail while proven-omission lists stay intact', () => {
  const list = '  calls → RUN_SIMULATION (a.abap:L10-L20)';
  const notice = 'default-conditioned notice: when IV_TEST is omitted. Actual caller arguments are unknown.';
  assert.equal(outgoingNoticeChecks(`${list}\nTrace evidence\n${notice}`, list).passed, true);
  assert.equal(outgoingNoticeChecks(`${list} [${notice}]\nTrace evidence\n${notice}`, list).passed, false);
  assert.equal(outgoingNoticeChecks(`${list}\nTrace evidence\n${notice}`, `${list}\n${notice}`).passed, false);
  assert.equal(outgoingNoticeChecks(list, list).passed, false);
  const incoming = '  calls ← BUILD_GENERATE (a.abap:L50-L80) [possibly infeasible: IV_TEST omitted]';
  assert.deepEqual(structuralListLines(`${incoming}\nSelected chain T1\nSource: other`), [incoming]);
});

test('selector validation keeps compact targets while filtering detail chains and earlier exit blocks', () => {
  const compact = '  calls ← BUILD_GENERATE (http.abap:L1-L20) [possibly infeasible: IV_TEST omitted]\n  calls ← BUILD_TIMEEVAL (http.abap:L800-L914)';
  const block = (label, path, line, text) => `${label}: ${path}:L${line}-L${line}\n\`\`\`abap\n${text}\n\`\`\``;
  const detail = [compact, 'Selected chain T1 (2 hops; reached ZCL_HTTP.BUILD_TIMEEVAL):',
    block('Call site 1', 'http.abap', 887, 'evaluate( ).'), block('Call site 1', 'eval.abap', 146, 'run_simulation( ).'),
    block('Local assignment source', 'http.abap', 834, 'lv_schema = default.'), block('Local assignment source', 'http.abap', 859, 'lv_test = flag( ).')];
  assert.equal(selectorEvidenceChecks(detail.join('\n'), compact, 'no_exits', 'http.abap', 'eval.abap').passed, true);
  for (const line of [840, 845, 850, 855, 867, 875, 882]) detail.push(block('Earlier exit source', 'http.abap', line, 'RETURN.'));
  for (const line of [134, 142]) detail.push(block('Earlier exit source', 'eval.abap', line, 'RETURN.'));
  assert.equal(selectorEvidenceChecks(detail.join('\n'), compact, 'evidence_targets', 'http.abap', 'eval.abap').passed, true);
  detail.push(block('Earlier exit source', 'http.abap', 554, 'RETURN.'));
  assert.equal(selectorEvidenceChecks(detail.join('\n'), compact, 'exit_sources', 'http.abap', 'eval.abap').exitsCorrect, false);
});

test('exit filter status counts only suppressed nonempty sections and preserves empty versus unavailable states', () => {
  const filtered = 'Earlier exits omitted by exit_sources filter; absence here is not evidence of unconditional execution.';
  const none = 'Earlier exits (not evaluated): no earlier RETURN/EXIT/CHECK recorded in this processing block.';
  const unavailable = 'Earlier exits: evidence unavailable in this graph.';
  const output = [filtered, none, unavailable, 'Omitted: 1 nonempty call-site exit section(s) by exit_sources.'].join('\n');
  assert.equal(exitFilterStatusChecks(output, { filtered: 1, noneRecorded: 1, unavailable: 1 }).passed, true);
  assert.equal(exitFilterStatusChecks(output.replace(none, filtered), { filtered: 1, noneRecorded: 1, unavailable: 1 }).passed, false);
  assert.equal(exitFilterStatusChecks(output.replace(unavailable, filtered), { filtered: 1, noneRecorded: 1, unavailable: 1 }).passed, false);
  assert.equal(exitFilterStatusChecks(output.replace('1 nonempty call-site', '3 nonempty call-site'), { filtered: 1, noneRecorded: 1, unavailable: 1 }).passed, false);
});

test('stable evidence comparisons survive local-label renumbering but reject changed or missing source identities', () => {
  const exit = { path: 'a.abap', span: 'L8-L8', text: 'RETURN.' };
  const assignment = { path: 'a.abap', span: 'L4-L4', text: 'lv_test = flag( ).' };
  const block = (kind, short, excerpt) => `[${short}] Evidence\nStable evidence ID: ${evidenceId(kind, excerpt)}\n${kind === 'exit' ? 'Earlier exit source' : 'Local assignment source'}: ${excerpt.path}:${excerpt.span}\n\`\`\`abap\n${excerpt.text}\n\`\`\``;
  const reference = `${block('exit', 'E8', exit)}\n${block('assignment', 'A6', assignment)}`;
  const filtered = `${block('assignment', 'A1', assignment)}\n${block('exit', 'E1', exit)}`;
  const compared = stableEvidenceChecks(filtered, reference);
  assert.equal(compared.passed, true);
  assert.equal(compared.retainedSourceBlocks, 2);
  assert.equal(evidenceBlocks(filtered)[0].stableEvidenceId, evidenceId('assignment', assignment));
  assert.equal(stableEvidenceChecks(filtered.replace(evidenceId('exit', exit), 'exit:0000000000000000'), reference).passed, false);
  assert.equal(stableEvidenceChecks(filtered.replace(`Stable evidence ID: ${evidenceId('exit', exit)}\n`, ''), reference).passed, false);
  assert.equal(stableEvidenceChecks('', reference).passed, false);
});
