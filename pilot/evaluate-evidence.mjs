/** Compare tool output and stored evidence with an independently read source baseline. */
export const normalize = text => text.replace(/\s+/g, ' ').trim().toUpperCase();
export const span = text => {
  const match = /^L(\d+)-L(\d+)$/.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
};

/** Match the anchor at its actual line, not a coincidental occurrence elsewhere
 * in a large method or an unrelated ELSE in the same response. */
export function matchesAnchor(excerpt, anchor) {
  const [start, end] = span(excerpt.span);
  if (excerpt.path !== anchor.path || start < 1 || end < start) return false;
  const escaped = anchor.contains.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  for (const match of excerpt.text.matchAll(new RegExp(escaped, 'gi'))) {
    const matchStart = start + excerpt.text.slice(0, match.index).split('\n').length - 1;
    const matchEnd = matchStart + match[0].split('\n').length - 1;
    if (matchStart >= anchor.startLine && matchEnd <= anchor.endLine && matchEnd <= end) return true;
  }
  return false;
}

export function validExcerpt(excerpt, source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const [start, end] = span(excerpt.span);
  return start >= 1 && end >= start && end <= lines.length
    && lines.slice(start - 1, end).join('\n').includes(excerpt.text.replace(/\r\n/g, '\n'));
}

/** Every persisted source fragment associated with this particular invocation,
 * including nested branch context on earlier exits and local assignments. */
export function callSiteExcerpts(site) {
  const controls = items => (items ?? []).flatMap(control => [control, ...(control.priorBranches ?? [])]);
  const seen = new Set();
  const assignments = assignment => {
    if (seen.has(assignment)) return [];
    seen.add(assignment);
    return [assignment, ...controls(assignment.controls), ...(assignment.priorAssignments ?? []).flatMap(assignments)];
  };
  return [site, ...(site.receiverType ? [site.receiverType.source, ...(site.receiverType.via ?? []), ...(site.receiverType.inlineDeclaration ? [site.receiverType.inlineDeclaration] : [])] : []),
    ...(site.construction?.inferredType ? [site.construction.inferredType.source, ...(site.construction.inferredType.via ?? []),
      ...(site.construction.inferredType.inlineDeclaration ? [site.construction.inferredType.inlineDeclaration] : [])] : []), ...controls(site.controls),
    ...(site.earlierExits ?? []).flatMap(exit => [exit, ...controls(exit.controls)]),
    ...(site.localAssignments ?? []).flatMap(assignments)];
}

/** Validate unresolved references independently of any project's acceptance cases. */
export function verifyUnresolvedReferences(graph, readSource) {
  const nodes = new Set(graph.nodes.map(node => node.id));
  const seen = new Set(), invalid = [];
  for (const ref of graph.unresolvedCalls ?? []) {
    let reason;
    if (seen.has(ref.id)) reason = 'duplicate id';
    else if (!nodes.has(ref.source)) reason = 'missing caller';
    else {
      try {
        if (!callSiteExcerpts(ref.site).every(excerpt => validExcerpt(excerpt, readSource(excerpt.path)))) reason = 'invalid source excerpt';
      } catch { reason = 'unreadable source excerpt'; }
    }
    seen.add(ref.id);
    if (reason) invalid.push({ id: ref.id, reason });
  }
  return { total: (graph.unresolvedCalls ?? []).length, invalid };
}

/** Diagnostic evidence is an exact original line, including its indentation. */
export function verifyDiagnosticEvidence(graph, readSource) {
  const items = graph.abap?.diagnostics ?? [], invalid = [];
  let withEvidence = 0;
  for (const item of items) {
    if (!item.source) continue;
    withEvidence++;
    try {
      const original = readSource(item.path).split(/\r?\n/);
      if (!Number.isSafeInteger(item.line) || item.line < 1 || item.line > original.length
        || item.source.path !== item.path || item.source.span !== `L${item.line}-L${item.line}`
        || item.source.text !== original[item.line - 1]) invalid.push({ path: item.path, line: item.line, reason: 'invalid diagnostic source line' });
      if (item.column !== undefined && (!Number.isSafeInteger(item.column) || item.column < 1
        || item.column > (original[item.line - 1]?.length ?? 0)
        || item.kind === 'unresolved_construction' && !/^NEW\b/i.test(original[item.line - 1]?.slice(item.column - 1) ?? '')))
        invalid.push({ path: item.path, line: item.line, reason: 'invalid diagnostic occurrence position' });
    } catch { invalid.push({ path: item.path, line: item.line, reason: 'unreadable diagnostic source' }); }
  }
  return { total: items.length, withEvidence, withoutEvidence: items.length - withEvidence, invalid };
}

