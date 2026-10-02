import { Resolver } from "node:dns/promises";
import https from "node:https";
import { Readable } from "node:stream";

import ipaddr from "ipaddr.js";

const DEFAULT_DNS_TIMEOUT_MS = 2_000;
const ALLOWED_RANGES = new Set(["unicast"]);
const DISALLOWED_IPV6_PREFIXES = Object.freeze([
  ipaddr.parseCIDR("64:ff9b::/96"),
  ipaddr.parseCIDR("64:ff9b:1::/48"),
  ipaddr.parseCIDR("100::/64"),
  ipaddr.parseCIDR("2001::/32"),
  ipaddr.parseCIDR("2001:2::/48"),
  ipaddr.parseCIDR("2001:db8::/32"),
  ipaddr.parseCIDR("2002::/16"),
]);

export type EgressPolicyErrorCode =
  | "DNS_FAILURE"
  | "DNS_TIMEOUT"
  | "NO_ADDRESSES"
  | "DISALLOWED_ADDRESS"
  | "MIXED_ADDRESSES"
  | "UNSUPPORTED_RUNTIME";

export class EgressPolicyError extends Error {
  readonly code: EgressPolicyErrorCode;
  readonly hostname: string;

  constructor(code: EgressPolicyErrorCode, hostname: string) {
    super(`Outbound egress policy rejected host (${code})`);
    this.name = "EgressPolicyError";
    this.code = code;
    this.hostname = hostname;
  }
}

export type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;
export type EgressResolver = (
  hostname: string,
  timeoutMs: number,
) => Promise<readonly ResolvedAddress[]>;

export type EgressSecurityLogger = (
  decision: Readonly<{
    event: "outbound_egress_policy";
    hostname: string;
    decision: "allow" | "deny";
    reason: EgressPolicyErrorCode | "PUBLIC_ADDRESSES";
    addressCount: number;
  }>,
) => void;

export type PinnedHttpsRequest = (
  url: URL,
  init: RequestInit,
  address: ResolvedAddress,
) => Promise<Response>;

export type EgressFetchOptions = Readonly<{
  resolver?: EgressResolver;
  request?: PinnedHttpsRequest;
  dnsTimeoutMs?: number;
  logger?: EgressSecurityLogger;
}>;

/**
 * Creates a fetch-compatible HTTPS transport that validates every A/AAAA
 * answer and pins one validated address into the socket lookup callback.
 */
export function createEgressFetch(options: EgressFetchOptions = {}): typeof fetch {
  const resolver = options.resolver ?? resolveAddresses;
  const request = options.request ?? pinnedHttpsRequest;
  const dnsTimeoutMs = options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;
  const logger = options.logger ?? defaultSecurityLogger;

  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.href : input,
    );

    if (url.protocol !== "https:") {
      throw new EgressPolicyError("UNSUPPORTED_RUNTIME", url.hostname);
    }

    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await resolver(url.hostname, dnsTimeoutMs);
    } catch (cause) {
      const error =
        cause instanceof EgressPolicyError
          ? cause
          : new EgressPolicyError("DNS_FAILURE", url.hostname);
      logDecision(logger, url.hostname, "deny", error.code, 0);
      throw error;
    }

    let approved: readonly ResolvedAddress[];
    try {
      approved = approveResolvedAddresses(url.hostname, addresses);
    } catch (cause) {
      const error =
        cause instanceof EgressPolicyError
          ? cause
          : new EgressPolicyError("DISALLOWED_ADDRESS", url.hostname);
      logDecision(logger, url.hostname, "deny", error.code, addresses.length);
      throw error;
    }
    logDecision(logger, url.hostname, "allow", "PUBLIC_ADDRESSES", approved.length);
    return request(url, init, approved[0]);
  }) as typeof fetch;
}

