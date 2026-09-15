import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: { select: vi.fn(), update: vi.fn() } }));
vi.mock("../../shared/audit/audit.service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("../../shared/cache", () => ({ invalidateCacheByPrefix: vi.fn() }));

import * as dbClientModule from "../../db/client";
import { updateCollection } from "./market-collections.service";

const db = vi.mocked(dbClientModule.db);

// This is the exact path the admin PATCH /market-collections/:id endpoint
// uses to set showOnWidgetDefault/widgetOrder - proves the mechanism
// section 2 of the widget-defaults task needs is real and working, ahead
// of the 4 target collections actually existing to apply it to.
const EXISTING_ROW = {
  id: "col-1",
  name: "BSE 100",
  description: null,
  active: true,
  showOnWidgetDefault: false,
  widgetOrder: null,
};

function selectResult(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain as never;
}

function mockUpdateChain(returned: unknown) {
  const returning = vi.fn(async () => [returned]);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  db.update.mockReturnValueOnce({ set } as never);
  return set;
}

describe("updateCollection - Widget default flags", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sets showOnWidgetDefault and widgetOrder via the existing admin update path", async () => {
    db.select.mockReturnValueOnce(selectResult([EXISTING_ROW]) as never);
    const set = mockUpdateChain({ ...EXISTING_ROW, showOnWidgetDefault: true, widgetOrder: 1 });

    await updateCollection({
      id: "col-1",
      showOnWidgetDefault: true,
      widgetOrder: 1,
      actorUserId: "admin-1",
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ showOnWidgetDefault: true, widgetOrder: 1 })
    );
  });

  it("leaves showOnWidgetDefault/widgetOrder untouched when omitted from the update", async () => {
    const existing = { ...EXISTING_ROW, showOnWidgetDefault: true, widgetOrder: 3 };
    db.select.mockReturnValueOnce(selectResult([existing]) as never);
    const set = mockUpdateChain(existing);

    await updateCollection({ id: "col-1", name: "BSE 100 Renamed", actorUserId: "admin-1" });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ showOnWidgetDefault: true, widgetOrder: 3 })
    );
  });

  it("can explicitly clear widgetOrder back to null while keeping showOnWidgetDefault", async () => {
    const existing = { ...EXISTING_ROW, showOnWidgetDefault: true, widgetOrder: 2 };
    db.select.mockReturnValueOnce(selectResult([existing]) as never);
    const set = mockUpdateChain({ ...existing, widgetOrder: null });

    await updateCollection({ id: "col-1", widgetOrder: null, actorUserId: "admin-1" });

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ widgetOrder: null }));
  });

  it("can unset showOnWidgetDefault (removing a collection from the default set)", async () => {
    const existing = { ...EXISTING_ROW, showOnWidgetDefault: true, widgetOrder: 4 };
    db.select.mockReturnValueOnce(selectResult([existing]) as never);
    const set = mockUpdateChain({ ...existing, showOnWidgetDefault: false });

    await updateCollection({ id: "col-1", showOnWidgetDefault: false, actorUserId: "admin-1" });

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ showOnWidgetDefault: false }));
  });
});
