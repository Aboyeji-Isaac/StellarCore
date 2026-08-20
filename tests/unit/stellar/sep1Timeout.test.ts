import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchSep1Toml,
  Sep1DiscoveryError,
} from "@/lib/stellar/sep1";

test("fetchSep1Toml aborts slow requests with a typed timeout error", async () => {
  const fetcher = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason);
      });
    })) as typeof fetch;

  await assert.rejects(
    fetchSep1Toml("anchor.example", { fetcher, timeoutMs: 5 }),
    (error) =>
      error instanceof Sep1DiscoveryError && error.code === "TIMEOUT",
  );
});
