/** Exact Grok session binding on the machine that owns the pane. */
import { opendirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";

const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_GROUPS = 4096;
/** Linux appends this to `/proc/<pid>/exe` after the inode is unlinked. */
const DELETED_SUFFIX = " (deleted)";
/** Packaging only. A version such as `grok-1.0.52` keeps its dots. */
const EXECUTABLE_SUFFIXES = [".cjs", ".mjs", ".exe", ".js"];

export interface GrokProcessInfo { foreground_processes?: { pid: number; argv?: string[] | null }[] }
/** Discover native or bun/node-launched Grok using the same names as the exe gate. */
export function grokPaneProcesses(info: GrokProcessInfo): { pid: number }[] {
  return (info.foreground_processes ?? []).filter((p) => {
    const argv = p.argv ?? [];
    return isGrokExecutable(argv[0] ?? "") ||
      (/(^|[\\/])(?:bun|node)(?:\.exe)?$/i.test(argv[0] ?? "") && isGrokExecutable(argv[1] ?? ""));
  });
}

/** True when this path's file name is Grok: `grok`, or `grok-` plus anything else
 * (`grok-1.0.52-linux-x86_64`, `grok.exe`). The session is the one Herdr reported, when that
 * events.jsonl is open. */
export function isGrokExecutable(exePath: string): boolean {
  const slash = Math.max(exePath.lastIndexOf("/"), exePath.lastIndexOf("\\"));
  let name = slash >= 0 ? exePath.slice(slash + 1) : exePath;
  if (name.endsWith(DELETED_SUFFIX)) name = name.slice(0, -DELETED_SUFFIX.length);
  name = name.toLowerCase();
  for (;;) {
    const suffix = EXECUTABLE_SUFFIXES.find((candidate) => name.endsWith(candidate));
    if (!suffix) break;
    name = name.slice(0, -suffix.length);
  }
  return name === "grok" || name.startsWith("grok-");
}

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** The resolved store and its cwd groups (URI-encoded or native hashed names), or null when
 * the store is missing, not absolute or holds too many entries to trust. */
export function grokSessionGroups(home: string): { store: string; groups: string[] } | null {
  if (!isAbsolute(home)) return null;
  try {
    const store = realpathSync(join(home, "sessions"));
    const entries = opendirSync(store);
    const groups: string[] = [];
    let count = 0;
    try {
      for (let group = entries.readSync(); group; group = entries.readSync()) {
        if (++count > MAX_GROUPS) return null;
        if (group.isDirectory()) groups.push(group.name);
      }
    } finally { entries.closeSync(); }
    return { store, groups };
  } catch { return null; }
}

/** Search by exact ID, including native hashed cwd groups. Neither cwd nor mtime selects
 * a conversation. Duplicate custom IDs across groups are ambiguous and fail closed. */
export function grokTranscriptPath(home: string, session: string): string | null {
  if (!SESSION.test(session)) return null;
  const listed = grokSessionGroups(home);
  if (listed === null) return null;
  const { store, groups } = listed;
  let found: string | null = null;
  for (const group of groups) {
    const candidate = join(store, group, session, "updates.jsonl");
    try {
      const path = realpathSync(candidate);
      // Reject a link into another session as well as links outside the store.
      if (path !== candidate || !inside(store, path) || !statSync(path).isFile()) continue;
      if (found !== null) return null;
      found = path;
    } catch { /* no matching file in this group */ }
  }
  return found;
}

const MAX_LISTED_FILES = 4096;
const MAX_COMMAND_BYTES = 1024 * 1024;

/** An explicit absolute GROK_HOME, otherwise HOME/.grok. A relative GROK_HOME does not fall through. */
function absoluteGrokHome(explicit: string | undefined, userHome: string | undefined): string | null {
  const home = explicit || (userHome ? join(userHome, ".grok") : null);
  return home && isAbsolute(home) ? home : null;
}

/** Do not substitute the bridge's home when the pane's environment is unreadable. */
export function grokHomeFromEnvironment(environment: string): string | null {
  const fields = environment.split("\0");
  const explicit = fields.find((field) => field.startsWith("GROK_HOME="))?.slice(10);
  const userHome = fields.find((field) => field.startsWith("HOME="))?.slice(5)
    || fields.find((field) => field.startsWith("USERPROFILE="))?.slice(12);
  return absoluteGrokHome(explicit, userHome);
}

/**
 * GROK_HOME or HOME/.grok in one macOS `ps -E -ww -o command=` line. The environment follows
 * the arguments, space-separated, so the last assignment wins and its value runs to the next
 * NAME=. A value holding ` NAME=` is cut there. An argument spelled GROK_HOME=/path is taken
 * when the environment has none; the held file still has to agree. This never reads the
 * bridge process's own environment.
 */
export function grokHomeFromPsLine(text: string): string | null {
  if (text.length > MAX_COMMAND_BYTES) return null;
  const value = (name: string): string | undefined =>
    [...text.matchAll(new RegExp(`(?:^|\\s)${name}=(.*?)(?=\\s+[A-Za-z_][A-Za-z0-9_]*=|\\s*$)`, "g"))].at(-1)?.[1];
  return absoluteGrokHome(value("GROK_HOME"), value("HOME") || value("USERPROFILE"));
}

/** Held events.jsonl directories and descriptor write times. Null on an unreadable or oversized
 * table, or an events.jsonl-prefixed file in a three-part path with an accepted session ID
 * that is deleted, renamed, replaced or not a resolved real file. Other names are ignored. */
export function grokHeldSessions(pid: number, home: string): Map<string, number> | null {
  try {
    const store = realpathSync(join(home, "sessions"));
    const fds = opendirSync(`/proc/${pid}/fd`);
    const sessions = new Map<string, number>();
    let count = 0;
    try {
      for (let fd = fds.readSync(); fd; fd = fds.readSync()) {
        if (++count > 4096) return null;
        const descriptor = `/proc/${pid}/fd/${fd.name}`;
        let target: string;
        // a descriptor closed since the listing is not a held file
        try { target = readlinkSync(descriptor); } catch { continue; }
        if (!inside(store, target) || !basename(target).startsWith("events.jsonl")) continue;
        const parts = relative(store, target).split(sep);
        if (parts.length !== 3 || !SESSION.test(parts[1]!)) continue;
        // Do not silently drop events.jsonl (deleted) or events.jsonl.old: that could
        // make an older held session look newest after an unreported /resume.
        if (basename(target) !== "events.jsonl" || realpathSync(target) !== target) return null;
        const held = statSync(descriptor);
        const named = statSync(target);
        if (!held.isFile() || !named.isFile() || held.dev !== named.dev || held.ino !== named.ino) return null;
        sessions.set(dirname(target), held.mtimeMs);
      }
    } finally { fds.closeSync(); }
    return sessions;
  } catch { return null; }
}

/** One numeric lsof descriptor. `dev` and `ino` are absent when lsof did not report them. */
export interface GrokLsofFile { path: string; dev: number | null; ino: number | null }

/** Open files and the executable from `lsof -FfDin`. Numeric descriptors are the holds Linux
 * would see in /proc/pid/fd. The first txt entry is the executable; macOS also lists mapped
 * files as txt after it. cwd, rtd and mem are not holds. */
export function grokLsofEvidence(text: string): { executable: string | null; files: GrokLsofFile[] } | null {
  if (text.length > MAX_COMMAND_BYTES) return null;
  const files: GrokLsofFile[] = [];
  let executable: string | null = null;
  let fd: string | null = null;
  let dev: number | null = null;
  let ino: number | null = null;
  let name: string | null = null;
  let count = 0;
  const flush = (): boolean => {
    if (fd === null) return true;
    if (++count > MAX_LISTED_FILES) return false;
    if (name !== null && (fd === "txt" || fd.startsWith("txt"))) {
      if (executable === null) {
        const arrow = name.lastIndexOf(" -> ");
        executable = arrow >= 0 ? name.slice(arrow + 4) : name;
      }
    } else if (name !== null && /^\d/.test(fd)) files.push({ path: name, dev, ino });
    fd = null; dev = null; ino = null; name = null;
    return true;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("p") || line.startsWith("f")) {
      if (!flush()) return null;
      if (line.startsWith("f")) fd = line.slice(1);
      continue;
    }
    if (line.startsWith("n")) {
      // A name with no descriptor in front is a format this parser does not understand.
      if (fd === null || name !== null) return null;
      name = line.slice(1);
      continue;
    }
    if (fd === null) continue;
    if (line.startsWith("D")) {
      // `parseInt("0xfe20", 16)` stops at `x` and would be 0, so the `0x` prefix comes off first.
      const hex = line.slice(1);
      const body = /^0x[0-9a-fA-F]+$/i.test(hex) ? hex.slice(2) : "";
      const parsed = body ? Number.parseInt(body, 16) : Number.NaN;
      dev = Number.isSafeInteger(parsed) ? parsed : null;
      continue;
    }
    if (line.startsWith("i")) {
      const parsed = Number(line.slice(1));
      ino = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    }
  }
  if (!flush()) return null;
  return { executable, files };
}

