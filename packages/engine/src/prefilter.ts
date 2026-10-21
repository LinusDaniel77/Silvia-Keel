import type { ShieldRequest } from "@shield/shared";

/**
 * Cheap, deterministic intent detection. Decides whether a request touches something worth
 * protecting, which gates the LLM call (cost and data exposure) and caps the decision:
 * requests without a high-risk intent can warn but never pause.
 */
export const INTENTS = {
  payment:
    /\b(wire|wire transfer|payment|pay(?: out)?|invoice|remit(?:tance)?|ACH|SWIFT|IBAN|routing number|transfer (?:the )?funds|release (?:the )?funds)\b/i,
  bank_details:
    /\b(bank (?:account|details|info(?:rmation)?)|banking (?:details|info(?:rmation)?)|account number|sort code)\b/i,
  credentials:
    /\b(password|passcode|MFA|2FA|two-factor|authenticator|log ?in|credentials|one-time code|verification code|push (?:notification|prompt))\b/i,
  gift_cards: /\b(gift ?cards?|iTunes card|Google Play card|Steam card)\b/i,
  crypto: /\b(bitcoin|BTC|USDT|crypto(?:currency)?|wallet address)\b/i,
  data_export:
    /\b(W-?2s?|payroll (?:data|records|file)|employee (?:list|records|data)|customer (?:list|database|data)|export (?:the )?(?:data|database|records))\b/i,
  private_channel: /\b(WhatsApp|Telegram|personal (?:email|number|phone)|text me)\b/i,
} as const;
export type Intent = keyof typeof INTENTS;

const HIGH_RISK_INTENTS: Intent[] = [
  "payment",
  "bank_details",
  "credentials",
  "gift_cards",
  "crypto",
  "data_export",
];

export function detectIntents(text: string): Intent[] {
  return (Object.keys(INTENTS) as Intent[]).filter((k) => INTENTS[k].test(text));
}

export function isHighRisk(request: ShieldRequest, intents: Intent[]): boolean {
  return request.action.kind !== "none" || intents.some((i) => HIGH_RISK_INTENTS.includes(i));
}
