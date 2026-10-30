/**
 * Browser-smoke fixture server for the four persisted-evidence views
 * (Issue #361).
 *
 * The dashboard's evidence sections are async server components that read the
 * database directly, which makes a live database the only alternative to
 * exercising them over HTTP. Each section now exposes the same pure `*View`
 * component the dashboard renders; this server composes those exact components
 * with deterministic API fixtures and serves the dashboard shell markup over
 * HTTP.
 *
 * The server is intentionally read-only and never touches a database or an
 * external provider. Start it with `npx tsx
 * tests/e2e/support/evidenceFixtureServer.ts`; Playwright's `webServer` config
 * does this automatically.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AnchorsSectionView } from "@/components/dashboard/AnchorsSection";
import { CorridorsSectionView } from "@/components/dashboard/CorridorsSection";
import { RatePanelView } from "@/components/dashboard/RatePanel";
import { ReputationSectionView } from "@/components/dashboard/ReputationSection";
import {
  EVIDENCE_FIXTURE_STATES,
  evidenceFixtures,
  type EvidenceFixtureState,
} from "./evidenceFixtures";

const PORT = Number(process.env.E2E_FIXTURE_PORT ?? 4321);
const HOST = "127.0.0.1";

const VIEW_HEADINGS = Object.freeze({
  anchors: "Anchors",
  corridors: "Corridors",
  rates: "USDC → BRL rate",
  reputation: "Reputation",
});

function page(body: string, title: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${title}</title>`,
    "</head>",
    `<body>${body}</body>`,
    "</html>",
  ].join("");
}

function section(
  view: keyof typeof VIEW_HEADINGS,
  content: string,
): string {
  const headingId = `${view}-heading`;
  return [
    `<section data-view="${view}" aria-labelledby="${headingId}">`,
    `<h2 id="${headingId}">${VIEW_HEADINGS[view]}</h2>`,
    content,
    "</section>",
  ].join("");
}

function dashboardPage(state: EvidenceFixtureState): string {
  const fixtures = evidenceFixtures(state);
  const sections = [
    section("anchors", renderToStaticMarkup(createElement(AnchorsSectionView, {
      result: fixtures.anchors,
    }))),
    section("corridors", renderToStaticMarkup(createElement(CorridorsSectionView, {
      result: fixtures.corridors,
    }))),
    section("rates", renderToStaticMarkup(createElement(RatePanelView, {
      result: fixtures.rates,
    }))),
    section("reputation", renderToStaticMarkup(createElement(ReputationSectionView, {
      result: fixtures.reputation,
    }))),
  ].join("");

  return page(
    [
      '<header><p class="eyebrow">Public evidence console</p>',
      '<h1>Persisted signals, clearly separated.</h1></header>',
      '<main id="main-content" data-fixture-state="' + state + '">',
      sections,
      "</main>",
    ].join(""),
    "Dashboard — StellarCore",
  );
}

function navigationPage(): string {
  return page(
    [
      "<main id=\"main-content\">",
      "<h1>Evidence fixture navigation</h1>",
      "<ul>",
      ...EVIDENCE_FIXTURE_STATES.map((state) =>
        `<li><a href="/dashboard?state=${state}">Open ${state} evidence dashboard</a></li>`,
      ),
      "</ul>",
      "</main>",
    ].join(""),
    "Evidence fixture navigation — StellarCore",
  );
}

function send(response: ServerResponse, status: number, body: string, contentType = "text/html; charset=utf-8"): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function handle(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (request.method !== "GET") {
    send(response, 405, "Method Not Allowed", "text/plain; charset=utf-8");
    return;
  }

  if (url.pathname === "/health") {
    send(response, 200, "ok", "text/plain; charset=utf-8");
    return;
  }

  if (url.pathname === "/") {
    send(response, 200, navigationPage());
    return;
  }

  if (url.pathname === "/dashboard") {
    const state = url.searchParams.get("state") ?? "ready";
    if (!EVIDENCE_FIXTURE_STATES.includes(state as EvidenceFixtureState)) {
      send(
        response,
        404,
        page("<main><h1>Unknown evidence fixture</h1></main>", "Unknown evidence fixture — StellarCore"),
      );
      return;
    }
    send(response, 200, dashboardPage(state as EvidenceFixtureState));
    return;
  }

  send(response, 404, page("<main><h1>Not found</h1></main>", "Not found — StellarCore"));
}

const server = createServer(handle);

server.listen(PORT, HOST, () => {
  // Playwright waits for /health before starting the test run.
  process.stdout.write(`evidence fixture server listening on http://${HOST}:${PORT}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
