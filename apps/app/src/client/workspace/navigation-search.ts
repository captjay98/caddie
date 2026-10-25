/** Cross-page links carry context, not another page's private controls. */
export function destinationSearch(previous: Record<string, unknown>, pane?: 'channel' | 'brief') {
 return { ...(typeof previous.project === 'string' && previous.project ? { project: previous.project } : {}), ...(pane ? { pane } : {}) };
}
