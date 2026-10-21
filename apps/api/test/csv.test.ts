import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.ts";

describe("parseCsv", () => {
  it("handles headers, quotes, escaped quotes, commas in quotes, CRLF and blank lines", () => {
    expect(
      parseCsv(
        'subject_type,subject_id,channel,value\r\nvendor,"V-1, Inc",phone,"+1 ""206"" 555"\r\n\r\nrole,cfo,email,a@b.com',
      ),
    ).toEqual([
      ["subject_type", "subject_id", "channel", "value"],
      ["vendor", "V-1, Inc", "phone", '+1 "206" 555'],
      ["role", "cfo", "email", "a@b.com"],
    ]);
  });
});
