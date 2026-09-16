import { describe, expect, it, vi } from "vitest";

import { readWorkerHeartbeat, WORKER_NAMES, writeWorkerHeartbeat } from "./worker-heartbeat";

function fakeClient(store: Map<string, string>) {
  return {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };
}

describe("writeWorkerHeartbeat / readWorkerHeartbeat", () => {
  it("reports online for a recent heartbeat", async () => {
    const store = new Map<string, string>();
    const client = fakeClient(store);
    const now = new Date("2026-09-15T10:00:00.000Z");

    await writeWorkerHeartbeat(client, WORKER_NAMES.marketData, now.toISOString(), now);
    const status = await readWorkerHeartbeat(client, WORKER_NAMES.marketData, now);

    expect(status.status).toBe("online");
    expect(status.lastHeartbeat).toBe(now.toISOString());
  });

  it("reports offline for a stale heartbeat", async () => {
    const store = new Map<string, string>();
    const client = fakeClient(store);
    const startedAt = new Date("2026-09-15T09:00:00.000Z");

    await writeWorkerHeartbeat(client, WORKER_NAMES.marketData, startedAt.toISOString(), startedAt);

    const muchLater = new Date("2026-09-15T10:00:00.000Z");
    const status = await readWorkerHeartbeat(client, WORKER_NAMES.marketData, muchLater);

    expect(status.status).toBe("offline");
  });

  it("reports offline when no heartbeat key exists", async () => {
    const store = new Map<string, string>();
    const client = fakeClient(store);

    const status = await readWorkerHeartbeat(client, WORKER_NAMES.marketData);

    expect(status.status).toBe("offline");
    expect(status.lastHeartbeat).toBeNull();
  });
});
