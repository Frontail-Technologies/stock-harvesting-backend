import { describe, expect, it, vi } from "vitest";

import { GlobalDatafeedsWebSocketClient } from "./global-datafeeds.websocket-client";

describe("GlobalDatafeedsWebSocketClient response handling", () => {
  it("matches HistoryOHLCResult to a pending GetHistory request", () => {
    const client = new GlobalDatafeedsWebSocketClient();
    const resolve = vi.fn();
    const timeout = setTimeout(() => undefined, 60_000);
    const internal = client as unknown as {
      pending: Map<string, unknown>;
      handleMessage: (response: unknown) => void;
    };
    internal.pending.set("history-1", {
      messageType: "GetHistory",
      userTag: "history-1",
      resolve,
      reject: vi.fn(),
      timeout,
    });

    const response = { MessageType: "HistoryOHLCResult", Result: [{ Close: 100 }] };
    internal.handleMessage(response);

    expect(resolve).toHaveBeenCalledWith(response);
    expect(internal.pending.size).toBe(0);
  });

  it("runs local response-bearing requests one at a time", async () => {
    const client = new GlobalDatafeedsWebSocketClient();
    const internal = client as unknown as {
      runSerializedLocalRequest: <T>(run: () => Promise<T>) => Promise<T>;
    };
    let releaseFirst!: () => void;
    const first = internal.runSerializedLocalRequest(
      () => new Promise<void>((resolve) => { releaseFirst = resolve; }),
    );
    const secondRun = vi.fn(async () => "second");
    const second = internal.runSerializedLocalRequest(secondRun);

    await Promise.resolve();
    expect(secondRun).not.toHaveBeenCalled();
    releaseFirst();
    await first;
    await expect(second).resolves.toBe("second");
  });
});
