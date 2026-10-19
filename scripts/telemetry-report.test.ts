import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUERIES, table } from "./telemetry-report.ts";

/** scripts/telemetry-report.ts with a stand-in bunx on a private PATH: no wrangler, no D1. */

const SCRIPT = join(import.meta.dir, "telemetry-report.ts");
const scratches: string[] = [];
afterAll(() => { for (const dir of scratches) rmSync(dir, { recursive: true, force: true }); });

async function run(fails: boolean) {
  const scratch = mkdtempSync(join(tmpdir(), "telemetry-report-"));
  scratches.push(scratch);
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "bun"));
  writeFileSync(join(bin, "bunx"), fails
    ? "#!/bin/sh\necho 'You are not authenticated' >&2\nexit 1\n"
    : "#!/bin/sh\necho \"$PWD\" >> \"$SCRATCH/dirs\"\necho \"$*\" >> \"$SCRATCH/calls\"\necho '[{\"results\":[{\"day\":\"2026-10-18\",\"COUNT(*)\":5}],\"success\":true}]'\n");
  chmodSync(join(bin, "bunx"), 0o755);
  const out = join(scratch, "report.md");
  const child = Bun.spawn([process.execPath, SCRIPT, "--out", out], { env: { PATH: bin, HOME: scratch, SCRATCH: scratch }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const calls = existsSync(join(scratch, "calls")) ? readFileSync(join(scratch, "calls"), "utf8").trim().split("\n") : [];
  const dirs = existsSync(join(scratch, "dirs")) ? readFileSync(join(scratch, "dirs"), "utf8").trim().split("\n") : [];
  return { exitCode, output: stdout + stderr, report: existsSync(out) ? readFileSync(out, "utf8") : null, calls, dirs };
}

describe("telemetry report tables", () => {
  it("writes the rows' keys as columns and escapes pipes", () => {
    expect(table([{ a: 1, b: "x|y" }, { a: null, b: "z" }])).toBe("| a | b |\n| --- | --- |\n| 1 | x\\|y |\n| NULL | z |");
    expect(table([])).toBe("(no rows)");
  });
});

describe.skipIf(process.platform === "win32")("telemetry report", () => {
  it("runs every query read-only against the remote database, one table each, in order", async () => {
    const result = await run(false);
    expect(result.exitCode).toBe(0);
    expect(result.calls).toHaveLength(QUERIES.length);
    // from telemetry/, where wrangler finds wrangler.toml and the database's id
    const telemetry = join(import.meta.dir, "..", "telemetry");
    expect(new Set(result.dirs)).toEqual(new Set([telemetry]));
    expect(existsSync(join(telemetry, "wrangler.toml"))).toBe(true);
    for (const call of result.calls) expect(call).toStartWith("wrangler d1 execute herdr-web-ui-telemetry --remote --json --command ");
    expect(result.calls.some((call) => /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(call))).toBe(false);
    const headings = [...result.report!.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(QUERIES.map((query) => query.title));
    expect(result.report).toContain("| 2026-10-18 | 5 |");
  });

  it("stops with the login hint when wrangler cannot read the database", async () => {
    const result = await run(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("run bunx wrangler login first");
    expect(result.report).toBeNull();
  });
});
