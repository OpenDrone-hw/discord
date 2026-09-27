import { describe, expect, it, vi } from "vitest";
import { DeliveryStore, RETENTION_MS, STALE_CLAIM_MS, TABLE_SQL, onceFor, storeFor } from "../../src/github/deliveries.ts";
import { brokenD1, sqliteD1 } from "./fakes.ts";

function setup(start = 1_800_000_000_000) {
  const clock = { t: start };
  const db = sqliteD1();
  const store = new DeliveryStore(db, () => clock.t);
  return { clock, db, store };
}

describe("DeliveryStore", () => {
  it("creates its table on first use", async () => {
    const { db, store } = setup();
    expect(TABLE_SQL).toContain("CREATE TABLE IF NOT EXISTS github_deliveries");
    await store.claim("d:x");
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM github_deliveries").get()).toEqual({ n: 1 });
  });

  it("claims once, then reports busy until completed, then done with the result", async () => {
    const { store } = setup();
    expect(await store.claim("d:thread")).toEqual({ kind: "claimed" });
    expect(await store.claim("d:thread")).toEqual({ kind: "busy" });
    await store.complete("d:thread", "1500000000000000001");
    expect(await store.claim("d:thread")).toEqual({ kind: "done", result: "1500000000000000001" });
  });

  it("stores an undefined result as done without a value", async () => {
    const { store } = setup();
    await store.claim("d:feed");
    await store.complete("d:feed", undefined);
    expect(await store.claim("d:feed")).toEqual({ kind: "done", result: undefined });
  });

  it("reclaims a claim left running longer than the stale limit", async () => {
    const { store, clock } = setup();
    await store.claim("d:card");
    clock.t += STALE_CLAIM_MS - 1;
    expect(await store.claim("d:card")).toEqual({ kind: "busy" });
    clock.t += 2;
    expect(await store.claim("d:card")).toEqual({ kind: "claimed" });
  });

  it("releases a running claim but never a done one", async () => {
    const { store } = setup();
    await store.claim("a");
    await store.release("a");
    expect(await store.claim("a")).toEqual({ kind: "claimed" });
    await store.complete("a", 1);
    await store.release("a");
    expect(await store.claim("a")).toEqual({ kind: "done", result: 1 });
  });

  it("prunes rows older than the retention", async () => {
    const { store, clock } = setup();
    await store.claim("old");
    await store.complete("old", null);
    clock.t += RETENTION_MS + 1;
    await store.claim("new");
    expect(await store.prune()).toBe(1);
    expect(await store.claim("old")).toEqual({ kind: "claimed" });
    expect(await store.claim("new")).toEqual({ kind: "busy" });
  });
});

describe("onceFor", () => {
  it("runs a step once per delivery and returns the stored result on redelivery", async () => {
    const { store } = setup();
    const run = vi.fn(async () => "thread-1");
    expect(await onceFor(store, "d-1")("thread", run)).toBe("thread-1");
    expect(await onceFor(store, "d-1")("thread", run)).toBe("thread-1");
    expect(run).toHaveBeenCalledOnce();
    expect(await onceFor(store, "d-2")("thread", run)).toBe("thread-1");
    expect(run).toHaveBeenCalledTimes(2);
    expect(await onceFor(store, "d-1")("feed", run)).toBe("thread-1");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("skips a step another invocation is running", async () => {
    const { store } = setup();
    await store.claim("d-1:card");
    const run = vi.fn(async () => true);
    expect(await onceFor(store, "d-1")("card", run)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("lets a redelivery retry a step that failed", async () => {
    const { store } = setup();
    const once = onceFor(store, "d-1");
    await expect(once("feed", async () => Promise.reject(new Error("discord down")))).rejects.toThrow("discord down");
    const run = vi.fn(async () => "ok");
    expect(await once("feed", run)).toBe("ok");
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs without deduplication when there is no delivery id or store", async () => {
    const { store } = setup();
    const run = vi.fn(async () => 1);
    await onceFor(store, null)("x", run);
    await onceFor(store, null)("x", run);
    await onceFor(null, "d-1")("x", run);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("fails open when D1 is unavailable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn(async () => "posted");
    expect(await onceFor(new DeliveryStore(brokenD1()), "d-1")("feed", run)).toBe("posted");
    expect(run).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).toContain("running without deduplication");
  });

  it("treats a binding without prepare() as absent", () => {
    expect(storeFor(undefined)).toBeNull();
    expect(storeFor({} as D1Database)).toBeNull();
    expect(storeFor(sqliteD1())).toBeInstanceOf(DeliveryStore);
  });
});
