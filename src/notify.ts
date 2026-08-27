/**
 * Push a message to a contact outside the request/reply cycle -- used when
 * async work (CO drafting) finishes after the chat reply already went out.
 * Channels register a sender at startup; contacts route by their id prefix.
 */

export type Sender = (contactId: string, text: string) => Promise<void>;

const senders: { matches: (contactId: string) => boolean; send: Sender }[] = [];

export function registerNotifier(
  matches: (contactId: string) => boolean,
  send: Sender,
): void {
  senders.push({ matches, send });
}

/** Returns false when no channel can reach the contact. */
export async function notifyContact(
  contactId: string,
  text: string,
): Promise<boolean> {
  const sender = senders.find((s) => s.matches(contactId));
  if (!sender) {
    console.warn(`[notify] no channel for ${contactId}`);
    return false;
  }
  await sender.send(contactId, text);
  return true;
}