export function approveResolvedAddresses(
  hostname: string,
  answers: readonly ResolvedAddress[],
): readonly ResolvedAddress[] {
  if (answers.length === 0) {
    throw new EgressPolicyError("NO_ADDRESSES", hostname);
  }

  const unique = new Map<string, ResolvedAddress>();

  for (const answer of answers) {
    const normalized = normalizeAddress(answer, hostname);
    unique.set(`${normalized.family}:${normalized.address}`, normalized);
  }

  const disallowed = [...unique.values()].filter(
    (answer) => !isPublicAddress(answer.address),
  ).length;

  if (disallowed > 0 && disallowed < unique.size) {
    throw new EgressPolicyError("MIXED_ADDRESSES", hostname);
  }
  if (disallowed > 0) {
    throw new EgressPolicyError("DISALLOWED_ADDRESS", hostname);
  }

  return Object.freeze([...unique.values()]);
}

export function isPublicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6") {
      const ipv6 = parsed as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address();
      else if (
        DISALLOWED_IPV6_PREFIXES.some(([network, prefix]: unknown[]) =>
          ipv6.match(network as ipaddr.IPv6, prefix as number),
        )
      ) {
        return false;
      }
    }
    return ALLOWED_RANGES.has(parsed.range());
  } catch {
    return false;
  }
}

export async function resolveAddresses(
  hostname: string,
  timeoutMs = DEFAULT_DNS_TIMEOUT_MS,
): Promise<readonly ResolvedAddress[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new EgressPolicyError("DNS_TIMEOUT", hostname);
  }

  const resolver = new Resolver();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    resolver.cancel();
  }, timeoutMs);

  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    if (timedOut) throw new EgressPolicyError("DNS_TIMEOUT", hostname);

    const addresses: ResolvedAddress[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        for (const address of result.value) {
          addresses.push({ address, family: index === 0 ? 4 : 6 });
        }
      }
    }
    if (addresses.length === 0) {
      throw new EgressPolicyError("DNS_FAILURE", hostname);
    }
    return Object.freeze(addresses);
  } finally {
    clearTimeout(timer);
  }
}

export async function pinnedHttpsRequest(
  url: URL,
  init: RequestInit,
  pinned: ResolvedAddress,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request = https.request(
      url,
      {
        method: init.method ?? "GET",
        headers,
        signal: init.signal ?? undefined,
        servername: url.hostname,
        lookup: (_hostname, lookupOptions, callback) => {
          const all = typeof lookupOptions === "object" && lookupOptions.all;
          if (all) {
            callback(null, [pinned]);
          } else {
            callback(null, pinned.address, pinned.family);
          }
        },
      },
      (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        resolve(
          new Response(Readable.toWeb(incoming) as ReadableStream, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }),
        );
      },
    );

    request.once("error", reject);
    if (init.body === undefined || init.body === null) {
      request.end();
    } else if (typeof init.body === "string" || init.body instanceof Uint8Array) {
      request.end(init.body);
    } else {
      request.destroy(new TypeError("Streaming request bodies are not supported"));
    }
  });
}

function normalizeAddress(answer: ResolvedAddress, hostname: string): ResolvedAddress {
  try {
    const parsed = ipaddr.parse(answer.address);
    const family = parsed.kind() === "ipv4" ? 4 : 6;
    if (answer.family !== family) throw new Error("family mismatch");
    return Object.freeze({ address: parsed.toNormalizedString(), family });
  } catch {
    throw new EgressPolicyError("DISALLOWED_ADDRESS", hostname);
  }
}

function logDecision(
  logger: EgressSecurityLogger,
  hostname: string,
  decision: "allow" | "deny",
  reason: EgressPolicyErrorCode | "PUBLIC_ADDRESSES",
  addressCount: number,
): void {
  logger(Object.freeze({
    event: "outbound_egress_policy",
    hostname: hostname.slice(0, 253),
    decision,
    reason,
    addressCount,
  }));
}

function defaultSecurityLogger(decision: Parameters<EgressSecurityLogger>[0]): void {
  console.info(JSON.stringify(decision));
}
