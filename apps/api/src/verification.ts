import type { Action } from "@shield/shared";

export interface Subject {
  type: "vendor" | "role";
  id: string;
  name?: string;
}

export interface KnownContact {
  id: string;
  channel: "phone" | "email";
  value: string;
  source: string;
}

const money = (a: Action) =>
  a.amount !== undefined
    ? ` of ${a.amount.toLocaleString("en-US")}${a.currency ? ` ${a.currency}` : ""}`
    : "";

function question(action: Action, who: string): string {
  switch (action.kind) {
    case "vendor_bank_change":
      return `Has ${who} changed the bank account we pay? Please tell me the bank name and the last four digits of the new account.`;
    case "payment":
      return `Did you request a payment${money(action)}? Who is it to, and what is it for?`;
    case "credential_reset":
      return "Did you ask the service desk to reset your password or MFA just now?";
    case "access_grant":
      return "Did you request this access change, and what is it for?";
    case "data_export":
      return "Did you request this data export, and where should it go?";
    default:
      return "Did you send this request?";
  }
}

/** Prefers a phone number (a different channel from the request) over an email address. */
export function pickContact(contacts: KnownContact[]): KnownContact | null {
  return (
    contacts.find((c) => c.channel === "phone") ??
    contacts.find((c) => c.channel === "email") ??
    null
  );
}

/**
 * The script an employee follows to verify a paused request. It only ever uses a contact from the
 * system of record; contact details in the request itself go back to whoever sent it.
 */
export function callbackScript(
  action: Action,
  subject: Subject,
  contact: KnownContact | null,
): string {
  const who = subject.name ?? subject.id;
  if (!contact)
    return [
      `Verify this request before it proceeds. There is no contact on file for ${who}.`,
      "Do not use any phone number, email address or link from the request itself.",
      "Ask the owner of your vendor master or HR directory to add a verified contact, or verify in person.",
    ].join("\n");
  const reach =
    contact.channel === "phone"
      ? `Call ${who} on ${contact.value}, the number on file in ${contact.source}.`
      : `Email ${who} at ${contact.value}, the address on file in ${contact.source}, as a new message (not a reply).`;
  return [
    "Verify this request before it proceeds.",
    `1. ${reach} Do not use any phone number, email address or link from the request itself.`,
    `2. Ask: "${question(action, who)}"`,
    "3. Let them tell you the details. Don't read details from the request out to them.",
    "4. Record the outcome: legitimate, attack, or inconclusive.",
  ].join("\n");
}
