import type { CallExecution, CallSiteV1, EdgeV1 } from './types.js';

const descriptions: Record<CallExecution, string> = {
  callback: 'registered for RFC task completion; arguments are supplied by the RFC runtime, not the function EXPORTING list',
  async: 'asynchronous RFC start; the caller does not wait for function completion',
  update_task: 'registered for update processing at COMMIT WORK; reaching this source statement does not prove execution',
  background_task: 'registered background RFC task; COMMIT WORK and RFC processing are not evaluated',
  background_unit: 'registered background RFC unit; its destination, lifecycle and execution are not resolved',
  on_commit: 'FORM registered for COMMIT WORK; no commit or eventual execution is inferred',
  on_rollback: 'FORM registered for ROLLBACK WORK; no rollback or eventual execution is inferred',
};

export function executionEvidence(site: CallSiteV1): string | undefined {
  return site.execution ? `Execution: ${site.execution} — ${descriptions[site.execution]}. Source controls and earlier exits describe registration/start, not proof of eventual target execution.` : undefined;
}

/** Warn even if detailed evidence filters hide the source site, or if an edge
 * combines ordinary calls and registrations. These are candidate source sites. */
export function executionWarnings(chain: EdgeV1[]): string[] {
  const modes = [...new Set(chain.filter(e => e.relation === 'calls').flatMap(e => (e.callSites ?? []).flatMap(s => s.execution ? [s.execution] : [])))].sort();
  return modes.length ? [`execution boundary: ${modes.join(', ')}; at least one recorded site starts or registers asynchronous/deferred work. This chain does not establish synchronous execution.`] : [];
}
