import { createFlueClient, type FlueClient, type FlueConversationMessage } from '@flue/sdk';

export const HISTORY_PAGE_SIZE = 40;
/** Preserve Flue's own live reducer/send semantics; only opt into its native bounded reads. */
export function pagedAgentClient(url: string, create: typeof createFlueClient = createFlueClient) {
 const room = decodeURIComponent(url.split('/').at(-1) ?? '');
 const base = create({ url, headers: { 'x-partykit-room': room } });
 const cursor: { current: string | null | undefined } = { current: undefined };
 const client: FlueClient = { ...base, observe(options) {
  const observation = base.observe({ ...options, limit: HISTORY_PAGE_SIZE });
  return { ...observation, getSnapshot() {
   const state = observation.getSnapshot();
   if (state.conversation) cursor.current = state.conversation.before;

   return state;
  } };
 } };
 return { client, cursor };
}

/** Latest live versions win over cached pages; ordering is server-supplied, not timestamps. */
export function mergeHistory(older: readonly FlueConversationMessage[], live: readonly FlueConversationMessage[]): FlueConversationMessage[] {
 const liveIds = new Set(live.map(message => message.id));
 return [...older.filter(message => !liveIds.has(message.id)), ...live];
}
