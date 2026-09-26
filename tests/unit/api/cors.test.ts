import assert from "node:assert/strict";
import test from "node:test";

import { publicApiHeaders } from "@/lib/api/cors";

test("public API CORS headers allow read-only browser access", () => {
  assert.deepEqual(publicApiHeaders({ "Cache-Control": "no-store" }), {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
});