const requiredKinds = new Set(['omitted_argument', 'argument', 'parameter_default', 'overridden_default', 'enclosing_if', 'branch_then', 'branch_else', 'loop_context']);

/** Prior statements in a represented caller are required. A callee's internal
 * guards, or another helper's implementation, remain supplemental at depth 1.
 * Determine relevance from source locations, never from whether extraction or
 * rendering happened to include the expected evidence. */
export function requiredEvidence(anchor, callerNodes, callSites) {
  if (requiredKinds.has(anchor.kind)) return true;
  if (!['early_return', 'local_assignment'].includes(anchor.kind)) return false;
  return callerNodes.some(node => {
    const [start, end] = span(node.span);
    return node.path === anchor.path && anchor.startLine >= start && anchor.endLine <= end
      && callSites.some(site => site.path === node.path && span(site.span)[0] > anchor.endLine && span(site.span)[0] <= end);
  });
}

/** Check the warning itself, rather than finding its words elsewhere in the
 * detailed source excerpts. The compact response must independently pass. */
export function chainNoticeChecks(output, omitted, explicit) {
  const notices = output.split(/\r?\n/).filter(line => /possibly infeasible:/i.test(line));
  const markerPresent = notices.some(line => line.includes(`${omitted.path}:L${omitted.line}:`)
    && normalize(line).includes(normalize(`${omitted.parameter} omitted`))
    && normalize(line).includes(normalize(`DEFAULT ${omitted.defaultValue}`))
    && normalize(line).includes(normalize(omitted.guard)) && line.includes(omitted.target));
  const noFalseExplicitMarker = !notices.some(line => line.includes(`${explicit.path}:L${explicit.line}:`) || line.includes(explicit.symbol));
  return { markerPresent, noFalseExplicitMarker, passed: markerPresent && noFalseExplicitMarker };
}

export function structuralListLines(output) {
  return output.split(/\r?\n/).filter(line => /^  (?:calls|references|imports|implements|extends)\s/.test(line));
}

export function outgoingNoticeChecks(detailed, compact) {
  const conditional = /default-conditioned notice|when IV_TEST is omitted/i;
  const listHasNoConditionalNotice = !conditional.test(structuralListLines(detailed).join('\n'));
  const compactHasNoConditionalNotice = !conditional.test(compact);
  const detailedRetainsPremise = /default-conditioned notice/i.test(detailed)
    && /when IV_TEST is omitted/i.test(detailed) && /Actual caller arguments are unknown/i.test(detailed);
  return { listHasNoConditionalNotice, compactHasNoConditionalNotice, detailedRetainsPremise,
    passed: listHasNoConditionalNotice && compactHasNoConditionalNotice && detailedRetainsPremise };
}

/** Selector checks inspect only their intended evidence surface. The compact
 * hit list still contains every structural target and its proven-omission notice. */
