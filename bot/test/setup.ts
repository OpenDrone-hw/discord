import { beforeEach, vi } from "vitest";

// Tests never reach the network: every client gets a mocked fetch, and the
// global one fails loudly if something slips through.
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("network access in tests");
  });
});
