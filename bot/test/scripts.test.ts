import { describe, expect, it } from "vitest";
import { UsageError, envFileValue, parseArgs, wranglerVar } from "../scripts/lib.ts";

describe("script helpers", () => {
  it("parses --yes and --help and refuses anything else", () => {
    expect(parseArgs([])).toEqual({ yes: false, help: false });
    expect(parseArgs(["--yes"])).toEqual({ yes: true, help: false });
    expect(parseArgs(["-h"])).toEqual({ yes: false, help: true });
    expect(() => parseArgs(["--force"])).toThrow(UsageError);
  });

  it("reads vars from the [vars] table only", () => {
    const toml = [
      'name = "bot"',
      "[vars]",
      'GUILD_ID = "111"',
      'APPLICATION_ID="222"',
      "",
      "[[d1_databases]]",
      'GUILD_ID = "wrong"',
    ].join("\n");
    expect(wranglerVar("GUILD_ID", toml)).toBe("111");
    expect(wranglerVar("APPLICATION_ID", toml)).toBe("222");
    expect(wranglerVar("MISSING", toml)).toBeUndefined();
  });

  it("reads env-file values with optional export and quotes", () => {
    const text = 'export A="one"\nB=two\n# C=three\nD = \'four\'\n';
    expect(envFileValue("A", text)).toBe("one");
    expect(envFileValue("B", text)).toBe("two");
    expect(envFileValue("C", text)).toBeUndefined();
    expect(envFileValue("D", text)).toBe("four");
  });
});