export function selectorEvidenceChecks(output, reference, mode, httpPath, evalPath) {
  const blocks = evidenceBlocks(output);
  const exits = blocks.filter(block => block.label.startsWith('Earlier exit source'));
  const exitKeys = new Set(exits.map(block => `${block.path}:${block.span}`));
  const expectedExits = [...[840, 845, 850, 855, 867, 875, 882].map(line => `${httpPath}:L${line}-L${line}`),
    ...[134, 142].map(line => `${evalPath}:L${line}-L${line}`)];
  const compactUnchanged = JSON.stringify(structuralListLines(output)) === JSON.stringify(structuralListLines(reference));
  const provenOmissionRetained = structuralListLines(output).some(line => /BUILD_GENERATE.*possibly infeasible: IV_TEST omitted/.test(line));
  const assignmentsRetained = [834, 859].every(line => blocks.some(block => /assignment/i.test(block.label)
    && block.path === httpPath && span(block.span)[0] === line));
  const exitsCorrect = ['no_exits', 'all_no_exits'].includes(mode) ? exits.length === 0
    : exitKeys.size === expectedExits.length && expectedExits.every(key => exitKeys.has(key));
  const selectedChains = output.split(/\r?\n/).filter(line => line.startsWith('Selected chain '));
  const sites = blocks.filter(block => block.label.startsWith('Call site '));
  const targetDetailsCorrect = ['exit_sources', 'all_no_exits'].includes(mode) || (selectedChains.length === 1 && selectedChains[0].includes('BUILD_TIMEEVAL')
    && sites.length === 2 && sites.some(block => block.path === httpPath && span(block.span)[0] === 887)
    && sites.some(block => block.path === evalPath && span(block.span)[0] === 146));
  return { compactUnchanged, provenOmissionRetained, assignmentsRetained, exitsCorrect, targetDetailsCorrect,
    passed: compactUnchanged && provenOmissionRetained && assignmentsRetained && exitsCorrect && targetDetailsCorrect };
}

/** Counter units are filtered nonempty call-site exit sections, not unique
 * exits. Known-empty and unavailable legacy metadata retain distinct messages. */
export function exitFilterStatusChecks(output, expected) {
  const counts = {
    omittedSections: (output.match(/^Earlier exits omitted by exit_sources filter;.*$/gm) ?? []).length,
    noneRecorded: (output.match(/^Earlier exits \(not evaluated\): no earlier RETURN\/EXIT\/CHECK recorded in this processing block\.$/gm) ?? []).length,
    unavailable: (output.match(/^Earlier exits: evidence unavailable in this graph\.$/gm) ?? []).length,
    footerSections: Number(output.match(/(\d+) (?:nonempty )?call-site exit section\(s\) by exit_sources/)?.[1] ?? NaN),
  };
  return { ...counts, expected,
    passed: counts.omittedSections === expected.filtered && counts.footerSections === expected.filtered
      && counts.noneRecorded === expected.noneRecorded && counts.unavailable === (expected.unavailable ?? 0) };
}

/** Match stable identities by retained source content and evidence kind. The
 * presentation-local [E1]/[A1] labels may legitimately change with filtering. */
export function stableEvidenceChecks(output, reference) {
  const records = text => evidenceBlocks(text).filter(block => ['Earlier exit source', 'Local assignment source'].includes(block.label));
  const key = block => JSON.stringify([block.label, block.path, block.span, block.text]);
  const original = records(reference);
  const retained = records(output);
  const failures = retained.filter(block => {
    const kind = block.label === 'Earlier exit source' ? 'exit' : 'assignment';
    return !new RegExp(`^${kind}:[0-9a-f]{16}$`).test(block.stableEvidenceId ?? '')
      || !original.some(prior => key(prior) === key(block) && prior.stableEvidenceId === block.stableEvidenceId);
  }).map(({ label, path, span, stableEvidenceId }) => ({ label, path, span, stableEvidenceId }));
  return { retainedSourceBlocks: retained.length, failures, passed: retained.length > 0 && failures.length === 0 };
}

/** Read only explicitly delimited source blocks with their own path/span. */
export function evidenceBlocks(output) {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const heading = /^(.+): (.+):(L\d+-L\d+)$/.exec(lines[i]);
    const opening = /^(`{3,})(?:abap|xml|text)$/.exec(lines[i + 1]);
    if (!heading || !opening) continue;
    let last = i + 2;
    while (last < lines.length && lines[last] !== opening[1]) last++;
    if (last === lines.length) continue;
    const stableEvidenceId = /^Stable evidence ID: ([a-z]+:[0-9a-f]{16})$/.exec(lines[i - 1] ?? '')?.[1];
    blocks.push({ label: heading[1], path: heading[2], span: heading[3], text: lines.slice(i + 2, last).join('\n'),
      ...(stableEvidenceId ? { stableEvidenceId } : {}) });
    i = last;
  }
  return blocks;
}
