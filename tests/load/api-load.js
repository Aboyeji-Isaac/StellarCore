// k6 load test for the public read-only API (#63).
//
// Runs a realistic traffic mix against the four public GET surfaces at a
// fixed concurrency, so separate runs at increasing VU counts locate the
// degradation point. Invocation (any k6; the Docker image needs no install):
//
//   docker run --rm -i --add-host=host.docker.internal:host-gateway \
//     -e BASE_URL=http://host.docker.internal:3000 -e VUS=15 \
//     grafana/k6 run - < tests/load/api-load.js
//
// BASE_URL must point at a production build (`npm run build && npm start`)
// backed by a seeded database — never at the live production deployment
// without explicit maintainer confirmation (see docs/load-testing.md).

import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || "45s";

// Force per-endpoint submetrics into the end-of-test summary. The bounds are
// deliberately loose — the test's job is to measure, not to gate CI.
export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{name:rates}": ["p(95)<60000"],
    "http_req_duration{name:reputation-list}": ["p(95)<60000"],
    "http_req_duration{name:reputation-detail}": ["p(95)<60000"],
    "http_req_duration{name:anchors}": ["p(95)<60000"],
    "http_req_duration{name:corridors}": ["p(95)<60000"],
  },
};

// Slugs from the seeded dataset (see docs/load-testing.md).
const CORRIDORS = [1, 2, 3, 4].map((i) => `usdc-us-ngnc-ng-${i}`);
const ANCHORS = Array.from({ length: 24 }, (_, i) => `anchor-${i + 1}`);

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export default function () {
  // Weighted mix: the rate comparison is the product's hot path.
  const r = Math.random();
  let res;
  if (r < 0.4) {
    res = http.get(`${BASE}/api/rates?corridor=${pick(CORRIDORS)}`, {
      tags: { name: "rates" },
    });
  } else if (r < 0.6) {
    res = http.get(`${BASE}/api/reputation`, {
      tags: { name: "reputation-list" },
    });
  } else if (r < 0.75) {
    res = http.get(`${BASE}/api/reputation/${pick(ANCHORS)}`, {
      tags: { name: "reputation-detail" },
    });
  } else if (r < 0.9) {
    res = http.get(`${BASE}/api/anchors`, { tags: { name: "anchors" } });
  } else {
    res = http.get(`${BASE}/api/corridors`, { tags: { name: "corridors" } });
  }

  check(res, { "status 200": (x) => x.status === 200 });

  // A human between page interactions, not a hot loop: makes VU count
  // approximate concurrent users rather than raw request floods.
  sleep(Math.random() * 2 + 0.5);
}
