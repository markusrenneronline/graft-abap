/**
 * The `instructions` string returned in graft's MCP `initialize` response.
 *
 * This is the one piece of graft prose that survives **tool deferral**. When a
 * host has more tools than its schema budget allows, it sends tool *names* only
 * and withholds the JSONSchemas until a `ToolSearch`-style lookup fetches them —
 * measured in a real session: 111 tools deferred, of which graft's six arrived as
 * six bare strings with no descriptions at all. The MCP spec's `instructions`
 * field is delivered on a separate track (Claude Code records it as its own
 * `mcp_instructions_delta` context layer), so it lands whole even then. Other
 * servers already rely on this — `claude-in-chrome` uses it for exactly the
 * batch-your-ToolSearch instruction below; graft used to send nothing.
 *
 * Two jobs, in this order:
 *   1. Defuse the deferral tax. One lookup loads the tools for the whole
 *      session, so the cost is a single round trip, not two calls per use. An
 *      agent that doesn't know this can only assume the worse reading.
 *   2. Say what each tool is FOR as a decision rule, not a feature summary —
 *      because in a host with no hooks and no skill listing (a plain chat client
 *      with an MCP config), this string plus the tool descriptions are the entire
 *      steering budget graft gets.
 *
 * Budget: keep this under ~1,000 characters. Observed sibling servers sit at
 * 660–984, and nothing proves a longer one survives un-truncated.
 */

/** Tool names in the order an agent should reach for them, most-used first. */
const TOOL_ORDER = [
  'graft_find_code',
  'graft_find_all',
  'graft_trace_calls',
  'graft_unresolved_calls',
  'graft_diagnostics',
  'graft_file_api',
  'graft_repo_map',
  'graft_check_freshness',
] as const;

/** Build a selection with a caller-supplied client prefix. The MCP server
 * cannot infer its registration alias from serverInfo.name or clientInfo. */
export function toolSearchQuery(prefix = ''): string {
  return `select:${TOOL_ORDER.map((t) => `${prefix}${t}`).join(',')}`;
}

export function mcpInstructions(): string {
  return [
    'Graft indexes local code: symbols, file:line and static relationships.',
    'Deferred tools? ONE lookup: ToolSearch with select: and comma-separated exact tool names shown by your client. Use its configured server prefix, not serverInfo.name.',
    'graft_find_code: ranked source hits; graft_find_all: EVERY text occurrence.',
    'graft_trace_calls: callers/callees; depth 2 or "2", all/full; default 1. evidence_targets selects chains; exit_sources selects earlier exits ([] hides them).',
    'graft_unresolved_calls: unresolved calls; graft_diagnostics: analysis notices. graft_file_api: API; graft_repo_map: orientation; graft_check_freshness: health/schema.',
    'Queries refresh when safe; heed stale-graph warnings. ABAP evidence is lexical, not runtime proof. Unresolved references are not edges. No callers does not prove unused code. SAPRead remains authoritative for CE1.',
  ].join('\n');
}
