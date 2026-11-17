/**
 * Inbound acknowledgement reaction (fork customization, not upstream).
 *
 * Reacts to an engaged inbound message (default 👀) the moment the router
 * accepts it, so the user gets immediate feedback while the agent container
 * spins up. Fire-and-forget: never awaited on the routing path, never throws.
 *
 * NANOCLAW_ACK_REACTION=<emoji name> changes the emoji; set it to an empty
 * string to turn the reaction off.
 */
import { getChannelAdapter } from '../../channels/channel-registry.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { log } from '../../log.js';

const EMOJI = process.env.NANOCLAW_ACK_REACTION ?? 'eyes';

export function ackInboundMessage(
  event: InboundEvent,
  adapterKey: string,
  platformId: string,
  threadId: string | null,
): void {
  // Only Chat SDK adapters understand the reaction operation.
  if (!EMOJI || event.message.kind !== 'chat-sdk' || !event.message.id) return;
  const adapter = getChannelAdapter(adapterKey);
  if (!adapter) return;
  adapter
    .deliver(platformId, threadId, {
      kind: 'chat',
      content: { operation: 'reaction', messageId: event.message.id, emoji: EMOJI },
    })
    .catch((err: unknown) => log.debug('Ack reaction failed', { err, adapter: adapterKey }));
}