/** The same held-file rules as grokHeldSessions, using lsof's device and inode in place of
 * the /proc descriptor stat. The write time is the named file's, and only after that
 * identity matches. A missing device or inode is not a match. */
export function grokHeldSessionsFromLsof(files: readonly GrokLsofFile[], home: string): Map<string, number> | null {
  try {
    const store = realpathSync(join(home, "sessions"));
    const sessions = new Map<string, number>();
    for (const file of files) {
      const target = file.path;
      if (!inside(store, target) || !basename(target).startsWith("events.jsonl")) continue;
      const parts = relative(store, target).split(sep);
      if (parts.length !== 3 || !SESSION.test(parts[1]!)) continue;
      // Do not silently drop events.jsonl (deleted) or events.jsonl.old: that could
      // make an older held session look newest after an unreported /resume.
      if (basename(target) !== "events.jsonl" || realpathSync(target) !== target) return null;
      if (file.dev === null || file.ino === null) return null;
      const named = statSync(target);
      if (!named.isFile() || named.dev !== file.dev || named.ino !== file.ino) return null;
      sessions.set(dirname(target), named.mtimeMs);
    }
    return sessions;
  } catch { return null; }
}

/** What macOS asks the host. Tests pass fakes; production runs lsof and ps. */
export interface GrokLookup {
  platform?: NodeJS.Platform;
  processInfo?: (paneId: string) => Promise<GrokProcessInfo | undefined>;
  run?: (argv: readonly string[], timeoutMs: number) => Promise<{ stdout: string; exitCode: number }>;
}

