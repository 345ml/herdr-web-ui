import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { forgetTranscriptState, HistoryChanged, transcriptPage } from "./conversation.ts";
import { grokToolOutput, grokProjection, GrokUnavailable, parseGrokTranscript } from "./grok.ts";
import { grokHeldSessionsFromLsof, grokHomeFromEnvironment, grokHomeFromPsLine, grokLsofEvidence, grokPaneProcesses, grokTranscriptPath, isGrokExecutable, resolveGrokStore, type GrokLookup } from "./grok-store.ts";
import * as herdr from "./herdr/client.ts";
import type { ConversationPart, HerdrPane } from "../shared/protocol.ts";

const session = "fictional-session";
const event = (update: object, extension = false) => JSON.stringify({ timestamp: 1700000000, method: extension ? "_x.ai/session/update" : "session/update", params: { sessionId: session, update } }) + "\n";
const user = (index: number, text = `prompt ${index}`, meta = {}) => event({ sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { promptIndex: index, modelId: "fictional-model", ...meta } });
const answer = (text = "fictional answer") => event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const rewind = (target: number) => event({ sessionUpdate: "rewind_marker", target_prompt_index: target }, true);
const tool = (id = "call-1") => event({ sessionUpdate: "tool_call", toolCallId: id, title: "Read file", rawInput: { path: "fiction.txt" }, content: [], status: "pending" });
const update = (output: string, id = "call-1") => event({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "text", text: output } }] });
type Tool = Extract<ConversationPart, { kind: "tool" }>;
let root: string, path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-grok-unit-"));
  path = join(root, "sessions", "%2Ffiction", session, "updates.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  forgetTranscriptState();
});
afterEach(() => { forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); });
const page = () => transcriptPage("grok-transcript", path);
const lastTool = () => page().turns.flatMap((t) => t.parts).find((p): p is Tool => p.kind === "tool")!;

