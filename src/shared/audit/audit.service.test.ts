import { beforeEach, describe, expect, it, vi } from "vitest";

import { writeAuditLog } from "./audit.service";

const values = vi.fn().mockResolvedValue(undefined);
const insert = vi.fn();

vi.mock("../../db/client", () => ({
  db: {
    insert: (...args: unknown[]) => insert(...args),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  values.mockResolvedValue(undefined);
  insert.mockReturnValue({ values });
});

describe("writeAuditLog", () => {
  it("writes every provided field through to the insert", async () => {
    await writeAuditLog({
      actorUserId: "user-1",
      action: "market_collection.updated",
      targetType: "market_collection",
      targetId: "col-1",
      metadata: { active: true },
    });

    expect(values).toHaveBeenCalledWith({
      actorUserId: "user-1",
      action: "market_collection.updated",
      targetType: "market_collection",
      targetId: "col-1",
      metadata: { active: true },
    });
  });

  it("defaults metadata to an empty object when omitted", async () => {
    await writeAuditLog({
      actorUserId: null,
      action: "data_provider.connect_url_created",
      targetType: "data_provider",
    });

    expect(values).toHaveBeenCalledWith({
      actorUserId: null,
      action: "data_provider.connect_url_created",
      targetType: "data_provider",
      targetId: undefined,
      metadata: {},
    });
  });
});
