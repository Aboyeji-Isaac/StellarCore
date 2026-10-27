import assert from "node:assert/strict";
import test from "node:test";

// Route handlers import dbClient lazily. Supply read-only, in-memory delegates
// before that import so this suite cannot open a database connection.
const databaseReads: string[] = [];
const read = <T>(name: string, value: T) => async () => {
  databaseReads.push(name);
  return value;
};
const globals = globalThis as typeof globalThis & {
  prisma?: unknown;
  pool?: unknown;
};
const previousPrisma = globals.prisma;
const previousPool = globals.pool;
globals.prisma = {
  anchor: {
    findMany: read("anchor.findMany", []),
    findUnique: read("anchor.findUnique", null),
  },
  corridor: {
    findMany: read("corridor.findMany", []),
    findUnique: read("corridor.findUnique", null),
  },
};
globals.pool = {};

/**
 * Each request now carries its own correlation id (#369). Body comparisons in
 * this suite are about query validation, so the per-request id is removed
 * before comparing a response with the baseline response.
 */
function withoutRequestId(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return value;
  const { requestId: _requestId, ...rest } = error as Record<string, unknown>;
  return { ...value, error: rest };
}

test("public evidence GET routes ignore media headers and bodies while retaining query validation", async (t) => {
  try {
    const [anchors, anchor, corridors, corridor, rates, history, reputation, score] = await Promise.all([
      import("@/app/api/anchors/route"),
      import("@/app/api/anchors/[slug]/route"),
      import("@/app/api/corridors/route"),
      import("@/app/api/corridors/[slug]/route"),
      import("@/app/api/rates/route"),
      import("@/app/api/rates/history/route"),
      import("@/app/api/reputation/route"),
      import("@/app/api/reputation/[slug]/route"),
    ]);
    const context = (slug: string) => ({ params: Promise.resolve({ slug }) });
    const cases = [
      { path: "anchors", get: anchors.GET, status: 200 },
      { path: "corridors", get: corridors.GET, status: 200 },
      { path: "reputation", get: reputation.GET, status: 200 },
      { path: "anchors/example", get: (r: Request) => anchor.GET(r, context("example")), status: 404 },
      { path: "corridors/example", get: (r: Request) => corridor.GET(r, context("example")), status: 404 },
      { path: "reputation/example", get: (r: Request) => score.GET(r, context("example")), status: 404 },
      { path: "rates?corridor=example", get: rates.GET, status: 404 },
      { path: "rates/history?corridor=example", get: history.GET, status: 404 },
      { path: "rates", get: rates.GET, status: 400 },
      { path: "rates/history?corridor=example&days=bad", get: history.GET, status: 400 },
      { path: "anchors/bad--slug", get: (r: Request) => anchor.GET(r, context("bad--slug")), status: 400 },
      { path: "corridors/bad--slug", get: (r: Request) => corridor.GET(r, context("bad--slug")), status: 400 },
      { path: "reputation/bad--slug", get: (r: Request) => score.GET(r, context("bad--slug")), status: 400 },
    ];
    let client = 0;
    for (const route of cases) {
      await t.test(route.path, async () => {
        const request = (headers: Record<string, string> = {}) => new Request(`http://localhost/api/${route.path}`, {
          headers: { ...headers, "x-real-ip": `input-test-${client++}` },
        });
        const baseline = await route.get(request());
        assert.equal(baseline.status, route.status);
        const expected = await baseline.json();
        const expectedReads = databaseReads.splice(0);
        for (const contentType of ["application/json", "application/json; charset=utf-8", "text/plain", "application/xml", "multipart/form-data; boundary=test", "application/octet-stream", "invalid"]) {
          for (const withBody of [false, true]) {
            const input = request({ "content-type": contentType, accept: "text/html, application/json;q=0" });
            // Fetch forbids constructing a GET Request with a body. Model a
            // body reaching the handler from another HTTP client, and fail if
            // the handler attempts to inspect or consume it.
            if (withBody) {
              for (const property of ["body", "json", "text", "arrayBuffer", "formData", "blob", "bytes"]) {
                Object.defineProperty(input, property, {
                  get() { throw new Error("GET body must not be inspected or parsed"); },
                });
              }
              input.headers.set("content-length", "19");
            }
            const response = await route.get(input);
            assert.equal(response.status, baseline.status);
            assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.deepEqual(withoutRequestId(await response.json()), withoutRequestId(expected));
            assert.deepEqual(databaseReads.splice(0), expectedReads);
          }
        }
      });
    }
  } finally {
    globals.prisma = previousPrisma;
    globals.pool = previousPool;
  }
});
