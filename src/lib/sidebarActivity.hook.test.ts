import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { useSidebarActivityState, type SidebarActivity } from "./sidebarActivity.tsx";
import { loadSeen, saveSeen } from "./sidebarOrder.ts";

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
function roster(counters: Record<string, number>, statuses: Record<string, AgentStatus> = {}): Machine[] {
  const machine = structuredClone(fixture[0]);
  if (!machine?.snapshot) throw new Error("fixture has no snapshot");
  const pane = machine.snapshot.panes[0];
  const agent = machine.snapshot.agents[0];
  if (!pane || !agent) throw new Error("fixture has no agent pane");
  machine.snapshot.panes = Object.keys(counters).map((id) => ({ ...pane, pane_id: id, agent_status: statuses[id] ?? "done" }));
  machine.snapshot.agents = Object.entries(counters).map(([id, seq]) => ({
    ...agent, pane_id: id, agent_status: statuses[id] ?? "done", state_change_seq: seq,
  }));
  return [machine];
}

describe("sidebar activity through real React effects", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderers: ReactTestRenderer[];
  let visibility: DocumentVisibilityState;
  let events: EventTarget;

  beforeEach(() => {
    for (const key of ["document", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    renderers = [];
    visibility = "visible";
    events = new EventTarget();
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get visibilityState() { return visibility; },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      get length() { return data.size; },
      key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    } });
  });
  afterEach(async () => {
    await act(async () => { for (const renderer of renderers) renderer.unmount(); });
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function open(machines: Machine[], selected: string | null = null) {
    let activity: SidebarActivity | undefined;
    function Probe({ machines, selected, epoch = 0 }: { machines: Machine[]; selected: string | null; epoch?: number }) {
      activity = useSidebarActivityState(machines, "local", selected, epoch);
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    await act(async () => { renderer = create(createElement(Probe, { machines, selected })); });
    if (!renderer) throw new Error("probe did not mount");
    const mounted = renderer;
    renderers.push(mounted);
    return {
      status(id: string): AgentStatus | undefined {
        if (!activity) throw new Error("probe did not render");
        return activity.status("local", { pane_id: id, agent_status: "done" });
      },
      async update(next: Machine[], paneId: string | null = null, epoch = 0): Promise<void> {
        await act(async () => { mounted.update(createElement(Probe, { machines: next, selected: paneId, epoch })); });
      },
    };
  }

  it("drops the entire loaded record when one live counter proves a closed-page restart", async () => {
    saveSeen("local", { a: 2, b: 100 });
    const client = await open(roster({ a: 2, b: 1 }));
    expect([client.status("a"), client.status("b")]).toEqual(["done", "done"]);
    expect(loadSeen("local")).toEqual({});
  });

  it("waits for a nonempty roster before validating a loaded record against a restart", async () => {
    saveSeen("local", { a: 2, b: 100 });
    const client = await open(roster({}));
    expect(loadSeen("local")).toEqual({ a: 2, b: 100 });
    await client.update(roster({ a: 2, b: 1 }));
    expect([client.status("a"), client.status("b")]).toEqual(["done", "done"]);
    expect(loadSeen("local")).toEqual({});
  });

  it("keeps another tab's marks when two already-open tabs read different panes", async () => {
    const machines = roster({ a: 1, b: 2 });
    const first = await open(machines);
    const second = await open(machines);
    await first.update(machines, "a");
    await second.update(machines, "b");
    expect(loadSeen("local")).toEqual({ a: 1, b: 2 });
    const reloaded = await open(machines);
    expect([reloaded.status("a"), reloaded.status("b")]).toEqual(["idle", "idle"]);
  });

  it("keeps a newer mark from another tab while this mounted tab still has an older roster", async () => {
    const machines = roster({ a: 1, b: 2 });
    const first = await open(machines);
    const second = await open(machines);
    await first.update(roster({ a: 4, b: 2 }), "a");
    await second.update(machines, "b");
    expect(loadSeen("local")).toEqual({ a: 4, b: 2 });
  });

  it("keeps a later unseen DONE after a disconnect during stand-in carry", async () => {
    const client = await open(roster({ a: 5, b: 9 }, { a: "working" }), "a");
    const finished = roster({ a: 5, b: 9 });
    await client.update(finished, "a");
    expect(client.status("a")).toBe("idle");
    await client.update(finished, "b");
    await client.update(finished.map((machine) => ({ ...machine, state: "disconnected" })), "b");
    await client.update(roster({ a: 12, b: 9 }), "b");
    expect(client.status("a")).toBe("done");
  });

  it("does not carry even an adjacent counter across a known connection gap", async () => {
    const client = await open(roster({ a: 5, b: 9 }, { a: "working" }), "a");
    const finished = roster({ a: 5, b: 9 });
    await client.update(finished, "a");
    await client.update(finished.map((machine) => ({ ...machine, state: "reconnecting" })));
    await client.update(roster({ a: 10, b: 9 }));
    expect(client.status("a")).toBe("done");
  });

  it("drops carry after the browser event stream reconnects while the PC stays connected", async () => {
    const client = await open(roster({ a: 5, b: 9 }, { a: "working" }), "a");
    const finished = roster({ a: 5, b: 9 });
    await client.update(finished, "a");
    await client.update(finished, null, 1);
    await client.update(roster({ a: 10, b: 9 }), null, 1);
    expect(client.status("a")).toBe("done");
  });

  it("records no look while the page is hidden and records one when it becomes visible", async () => {
    visibility = "hidden";
    const client = await open(roster({ a: 2 }), "a");
    expect(client.status("a")).toBe("done");
    await act(async () => { visibility = "visible"; events.dispatchEvent(new Event("visibilitychange")); });
    expect(client.status("a")).toBe("idle");
  });

  it("does not record a disconnected or absent presented pane", async () => {
    const machines = roster({ a: 2 });
    const client = await open(machines.map((machine) => ({ ...machine, state: "disconnected" })), "a");
    expect(client.status("a")).toBe("done");
    await client.update(machines);
    expect(client.status("a")).toBe("done");
    await client.update(machines, "a");
    expect(client.status("a")).toBe("idle");
  });

  it("drops equal-counter marks after a restart observed by the mounted page", async () => {
    const machines = roster({ a: 2, b: 100 });
    const client = await open(machines, "a");
    await client.update(machines, "b");
    await client.update(roster({ a: 2, b: 1 }));
    expect([client.status("a"), client.status("b")]).toEqual(["done", "done"]);
    expect(loadSeen("local")).toEqual({});
  });

  it("prunes closed panes and removed PCs without discarding an offline record", async () => {
    saveSeen("local", { a: 2, gone: 5 });
    saveSeen("removed", { z: 4 });
    const client = await open(roster({ a: 2 }));
    expect(loadSeen("local")).toEqual({ a: 2 });
    expect(loadSeen("removed")).toBeNull();
    await client.update(roster({ a: 2 }).map((machine) => ({ ...machine, state: "disconnected", snapshot: null })));
    expect(loadSeen("local")).toEqual({ a: 2 });
  });
});
