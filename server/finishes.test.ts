import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus, SessionSnapshot } from "../shared/protocol.ts";
import machines from "../site/demo/fixtures/machines.json";
import { CompletionTracker } from "./completion.ts";
import { Finishes, finishHerdrIdentity } from "./finishes.ts";
import { LaunchedAgents } from "./launched-agents.ts";

function snapshot(status: AgentStatus): SessionSnapshot {
  const fixture = machines.machines[0]!.snapshot!;
  return { ...fixture, panes: [{ ...fixture.panes[0]!, pane_id: "p", agent: "codex", agent_status: status }],
    agents: [{ ...fixture.agents[0]!, pane_id: "p", agent: "codex", agent_status: status, state_change_seq: 5 }] };
}

it("counts the completion tracker's displayed DONE with an unchanged herdr sequence", async () => {
  const tracker = new CompletionTracker();
  const finishes = new Finishes(() => "daemon-a");
  const shown = async (status: AgentStatus) => finishes.snapshot(await tracker.readSnapshot(async () => snapshot(status)));
  expect((await shown("working")).panes[0]?.finish_id).toBe(0);
  const done = await shown("unknown");
  expect(done.agents[0]?.state_change_seq).toBe(5);
  expect(done.panes[0]).toMatchObject({ agent_status: "done", finish_id: 1 });
  expect((await shown("unknown")).panes[0]?.finish_id).toBe(1);
  await shown("working");
  expect((await shown("unknown")).panes[0]?.finish_id).toBe(2);
});

it("counts only the post-launch status, not startup's raw WORKING and DONE", () => {
  const launched = new LaunchedAgents();
  const finishes = new Finishes(() => "daemon-a");
  launched.launched("p", "codex", 100);
  expect(finishes.status("p", launched.settle("p", "working", 100)).finish_id).toBe(0);
  expect(finishes.status("p", launched.settle("p", "done", 101)).finish_id).toBe(0);
  finishes.status("p", launched.settle("p", "working", 102));
  expect(finishes.status("p", launched.settle("p", "done", 103)).finish_id).toBe(1);
});

it("shares one counter between status frames and snapshots, including repeats and pane ID reuse", () => {
  const finishes = new Finishes(() => "daemon-a");
  finishes.status("p", "working");
  const event = finishes.status("p", "done");
  expect(event.finish_id).toBe(1);
  expect(finishes.snapshot(snapshot("done"))).toMatchObject({ finish_epoch: event.finish_epoch, panes: [{ finish_id: 1 }] });
  expect(finishes.status("p", "done")).toEqual(event);
  finishes.ended("p");
  expect(finishes.status("p", "done").finish_id).toBe(2);
});

it("starts with a random epoch per server and rotates on proven herdr identity change, not read failures", () => {
  let identity: string | null = "daemon-a";
  const finishes = new Finishes(() => identity);
  const first = finishes.status("p", "done");
  expect(new Finishes(() => identity).epoch).not.toBe(first.finish_epoch);
  identity = null;
  expect(finishes.epoch).toBe(first.finish_epoch);
  identity = "daemon-a";
  expect(finishes.status("p", "done")).toEqual(first);
  identity = "daemon-b";
  const restarted = finishes.status("p", "done");
  expect(restarted.finish_epoch).not.toBe(first.finish_epoch);
  expect(restarted.finish_id).toBe(1);
  expect(finishes.snapshot(snapshot("done")).finish_epoch).toBe(restarted.finish_epoch);
});

it("recognizes a replaced socket file and Windows marker incarnation, never just a reused PID", () => {
  const dir = mkdtempSync(join(tmpdir(), "finish-identity-"));
  try {
    const first = join(dir, "first"), second = join(dir, "second");
    writeFileSync(first, "123:1790829888292852700");
    writeFileSync(second, "123:1790829888292852701");
    expect(finishHerdrIdentity(first, "linux")).not.toBe(finishHerdrIdentity(second, "linux"));
    expect(finishHerdrIdentity(first, "win32")).not.toBe(finishHerdrIdentity(second, "win32"));
    expect(finishHerdrIdentity(join(dir, "missing"), "linux")).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