const COMMAND_TIMEOUT_MS = 3000;

async function runHostCommand(argv: readonly string[], timeoutMs: number): Promise<{ stdout: string; exitCode: number }> {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore", timeout: timeoutMs });
  const stdout = await new Response(child.stdout).text();
  return { stdout, exitCode: await child.exited ?? 1 };
}

/** Bind Herdr's exact ID only when its unique held directory has the newest events.jsonl.
 * Write times confirm that ID; they never select a different conversation. */
function reportedSessionPath(home: string, sessionId: string, held: Map<string, number> | null): string | null {
  const path = grokTranscriptPath(home, sessionId);
  if (path === null) return null;
  const sessionDir = dirname(path);
  const written = held?.get(sessionDir);
  if (!held || written === undefined) return null;
  // A duplicate held ID is ambiguous even if only one directory has updates.jsonl.
  if ([...held.keys()].filter((dir) => basename(dir) === sessionId).length !== 1) return null;
  for (const [dir, mtime] of held) {
    // Equal timestamps cannot prove which session was written most recently.
    if (dir !== sessionDir && mtime >= written) return null;
  }
  return path;
}

async function resolveDarwinGrokStore(pid: number, sessionId: string, configuredHome: string | undefined, run: NonNullable<GrokLookup["run"]>): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  // A failed or missing host command is an unreadable listing, not a partial one.
  const output = async (argv: readonly string[]): Promise<string | null> => {
    const { stdout, exitCode } = await run(argv, COMMAND_TIMEOUT_MS);
    return exitCode === 0 ? stdout : null;
  };
  // Both rejections reach resolveGrokStore's catch. These are awaited children, not spawnSync.
  const [listed, processEnv] = await Promise.all([
    output(["/usr/sbin/lsof", "-nPbw", "-a", "-p", String(pid), "-FfDin"]),
    configuredHome === undefined ? output(["/bin/ps", "-E", "-ww", "-p", String(pid), "-o", "command="]) : null,
  ]);
  if (listed === null) return null;
  const evidence = grokLsofEvidence(listed);
  if (evidence === null || !isGrokExecutable(evidence.executable ?? "")) return null;
  const home = configuredHome ?? (processEnv === null ? null : grokHomeFromPsLine(processEnv));
  if (!home) return null;
  return reportedSessionPath(home, sessionId, grokHeldSessionsFromLsof(evidence.files, home));
}

/** Bind Herdr's exact ID only when its unique held directory has the newest events.jsonl.
 * Linux reads /proc. macOS reads lsof and ps. Windows stays on the terminal view.
 * Write times confirm that ID; they never select a different conversation. */
export async function resolveGrokStore(pane: HerdrPane, configuredHome?: string, lookup: GrokLookup = {}): Promise<string | null> {
  const session = pane.agent_session;
  if (pane.agent !== "grok" || session?.agent !== "grok" || session.kind !== "id" || session.source !== "herdr:grok" || !SESSION.test(session.value)) return null;
  // The executable may be any Grok build. Herdr's id chooses the session; an events.jsonl it did not name does not.
  const platform = lookup.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") return null;
  try {
    const processes = grokPaneProcesses((await (lookup.processInfo ?? paneProcessInfo)(pane.pane_id)) ?? {});
    if (processes.length !== 1) return null;
    const owner = processes[0]!;
    if (platform === "darwin") return await resolveDarwinGrokStore(owner.pid, session.value, configuredHome, lookup.run ?? runHostCommand);
    if (!isGrokExecutable(readlinkSync(`/proc/${owner.pid}/exe`))) return null;
    const home = configuredHome ?? grokHomeFromEnvironment(readFileSync(`/proc/${owner.pid}/environ`, "utf8"));
    if (!home) return null;
    return reportedSessionPath(home, session.value, grokHeldSessions(owner.pid, home));
  } catch { return null; }
}
