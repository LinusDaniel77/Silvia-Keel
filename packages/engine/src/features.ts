import type { FeatureId, FeatureResult, ShieldRequest } from "@shield/shared";

const domainOf = (address?: string) => address?.split("@")[1]?.toLowerCase().trim();

/** True when `domain` is `trusted` or one of its subdomains. */
const isSameOrSub = (domain: string, trusted: string) =>
  domain === trusted || domain.endsWith(`.${trusted}`);

const HOMOGLYPHS: [RegExp, string][] = [
  [/rn/g, "m"],
  [/vv/g, "w"],
  [/0/g, "o"],
  [/1/g, "l"],
  [/i/g, "l"],
  [/-/g, ""],
];
const skeleton = (s: string) =>
  HOMOGLYPHS.reduce((acc, [re, to]) => acc.replace(re, to), s.toLowerCase());

/** First label of the registrable part: "mail.acme-corp.co" -> "acme-corp". Good enough for lookalikes. */
function mainLabel(domain: string): string {
  const parts = domain.split(".");
  return parts.length >= 2 ? (parts[parts.length - 2] ?? domain) : domain;
}

export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array<number>(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length]![b.length]!;
}

/** A domain that imitates a trusted one without being it or one of its subdomains. */
export function lookalikeOf(domain: string, trusted: string[]): string | undefined {
  for (const t of trusted) {
    if (isSameOrSub(domain, t)) return undefined;
  }
  for (const t of trusted) {
    const [dl, tl] = [mainLabel(domain), mainLabel(t)];
    const maxEdits = tl.length >= 6 ? 2 : 1;
    if (
      (dl !== tl && editDistance(dl, tl) <= maxEdits) ||
      skeleton(domain) === skeleton(t) ||
      (tl.length >= 4 && dl !== tl && (dl.includes(tl) || skeleton(dl) === skeleton(tl))) ||
      (dl === tl && domain !== t)
    )
      return t;
  }
  return undefined;
}

type FeatureFn = (r: ShieldRequest) => { fired: boolean; detail?: string };

const FEATURES: Record<FeatureId, FeatureFn> = {
  reply_to_mismatch: (r) => {
    for (const a of r.artifacts) {
      const from = domainOf(a.sender.address);
      const reply = domainOf(a.replyTo);
      if (from && reply && !isSameOrSub(reply, from) && !isSameOrSub(from, reply))
        return {
          fired: true,
          detail: `reply-to domain ${reply} differs from sender domain ${from}`,
        };
    }
    return { fired: false };
  },
  display_name_spoof: (r) => {
    for (const a of r.artifacts) {
      const embedded = /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/
        .exec(a.sender.displayName ?? "")?.[1]
        ?.toLowerCase();
      const from = domainOf(a.sender.address);
      if (embedded && from && embedded !== from)
        return {
          fired: true,
          detail: `display name shows ${embedded} but the message came from ${from}`,
        };
    }
    return { fired: false };
  },
  lookalike_domain: (r) => {
    const trusted = [...r.context.orgDomains, ...r.context.knownSenderDomains].map((d) =>
      d.toLowerCase(),
    );
    if (trusted.length === 0) return { fired: false };
    for (const a of r.artifacts) {
      for (const d of [domainOf(a.sender.address), domainOf(a.replyTo)]) {
        const target = d ? lookalikeOf(d, trusted) : undefined;
        if (d && target) return { fired: true, detail: `${d} resembles ${target}` };
      }
    }
    return { fired: false };
  },
  unknown_sender_domain: (r) => {
    if (r.context.knownSenderDomains.length === 0) return { fired: false };
    const trusted = [...r.context.orgDomains, ...r.context.knownSenderDomains];
    for (const a of r.artifacts) {
      const d = domainOf(a.sender.address);
      if (d && !trusted.some((t) => isSameOrSub(d, t.toLowerCase())))
        return { fired: true, detail: `${d} is not a known domain for this vendor or workflow` };
    }
    return { fired: false };
  },
  cross_channel_sequence: (r) => {
    // Approval and ticket events are systems of record, not conversation channels; a request
    // that shows up in email and in the AP queue is normal. Only people-to-people channels count.
    const channels = [
      ...new Set(
        r.artifacts.map((a) => a.channel).filter((c) => c !== "approval" && c !== "ticket"),
      ),
    ];
    return channels.length >= 2
      ? { fired: true, detail: `request arrived across ${channels.join(", ")}` }
      : { fired: false };
  },
  action_vendor_bank_change: (r) =>
    r.action.kind === "vendor_bank_change"
      ? { fired: true, detail: "the requested action changes vendor bank details" }
      : { fired: false },
  amount_outlier: (r) => {
    const typical = r.context.vendorBaseline?.typicalAmount;
    const amount = r.action.amount;
    return typical && amount !== undefined && amount > typical * 3
      ? { fired: true, detail: `amount ${amount} is over 3x the typical ${typical}` }
      : { fired: false };
  },
  off_hours: (r) => {
    const hours = r.context.businessHours;
    if (!hours) return { fired: false };
    for (const a of r.artifacts) {
      if (!a.receivedAt) continue;
      const t = new Date(a.receivedAt);
      const local = new Date(t.getTime() + hours.utcOffsetMinutes * 60_000);
      const h = local.getUTCHours();
      const day = local.getUTCDay();
      if (day === 0 || day === 6 || h < hours.startHour || h >= hours.endHour)
        return {
          fired: true,
          detail: `received outside business hours (${local.toISOString().slice(0, 16)} local)`,
        };
    }
    return { fired: false };
  },
};

export function computeFeatures(request: ShieldRequest): FeatureResult[] {
  return (Object.keys(FEATURES) as FeatureId[]).map((id) => ({ id, ...FEATURES[id](request) }));
}
