import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIBRARY_DIR, lintLibrary, loadLibrary, matchIndicators } from "../src/index.ts";

function scratchLibrary(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "shield-lib-"));
  cpSync(DEFAULT_LIBRARY_DIR, dir, { recursive: true });
  return dir;
}

function editTactic(dir: string, id: string, edit: (yaml: string) => string) {
  const file = path.join(dir, "tactics", `${id}.yaml`);
  writeFileSync(file, edit(readFileSync(file, "utf8")));
}

describe("tactic library", () => {
  it("loads and lints clean", () => {
    const lib = loadLibrary();
    expect(lib.tactics.length).toBeGreaterThanOrEqual(20);
    expect(lintLibrary().errors).toEqual([]);
  });

  it("covers every enterprise tactic named in the roadmap", () => {
    const ids = loadLibrary().tactics.map((t) => t.id);
    for (const id of [
      "authority.executive-pressure",
      "secrecy.confidential",
      "channel.switch",
      "process-bypass.skip-approval",
      "payment-anomaly.vendor-bank-change",
      "access.helpdesk-pressure",
    ])
      expect(ids).toContain(id);
  });

  it("rejects a tactic without hard negatives", () => {
    const dir = scratchLibrary();
    editTactic(dir, "urgency.deadline", (y) =>
      y.replace(
        / {2}hard_negative:\n( {4}- .*\n)+/,
        '  hard_negative:\n    - "Payroll runs Thursday as usual; submit timesheets."\n',
      ),
    );
    expect(lintLibrary(dir).errors.join("\n")).toMatch(/at least 2 hard negatives/);
  });

  it("rejects explanations that label the person", () => {
    const dir = scratchLibrary();
    editTactic(dir, "urgency.deadline", (y) =>
      y.replace(/^explanation: .*$/m, "explanation: 'The fraudster is rushing you ({evidence}).'"),
    );
    expect(lintLibrary(dir).errors.join("\n")).toMatch(
      /label the tactic, not the person \(found "fraudster"\)/,
    );
  });

  it("rejects content changes without a version bump, and accepts them with one", () => {
    const dir = scratchLibrary();
    editTactic(dir, "urgency.deadline", (y) => y.replace("    - urgently\n", ""));
    const errors = lintLibrary(dir).errors.join("\n");
    expect(errors).toMatch(/content changed without a version bump/);
    expect(errors).toMatch(/bump version above/);

    editTactic(dir, "urgency.deadline", (y) => y.replace("version: 1.0.0", "version: 1.0.1"));
    const manifest = path.join(dir, "manifest.yaml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace(/^version: .*$/m, "version: 9.9.9"),
    );
    expect(lintLibrary(dir).errors).toEqual([
      "library.lock.json is stale: run `pnpm shield tactics lock`",
    ]);
  });

  it("rejects unknown structural features and bad regexes", () => {
    const dir = scratchLibrary();
    editTactic(dir, "channel.switch", (y) =>
      y
        .replace("    - cross_channel_sequence", "    - telepathy")
        .replace('"(on|via|over) (Signal|Telegram)"', '"(unclosed"'),
    );
    const errors = lintLibrary(dir).errors.join("\n");
    expect(errors).toMatch(/unknown structural feature "telepathy"/);
    expect(errors).toMatch(/invalid pattern/);
  });

  it("matches lexical cues on word boundaries, with plurals, keeping the longest overlap", () => {
    const t = loadLibrary().byId.get("payment-anomaly.unusual-method")!;
    expect(matchIndicators(t, "Please get 6 Google Play cards")).toContain("Google Play cards");
    const deadline = loadLibrary().byId.get("urgency.deadline")!;
    expect(matchIndicators(deadline, "resurgent demand")).toEqual([]);
    const bank = loadLibrary().byId.get("payment-anomaly.vendor-bank-change")!;
    expect(matchIndicators(bank, "See our updated remittance information.")).toEqual([
      "updated remittance information",
    ]);
  });
});