describe("Grok native event adapter", () => {
  test("native activity follows thoughts, tools, completion and rewind without pane status", () => {
    const activity = () => grokProjection(path, statSync(path)).activity;
    writeFileSync(path, user(0));
    expect(activity()).toBe("working");
    appendFileSync(path, event({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "fictional thought" } }));
    expect(activity()).toBe("thinking");
    expect(page().turns).toHaveLength(1);
    appendFileSync(path, tool());
    expect(activity()).toBe("working");
    appendFileSync(path, event({ sessionUpdate: "turn_completed" }));
    expect(activity()).toBe("idle");
    appendFileSync(path, update("late background result"));
    expect(activity()).toBe("idle");
    appendFileSync(path, user(1));
    expect(activity()).toBe("working");
    appendFileSync(path, rewind(1));
    expect(activity()).toBe("idle");
  });
  test("replays an isolated native tool call and its two updates", () => {
    writeFileSync(path, readFileSync(new URL("./fixtures/grok/native-tool.jsonl", import.meta.url), "utf8"));
    const part = lastTool();
    expect(part.name).toBe("run_terminal_command");
    expect(JSON.parse(part.input).variant).toBe("Bash");
    expect(part.output).toBe("FICTIONAL_TOOL_OUTPUT\n");
    expect(page().turns.at(-1)!.parts.at(-1)).toEqual({ kind: "text", text: "FICTIONAL_AFTER_TOOL", phase: "final_answer" });
  });
  test("text chunks, hidden boundaries and synthetic prompts", () => {
    const turns = parseGrokTranscript(user(0, "hello ") + user(0, "world") + answer("one ") + answer("two") + user(1, "hidden", { hideFromScrollback: true }) + answer("separate answer") + user(2, "visible", { syntheticPrompt: true }));
    expect(turns.map((t) => t.parts)).toEqual([
      [{ kind: "text", text: "hello world" }], [{ kind: "text", text: "one two" }],
      [{ kind: "text", text: "separate answer" }], [{ kind: "text", text: "visible" }],
    ]);
    expect(turns[1]!.end_ts).toBe("2023-11-14T22:13:20.000Z");
  });
  test("omitted tool fields survive, present output replaces, and shrink removes expansion", () => {
    writeFileSync(path, user(0) + tool() + update("x".repeat(6000)));
    const first = lastTool();
    expect(first.output_size).toBe(6000);
    expect(grokToolOutput(path, first.output_ref!)).toBe("x".repeat(6000));
    appendFileSync(path, event({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" }));
    expect(lastTool().input).toContain("fiction.txt");
    expect(lastTool().output_size).toBe(6000);
    const second = lastTool().output_ref!;
    appendFileSync(path, update("short"));
    expect(lastTool().output).toBe("short");
    expect(lastTool().output_ref).toBeUndefined();
    expect(lastTool().output_size).toBeUndefined();
    expect(grokToolOutput(path, second)).toBeNull();
  });
  test("unknown, cross-prompt, abandoned and mid-turn updates fail instead of disappearing", () => {
    for (const text of [user(0) + update("unknown"), user(0) + tool() + user(1) + update("late"), user(0) + tool() + rewind(0) + user(0) + update("abandoned")]) {
      forgetTranscriptState(); writeFileSync(path, text);
      expect(() => page()).toThrow();
    }
    expect(() => parseGrokTranscript(update("missing seed"))).toThrow(GrokUnavailable);
  });
  test("nullable raw fields preserve the call while an empty content array clears output", () => {
    const turns = parseGrokTranscript(user(0) + tool() + update("old") + event({ sessionUpdate: "tool_call_update", toolCallId: "call-1", name: "read_file" }) + event({ sessionUpdate: "tool_call_update", toolCallId: "call-1", name: null, rawInput: null, content: [] }));
    const part = turns.flatMap((t) => t.parts).find((p): p is Tool => p.kind === "tool")!;
    expect(part.name).toBe("read_file");
    expect(part.input).toContain("fiction.txt");
    expect(part.output).toBe("");
  });
  test("turn completion separates assistant activity without dropping earlier messages", () => {
    const turns = parseGrokTranscript(user(0) + answer("first") + event({ sessionUpdate: "turn_completed" }, true) + answer("later"));
    expect(turns.map((t) => t.parts)).toEqual([[{ kind: "text", text: "prompt 0" }], [{ kind: "text", text: "first", phase: "final_answer" }], [{ kind: "text", text: "later" }]]);
  });
  test("native tool metadata, search variants and historical diffs survive output replacement", () => {
    const native = event({ sessionUpdate: "tool_call", toolCallId: "edit-1", _meta: { "x.ai/tool": { name: "edit_file" } }, content: [{ type: "diff", path: "fiction.txt", oldText: "before", newText: "after" }] });
    writeFileSync(path, user(0) + native + update("completed", "edit-1"));
    const part = lastTool();
    expect(part.name).toBe("edit_file");
    expect(part.output).toBe("--- fiction.txt\nbefore\n+++ fiction.txt\nafter\ncompleted");
    const search = parseGrokTranscript(user(0) + event({ sessionUpdate: "tool_call", toolCallId: "search-1", kind: "search", rawInput: { variant: "XSearch" } }));
    expect((search[1]!.parts[0] as Tool).name).toBe("XSearch");
  });
  test("malformed known history controls and mismatched sessions fail", () => {
    writeFileSync(path, user(0) + event({ sessionUpdate: "rewind_marker" }, true));
    expect(() => page()).toThrow();
    forgetTranscriptState(); writeFileSync(path, user(0).replace(session, "other-session"));
    expect(() => page()).toThrow();
  });
});

describe("shared pager projection", () => {
  test("matches the fictional native session/load replay after nested rewinds", () => {
    const fixture = (name: string) => readFileSync(new URL(`./fixtures/grok/${name}.jsonl`, import.meta.url), "utf8");
    writeFileSync(path, fixture("nested-rewind"));
    const visible = (turns: ReturnType<typeof parseGrokTranscript>) => turns.map(({ role, parts }) => ({ role, parts }));
    expect(visible(page().turns)).toEqual(visible(parseGrokTranscript(fixture("native-replay"))));
    expect(page().turns.filter((turn) => turn.role === "user")).toHaveLength(1);
  });
  test("ordinary append keeps identity; marker-only rewind invalidates even a cursor at new EOF", () => {
    const first = user(0) + answer();
    writeFileSync(path, first + user(1) + answer());
    const before = page();
    appendFileSync(path, answer("streamed"));
    expect(page().history_id).toBe(before.history_id);
    appendFileSync(path, rewind(1));
    const after = page();
    expect(after.history_id).not.toBe(before.history_id);
    expect(after.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(() => transcriptPage("grok-transcript", path, { before: `${before.history_id}:${Buffer.byteLength(first)}` })).toThrow(HistoryChanged);
    appendFileSync(path, user(1, "replacement") + answer());
    expect(page().history_id).toBe(after.history_id);
  });
  test("nested 1,1,0 rewinds agree cold, warm and with empty history", () => {
    writeFileSync(path, user(0) + answer() + user(1) + answer()); page();
    appendFileSync(path, rewind(1) + user(1) + answer() + user(2) + answer()); page();
    appendFileSync(path, rewind(1) + user(1) + answer()); page();
    appendFileSync(path, rewind(0));
    expect(page().turns).toEqual([]);
    appendFileSync(path, user(0, "final active prompt") + answer());
    const warm = page();
    forgetTranscriptState();
    expect(page()).toEqual(warm);
    expect(warm.turns).toHaveLength(2);
  });
  test("irrelevant extension records between rewind and replacement do not reconnect discarded bytes", () => {
    writeFileSync(path, user(0) + answer() + user(1) + answer() + rewind(1)
      + event({ sessionUpdate: "background_tasks", tasks: [] }, true) + user(1, "replacement") + answer());
    expect(page().turns.filter((turn) => turn.role === "user").map((turn) => turn.parts)).toEqual([
      [{ kind: "text", text: "prompt 0" }], [{ kind: "text", text: "replacement" }],
    ]);
  });
  test("older pages meet newest page with no duplicate turns, and stale pages cannot survive rewind", () => {
    writeFileSync(path, Array.from({ length: 130 }, (_, i) => user(i) + answer()).join(""));
    const newest = page();
    expect(newest.cursor).not.toBeNull();
    const older = transcriptPage("grok-transcript", path, { before: newest.cursor! });
    const oldest = transcriptPage("grok-transcript", path, { before: older.cursor! });
    const prompts = [...oldest.turns, ...older.turns, ...newest.turns].filter((t) => t.role === "user");
    expect(prompts).toHaveLength(130);
    expect(new Set(prompts.map((t) => JSON.stringify(t.parts))).size).toBe(130);
    appendFileSync(path, rewind(1));
    expect(() => transcriptPage("grok-transcript", path, { before: newest.cursor! })).toThrow(HistoryChanged);
  });
  test("partial UTF-8 writes are invisible until complete; metadata follows active prompts", () => {
    writeFileSync(path, user(0));
    const before = page();
    const bytes = Buffer.from(answer("hello 🌍"));
    const split = bytes.indexOf(Buffer.from("🌍")) + 2;
    appendFileSync(path, bytes.subarray(0, split));
    expect(page().turns).toEqual(before.turns);
    appendFileSync(path, bytes.subarray(split));
    expect(page().turns.at(-1)!.parts).toEqual([{ kind: "text", text: "hello 🌍" }]);
    expect(page().metadata.model).toBe("fictional-model");
  });
  test("truncation resets history and tool refs; refs cannot cross stores", () => {
    writeFileSync(path, user(0) + tool() + update("a".repeat(6000)));
    const first = page(); const ref = lastTool().output_ref!;
    const other = join(root, "other", session, "updates.jsonl");
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, user(0) + tool() + update("a".repeat(6000)));
    expect(grokToolOutput(other, ref)).toBeNull();
    writeFileSync(path, user(0));
    expect(page().history_id).not.toBe(first.history_id);
    expect(grokToolOutput(path, ref)).toBeNull();
  });
});

describe("exact store lookup", () => {
  test("discovery takes Grok's own executable from the foreground processes", () => {
    expect(grokPaneProcesses({ foreground_processes: [{ pid: 11, argv: ["/usr/local/bin/grok"] }, { pid: 12, argv: ["/bin/sh"] }] }).map((p) => p.pid)).toEqual([11]);
    expect(grokPaneProcesses({})).toEqual([]);
  });
  test("discovery and the exe gate accept the same Grok names without a version pin", () => {
    const accepted = [
      "grok",
      "/usr/local/bin/grok",
      "/usr/local/bin/grok (deleted)",
      "grok.exe",
      "GROK.EXE",
      "C:\\Grok\\grok.exe",
      "grok-1.0.50-linux-x86_64",
      "/home/user/.grok/downloads/grok-1.0.52-linux-x86_64",
      "/home/user/.grok/downloads/grok-1.0.52-linux-x86_64 (deleted)",
      "grok-1.0.52.exe",
      "grok.js",
      "grok.cjs",
      "grok.mjs",
      "grok.js.exe",
      "grok-2.0.0-darwin-arm64",
      "grok-statusline", // Synthetic nonnumeric suffix; not a claim about a shipped build.
    ];
    for (const exe of accepted) {
      expect(isGrokExecutable(exe)).toBe(true);
      expect(grokPaneProcesses({ foreground_processes: [{ pid: 11, argv: [exe] }] })).toHaveLength(1);
    }
    const rejected = ["/bin/sleep", "sleep", "grokker", "notgrok", "grok_cli", "grok.bak", "/opt/grok/bin/sleep", ""];
    for (const exe of rejected) {
      expect(isGrokExecutable(exe)).toBe(false);
      expect(grokPaneProcesses({ foreground_processes: [{ pid: 11, argv: [exe] }] })).toEqual([]);
    }
  });
  // These resolver tests need Linux /proc/<pid>/fd and /proc/<pid>/exe.
  // macOS uses the same binding rule with lsof and ps, covered below.
  for (const scenario of [
    { name: "older files stay open", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: true },
    { name: "/resume writes a newer session", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false },
    { name: "the reported id is held in two directories", otherGroup: "other-group", otherSession: session, otherMtime: 100, binds: false },
    { name: "held sessions have tied write times", otherGroup: "group", otherSession: "tied-session", otherMtime: 200, binds: false },
    { name: "the newest held events file is unlinked", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, change: "unlink" },
    { name: "the newest held events file is renamed", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, change: "rename" },
    { name: "a replacement reported file has a newer timestamp", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, replacement: "current" },
    { name: "a replacement competing file has an older timestamp", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, replacement: "other" },
  ]) {
    test.skipIf(process.platform !== "linux" || !existsSync("/proc/self/fd"))(`resolves Herdr's session safely when ${scenario.name}`, async () => {
      const home = realpathSync(root);
      const transcript = join(home, "sessions", "%2Ffiction", session, "updates.jsonl");
      const current = join(dirname(transcript), "events.jsonl");
      const other = join(home, "sessions", scenario.otherGroup, scenario.otherSession, "events.jsonl");
      const retained = join(home, "sessions", "group", "retained-session", "events.jsonl");
      const outside = join(home, "events.jsonl");
      mkdirSync(dirname(other), { recursive: true });
      mkdirSync(dirname(retained), { recursive: true });
      writeFileSync(transcript, user(0));
      writeFileSync(current, "");
      writeFileSync(other, "");
      writeFileSync(retained, "");
      writeFileSync(outside, "");
      utimesSync(current, 200, 200);
      utimesSync(other, scenario.otherMtime, scenario.otherMtime);
      utimesSync(retained, 50, 50);
      utimesSync(outside, 400, 400);
      // Only the reported directory has updates.jsonl, including the duplicate-id case.
      const executable = join(home, "grok");
      // Use our runtime, not a sleep executable that may dispatch by its copied name.
      copyFileSync(process.execPath, executable);
      const fds = [current, other, retained, outside].map((file) => openSync(file, "r"));
      const child = spawn(executable, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore", ...fds] });
      const pane: HerdrPane = {
        pane_id: "grok-fixture", agent: "grok", agent_status: "ready", focused: false,
        revision: 0, tab_id: "tab-fixture", terminal_id: "terminal-fixture", workspace_id: "workspace-fixture",
        agent_session: { agent: "grok", kind: "id", source: "herdr:grok", value: session },
      };
      const info = spyOn(herdr, "paneProcessInfo").mockResolvedValue({
        pane_id: pane.pane_id, foreground_processes: [{ pid: child.pid!, name: "grok", argv: [executable] }],
      });
      const nativeStat = fs.statSync;
      let replaced = false;
      const stats = spyOn(fs, "statSync").mockImplementation(new Proxy(nativeStat, {
        apply(target, receiver, args) {
          const replacement = "replacement" in scenario ? scenario.replacement : null;
          const file = replacement === "current" ? current : other;
          // Replace after /proc's link was read, before the path's stat is sampled.
          if (replacement && !replaced && args[0] === file) {
            replaced = true;
            unlinkSync(file);
            writeFileSync(file, "");
            utimesSync(file, replacement === "current" ? 400 : 100, replacement === "current" ? 400 : 100);
          }
          return Reflect.apply(target, receiver, args);
        },
      }));
      try {
        await once(child, "spawn", { signal: AbortSignal.timeout(2000) });
        if ("change" in scenario) {
          if (scenario.change === "unlink") unlinkSync(other);
          else renameSync(other, `${other}.old`);
        }
        expect(await resolveGrokStore(pane, home)).toBe(scenario.binds ? transcript : null);
      } finally {
        stats.mockRestore();
        info.mockRestore();
        const exited = once(child, "exit", { signal: AbortSignal.timeout(2000) });
        child.kill();
        await exited;
        for (const fd of fds) closeSync(fd);
      }
    });
  }
  test("discovery checks a script only behind bun or node, never arbitrary arguments", () => {
    const processes = [
      { pid: 11, argv: ["/usr/bin/node", "/opt/grok/grok.js"] },
      { pid: 12, argv: ["bun", "/opt/grok/grok-statusline.mjs"] },
      { pid: 13, argv: ["C:\\bin\\node.exe", "C:\\bin\\grok.cjs"] },
      { pid: 14, argv: ["/bin/sh", "grok"] },
      { pid: 15, argv: ["node", "unrelated.js", "grok"] },
      { pid: 16, argv: ["node"] },
      { pid: 17, argv: null },
    ];
    expect(grokPaneProcesses({ foreground_processes: processes }).map((p) => p.pid)).toEqual([11, 12, 13]);
  });
  test("custom home and hashed cwd names need no newest-file guess", () => {
    const hashed = join(root, "sessions", "long-slug-abc123", session, "updates.jsonl");
    mkdirSync(join(hashed, ".."), { recursive: true }); writeFileSync(hashed, user(0));
    expect(grokTranscriptPath(root, session)).toBe(hashed);
    writeFileSync(path, user(0));
    expect(grokTranscriptPath(root, session)).toBeNull();
    expect(grokTranscriptPath(root, "../escape")).toBeNull();
  });
  test("symlinked sessions are not followed outside the store", () => {
    const external = join(root, "external"); mkdirSync(external); writeFileSync(join(external, "updates.jsonl"), user(0));
    rmSync(join(path, ".."), { recursive: true }); symlinkSync(external, join(path, ".."));
    expect(grokTranscriptPath(root, session)).toBeNull();
  });
  test("pane environment chooses the home and never a relative store", () => {
    expect(grokHomeFromEnvironment("HOME=/user\0GROK_HOME=/custom store\0")).toBe("/custom store");
    expect(grokHomeFromEnvironment("HOME=/user\0")).toBe("/user/.grok");
    expect(grokHomeFromEnvironment("USERPROFILE=/user\0")).toBe("/user/.grok");
    expect(grokHomeFromEnvironment("HOME=/user\0GROK_HOME=relative\0")).toBeNull();
  });
  test("a ps environment line uses the last absolute home and never the bridge", () => {
    expect(grokHomeFromPsLine("/bin/grok HOME=/Users/me")).toBe("/Users/me/.grok");
    expect(grokHomeFromPsLine("/bin/grok HOME=/Users/me GROK_HOME=/custom/store")).toBe("/custom/store");
    expect(grokHomeFromPsLine("/bin/grok GROK_HOME=/first HOME=/Users/me GROK_HOME=/second")).toBe("/second");
    expect(grokHomeFromPsLine("/bin/grok HOME=/Users/me GROK_HOME=relative")).toBeNull();
    expect(grokHomeFromPsLine("/bin/grok USERPROFILE=/Users/me")).toBe("/Users/me/.grok");
    expect(grokHomeFromPsLine("/bin/grok GROK_HOME=/custom store TERM=xterm")).toBe("/custom store");
    expect(grokHomeFromPsLine("/bin/grok GROK_HOME=/custom NAME=/cut")).toBe("/custom");
    expect(grokHomeFromPsLine("/bin/grok")).toBeNull();
    expect(grokHomeFromPsLine("x".repeat(1024 * 1024 + 1))).toBeNull();
  });
});

describe("macOS held-file evidence", () => {
  const exe = "/usr/local/bin/grok-macos-aarch64";
  const pane = (value = session): HerdrPane => ({
    pane_id: "grok-fixture", agent: "grok", agent_status: "ready", focused: false,
    revision: 0, tab_id: "tab-fixture", terminal_id: "terminal-fixture", workspace_id: "workspace-fixture",
    agent_session: { agent: "grok", kind: "id", source: "herdr:grok", value },
  });
  const identity = (file: string) => {
    const stat = statSync(file);
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  };
  const record = (fd: string, file: string, id: { dev: number; ino: number } | null = null) => {
    const lines = [`f${fd}`];
    if (id) lines.push(`D0x${id.dev.toString(16)}`, `i${id.ino}`);
    lines.push(`n${file}`);
    return lines;
  };
  const listing = (extra: string[] = [], executable = exe) =>
    ["p4242", ...record("txt", executable), ...record("txt", "/usr/lib/dyld"), ...extra].join("\n") + "\n";

  test("lsof keeps the first txt executable and only numeric descriptors", () => {
    const text = [
      "p4242",
      "ftxt", "n/opt/grok-macos-aarch64 -> /usr/local/bin/grok-macos-aarch64",
      "ftxt", "n/usr/lib/dyld",
      "ftxt", "n/System/Library/Frameworks/SecErrorMessages.loctable",
      "fcwd", "D0xfe20", "i1", "n/tmp/cwd-events.jsonl",
      "frtd", "n/",
      "fmem", "n/usr/lib/dyld",
      "f4", "D0xfe20", "i65056", "n/tmp/sessions/group/sid/events.jsonl",
      "f5u", "n/tmp/no-device",
    ].join("\n");
    const evidence = grokLsofEvidence(text);
    expect(evidence?.executable).toBe("/usr/local/bin/grok-macos-aarch64");
    expect(evidence?.files).toEqual([
      { path: "/tmp/sessions/group/sid/events.jsonl", dev: 0xfe20, ino: 65056 },
      { path: "/tmp/no-device", dev: null, ino: null },
    ]);
    expect(grokLsofEvidence("n/tmp/orphan")).toBeNull();
    expect(grokLsofEvidence("f4\nn/a\nn/b")).toBeNull();
    expect(grokLsofEvidence("x".repeat(1024 * 1024 + 1))).toBeNull();
    const many = (count: number) => Array.from({ length: count }, () => "f1\nn/tmp/x").join("\n");
    expect(grokLsofEvidence(`ftxt\nn/bin/grok\n${many(4095)}`)).not.toBeNull();
    expect(grokLsofEvidence(`ftxt\nn/bin/grok\n${many(4096)}`)).toBeNull();
  });

  test("a held events file must be the named inode", () => {
    const home = realpathSync(root);
    const current = join(home, "sessions", "%2Ffiction", session, "events.jsonl");
    writeFileSync(join(current, "..", "updates.jsonl"), user(0));
    writeFileSync(current, "");
    const stat = identity(current);
    expect(grokHeldSessionsFromLsof([{ path: current, dev: stat.dev, ino: stat.ino }], home)?.get(dirname(current))).toBe(stat.mtimeMs);
    expect(grokHeldSessionsFromLsof([{ path: current, dev: stat.dev + 1, ino: stat.ino }], home)).toBeNull();
    expect(grokHeldSessionsFromLsof([{ path: current, dev: stat.dev, ino: stat.ino + 1 }], home)).toBeNull();
    expect(grokHeldSessionsFromLsof([{ path: current, dev: null, ino: stat.ino }], home)).toBeNull();
    expect(grokHeldSessionsFromLsof([{ path: `${current} (deleted)`, dev: stat.dev, ino: stat.ino }], home)).toBeNull();
    expect(grokHeldSessionsFromLsof([{ path: `${current}.old`, dev: stat.dev, ino: stat.ino }], home)).toBeNull();
    const external = join(home, "external-events.jsonl");
    writeFileSync(external, "");
    unlinkSync(current);
    symlinkSync(external, current);
    const link = identity(external);
    expect(grokHeldSessionsFromLsof([{ path: current, dev: link.dev, ino: link.ino }], home)).toBeNull();
  });

  const place = (otherMtime: number, otherSession = "older-session", otherGroup = "group") => {
    const home = realpathSync(root);
    const transcript = join(home, "sessions", "%2Ffiction", session, "updates.jsonl");
    const current = join(dirname(transcript), "events.jsonl");
    const other = join(home, "sessions", otherGroup, otherSession, "events.jsonl");
    const retained = join(home, "sessions", "group", "retained-session", "events.jsonl");
    const outside = join(home, "events.jsonl");
    mkdirSync(dirname(other), { recursive: true });
    mkdirSync(dirname(retained), { recursive: true });
    writeFileSync(transcript, user(0));
    writeFileSync(current, "");
    writeFileSync(other, "");
    writeFileSync(retained, "");
    writeFileSync(outside, "");
    utimesSync(current, 200, 200);
    utimesSync(other, otherMtime, otherMtime);
    utimesSync(retained, 50, 50);
    utimesSync(outside, 400, 400);
    const files = [current, other, retained, outside].map((file) => {
      const stat = identity(file);
      return record(String(10 + file.length), file, stat);
    });
    return { home, transcript, current, other, listing: listing([...record("cwd", other, identity(other)), ...record("mem", "/usr/lib/dyld"), ...files.flat()]) };
  };

  async function darwin(store: { home: string; listing: string }, options: {
    configured?: string; ps?: string | null; lsofExit?: number; psExit?: number;
    processes?: { pid: number; argv?: string[] | null }[]; platform?: NodeJS.Platform;
    sessionPane?: HerdrPane; throwOn?: "lsof" | "ps"; executable?: string;
  } = {}) {
    const calls: { argv: readonly string[]; timeoutMs: number }[] = [];
    let pending = 0;
    let overlapped = false;
    const asked = { processInfo: false, run: false };
    const lookup: GrokLookup = {
      platform: options.platform ?? "darwin",
      processInfo: async () => {
        asked.processInfo = true;
        return { foreground_processes: options.processes ?? [{ pid: 4242, argv: [exe] }] };
      },
      run: (argv, timeoutMs) => {
        asked.run = true;
        pending += 1;
        if (pending > 1) overlapped = true;
        calls.push({ argv, timeoutMs });
        return Promise.resolve().then(() => {
          pending -= 1;
          const isPs = argv[0] === "/bin/ps";
          if (options.throwOn === (isPs ? "ps" : "lsof")) throw new Error("host failed");
          const text = options.executable ? store.listing.replace(`n${exe}\n`, `n${options.executable}\n`) : store.listing;
          return { stdout: isPs ? (options.ps ?? `GROK_HOME=${store.home}`) : text, exitCode: isPs ? (options.psExit ?? 0) : (options.lsofExit ?? 0) };
        });
      },
    };
    const result = await resolveGrokStore(options.sessionPane ?? pane(), options.configured, lookup);
    return { result, calls, overlapped, asked };
  }

  test("binds Herdr's session when its held events file is strictly newest", async () => {
    const store = place(100);
    const previousHome = process.env.HOME;
    const previousGrok = process.env.GROK_HOME;
    process.env.HOME = "/bridge-home";
    process.env.GROK_HOME = "/bridge-grok";
    try {
      const { result, calls, overlapped } = await darwin(store, { ps: `/usr/local/bin/grok HOME=/bridge-home GROK_HOME=${store.home}` });
      expect(result).toBe(store.transcript);
      expect(calls.map((call) => call.argv)).toEqual([
        ["/usr/sbin/lsof", "-nPbw", "-a", "-p", "4242", "-FfDin"],
        ["/bin/ps", "-E", "-ww", "-p", "4242", "-o", "command="],
      ]);
      expect(calls.every((call) => call.timeoutMs === 3000)).toBe(true);
      expect(overlapped).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousGrok === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previousGrok;
    }
  });

  test("uses HOME/.grok from ps and a configured home skips ps", async () => {
    const userHome = join(realpathSync(root), "macos-user");
    const home = join(userHome, ".grok");
    const transcript = join(home, "sessions", "group", session, "updates.jsonl");
    const current = join(dirname(transcript), "events.jsonl");
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, user(0));
    writeFileSync(current, "");
    const stat = identity(current);
    const store = { home, listing: listing(record("4", current, stat)) };
    expect((await darwin(store, { ps: `/bin/grok HOME=${userHome}` })).result).toBe(transcript);
    const configured = await darwin(store, { configured: home, ps: "GROK_HOME=/wrong" });
    expect(configured.result).toBe(transcript);
    expect(configured.calls.map((call) => call.argv[0])).toEqual(["/usr/sbin/lsof"]);
  });

  for (const scenario of [
    { name: "another held session is newer", otherMtime: 300 },
    { name: "held write times tie", otherMtime: 200 },
    { name: "the reported id is held twice", otherMtime: 100, otherSession: session, otherGroup: "other-group" },
  ]) {
    test(`stays on the terminal when ${scenario.name}`, async () => {
      const store = place(scenario.otherMtime, scenario.otherSession, scenario.otherGroup);
      expect((await darwin(store)).result).toBeNull();
    });
  }

  test("does not select a different session from held files", async () => {
    const store = place(300, "resumed-session");
    const withoutReported = store.listing.split("\n").filter((line) => !line.endsWith(`${session}/events.jsonl`)).join("\n");
    expect((await darwin({ ...store, listing: withoutReported })).result).toBeNull();
    const second = join(store.home, "sessions", "other-group", session, "updates.jsonl");
    mkdirSync(dirname(second), { recursive: true });
    writeFileSync(second, user(0));
    expect((await darwin(store)).result).toBeNull();
  });

  test("deleted, renamed, and replaced held files stay on the terminal", async () => {
    const store = place(100);
    const deleted = store.listing.replaceAll(`${session}/events.jsonl\n`, `${session}/events.jsonl (deleted)\n`);
    expect((await darwin({ ...store, listing: deleted })).result).toBeNull();
    const renamed = store.listing.replaceAll(`${session}/events.jsonl\n`, `${session}/events.jsonl.old\n`);
    expect((await darwin({ ...store, listing: renamed })).result).toBeNull();
    const stat = identity(store.current);
    const marker = `D0x${stat.dev.toString(16)}\ni${stat.ino}\nn${store.current}\n`;
    const replaced = store.listing.replace(marker, `D0x${stat.dev.toString(16)}\ni${stat.ino + 1}\nn${store.current}\n`);
    expect(replaced).not.toBe(store.listing);
    expect((await darwin({ ...store, listing: replaced })).result).toBeNull();
    const noDevice = store.listing.replace(marker, `n${store.current}\n`);
    expect((await darwin({ ...store, listing: noDevice })).result).toBeNull();
  });

  test("a mapped file listed as txt is not the executable", async () => {
    const store = place(100);
    expect((await darwin(store, { executable: "/usr/lib/dyld" })).result).toBeNull();
    expect((await darwin(store, { executable: "/usr/local/bin/grok (deleted)" })).result).toBe(store.transcript);
  });

  test("a failed host command is an unreadable listing", async () => {
    const store = place(100);
    expect((await darwin(store, { lsofExit: 1 })).result).toBeNull();
    expect((await darwin(store, { psExit: 1 })).result).toBeNull();
    expect((await darwin(store, { throwOn: "lsof" })).result).toBeNull();
    expect((await darwin(store, { throwOn: "ps" })).result).toBeNull();
    expect((await darwin(store, { ps: "HOME=/does-not-exist GROK_HOME=relative" })).result).toBeNull();
  });

  test("windows, the wrong session source, and anything but one Grok process do not spawn", async () => {
    const store = place(100);
    const silent = async (platform: NodeJS.Platform, processes?: { pid: number; argv?: string[] | null }[], sessionPane = pane()) => {
      const found = await darwin(store, { platform, processes, sessionPane });
      expect(found.result).toBeNull();
      expect(found.asked.run).toBe(false);
      if (platform !== "linux" && platform !== "darwin") expect(found.asked.processInfo).toBe(false);
      return found;
    };
    await silent("win32");
    const wrong = pane();
    wrong.agent_session = { agent: "grok", kind: "id", source: "user", value: session };
    await silent("darwin", undefined, wrong);
    await silent("darwin", []);
    await silent("darwin", [{ pid: 4, argv: [exe] }, { pid: 5, argv: ["grok"] }]);
    await silent("darwin", [{ pid: 0, argv: [exe] }]);
    await silent("darwin", [{ pid: 1.5, argv: [exe] }]);
    const linux = await silent("linux", [{ pid: process.pid, argv: ["grok"] }]);
    expect(linux.asked.processInfo).toBe(true);
  });
});
