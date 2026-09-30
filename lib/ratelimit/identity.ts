export type ClientIdentity = Readonly<{
  kind: "ip4" | "ip6" | "unknown";
  value: string;
}>;

export const UNKNOWN_IDENTITY: ClientIdentity = Object.freeze({
  kind: "unknown",
  value: "",
});

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_SOURCE = `${OCTET}(?:\\.${OCTET}){3}`;
const IPV4 = new RegExp(`^${IPV4_SOURCE}$`);
const IPV4_MAPPED = new RegExp(`^::ffff:(${IPV4_SOURCE})$`, "i");
const MAX_HEADER_LENGTH = 256;

/**
 * Resolves the client from ONE platform-controlled header only. Anything
 * missing or malformed maps to a single shared "unknown" identity, so
 * spoofed values can never mint new budgets. The last list entry is used
 * because it is the one appended by the nearest trusted proxy.
 */
export function resolveClientIdentity(
  headers: Headers,
  trustedHeader: string,
): ClientIdentity {
  const raw = headers.get(trustedHeader);
  if (!raw || raw.length > MAX_HEADER_LENGTH) return UNKNOWN_IDENTITY;

  const entries = raw.split(",");
  const candidate = entries[entries.length - 1]?.trim() ?? "";

  if (IPV4.test(candidate)) {
    return Object.freeze({ kind: "ip4", value: candidate });
  }
  const mapped = IPV4_MAPPED.exec(candidate);
  if (mapped?.[1]) return Object.freeze({ kind: "ip4", value: mapped[1] });

  const prefix = ipv6Prefix64(candidate);
  if (prefix) return Object.freeze({ kind: "ip6", value: prefix });

  return UNKNOWN_IDENTITY;
}

function ipv6Prefix64(value: string): string | null {
  if (!/^[0-9a-f:]+$/i.test(value)) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 7) return null;

  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))
  ) {
    return null;
  }

  return groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().padStart(4, "0"))
    .join(":");
}

/** Keyed, truncated hash: minimally identifying and not reversible to an IP. */
export async function deriveIdentityKey(
  identity: ClientIdentity,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${identity.kind}:${identity.value}`),
  );
  return Array.from(new Uint8Array(signature).slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
