import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/growth-snapshot.ts against a stand-in gh on a private PATH: nothing reaches GitHub. The
 * stand-in's answers carry a login, a referrer and a path that must never reach the output.
 */

const SCRIPT = join(import.meta.dir, "growth-snapshot.ts");
const LOGIN = "stand-in-login-7f3a";
const REFERRER = "stand-in-referrer.example";
const PATH_SEEN = "/stand-in/secret-path";
const scratches: string[] = [];
afterAll(() => { for (const dir of scratches) rmSync(dir, { recursive: true, force: true }); });

/** mode: "ok" | "one-403" (clones) | "all-403" (every traffic endpoint) | "repo-fails" | "two-pages" (a full first page of stargazers) */
function standIn(mode: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "growth-snapshot-"));
  scratches.push(scratch);
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "bun"));
  const page1 = JSON.stringify(mode === "two-pages"
    ? Array.from({ length: 100 }, (_, i) => ({ starred_at: "2026-09-30T10:00:00Z", user: { login: `${LOGIN}-${i}` } }))
    : [
      { starred_at: "2026-10-01T10:00:00Z", user: { login: LOGIN } },
      { starred_at: "2026-10-01T12:00:00Z", user: { login: LOGIN + "-2" } },
      { starred_at: "2026-10-03T08:00:00Z", user: { login: LOGIN + "-3" } },
    ]);
  const page2 = JSON.stringify(mode === "two-pages" ? [{ starred_at: "2026-10-02T10:00:00Z", user: { login: LOGIN } }] : []);
  const deny = (name: string) => `echo "gh: ${name} needs push access (HTTP 403)" >&2; exit 1`;
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  *"repos/o/r/traffic/views"*) ${mode === "all-403" ? deny("views") : `echo '{"count":42,"uniques":7,"views":[]}'`} ;;
  *"repos/o/r/traffic/clones"*) ${mode === "ok" ? `echo '{"count":3,"uniques":2,"clones":[]}'` : deny("clones")} ;;
  *"repos/o/r/traffic/popular/referrers"*) ${mode === "all-403" ? deny("referrers") : `echo '[{"referrer":"${REFERRER}","count":9,"uniques":4}]'`} ;;
  *"repos/o/r/traffic/popular/paths"*) ${mode === "all-403" ? deny("paths") : `echo '[{"path":"${PATH_SEEN}","title":"t","count":5,"uniques":3}]'`} ;;
  *"stargazers?per_page=100&page=1"*) echo '${page1}' ;;
  *"stargazers?per_page=100&page=2"*) echo '${page2}' ;;
  *"stargazers?per_page=100&page="*) echo '[]' ;;
  *"repos/o/r") ${mode === "repo-fails" ? `echo "gh: Not Found (HTTP 404)" >&2; exit 1` : `echo '{"stargazers_count":3,"forks_count":1,"subscribers_count":2}'`} ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
  return scratch;
}

async function run(mode: string) {
  const scratch = standIn(mode);
  const out = join(scratch, "out");
  const child = Bun.spawn([process.execPath, SCRIPT, "--out", out, "--repo", "o/r"], { env: { PATH: join(scratch, "bin"), HOME: scratch }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const files = existsSync(out) ? readdirSync(out).sort() : [];
  const snapshotFile = files.find((file) => file.startsWith("snapshot-"));
  const snapshot = snapshotFile ? JSON.parse(readFileSync(join(out, snapshotFile), "utf8")) : null;
  const csv = files.includes("stars-by-day.csv") ? readFileSync(join(out, "stars-by-day.csv"), "utf8") : null;
  return { exitCode, output: stdout + stderr, files, snapshot, csv };
}

describe.skipIf(process.platform === "win32")("growth snapshot", () => {
  it("records counts, traffic and stars by day, with a running total", async () => {
    const result = await run("ok");
    expect(result.exitCode).toBe(0);
    expect(result.snapshot.totals).toEqual({ stargazers_count: 3, forks_count: 1, subscribers_count: 2 });
    expect(result.snapshot.views.count).toBe(42);
    expect(result.snapshot.referrers[0].referrer).toBe(REFERRER);
    expect(result.snapshot.stars_by_day).toEqual({ "2026-10-01": 2, "2026-10-03": 1 });
    expect(result.csv).toBe("date,new_stars,cumulative\n2026-10-01,2,2\n2026-10-03,1,3\n");
  });

  it("reads every page of stargazers", async () => {
    const result = await run("two-pages");
    expect(result.exitCode).toBe(0);
    expect(result.snapshot.stars_by_day).toEqual({ "2026-09-30": 100, "2026-10-02": 1 });
    expect(result.csv).toBe("date,new_stars,cumulative\n2026-09-30,100,100\n2026-10-02,1,101\n");
  });

  it("keeps going when one traffic endpoint is refused", async () => {
    const result = await run("one-403");
    expect(result.exitCode).toBe(0);
    expect(result.snapshot.clones).toEqual({ error: "403" });
    expect(result.snapshot.views.count).toBe(42);
  });

  it("fails with 2 when every traffic endpoint is refused", async () => {
    const result = await run("all-403");
    expect(result.exitCode).toBe(2);
    for (const key of ["views", "clones", "referrers", "paths"]) expect(result.snapshot[key]).toEqual({ error: "403" });
  });

  it("fails with 1 and writes nothing when the repository cannot be read", async () => {
    const result = await run("repo-fails");
    expect(result.exitCode).toBe(1);
    expect(result.files).toEqual([]);
  });

  it("never prints who starred or where visitors came from", async () => {
    for (const mode of ["ok", "one-403", "all-403"]) {
      const result = await run(mode);
      expect(result.output).not.toContain(LOGIN);
      expect(result.output).not.toContain(REFERRER);
      expect(result.output).not.toContain(PATH_SEEN);
      expect(JSON.stringify(result.snapshot)).not.toContain(LOGIN);
    }
  });
});
