export type UrlValidationResult =
  | Readonly<{ ok: true; url: string }>
  | Readonly<{ ok: false; error: string }>;

export function validateWebhookDestinationUrl(
  input: string,
  options: Readonly<{ allowHttp?: boolean }> = {},
): UrlValidationResult {
  if (typeof input !== "string" || input.trim() === "") {
    return Object.freeze({ ok: false, error: "URL cannot be empty." });
  }

  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return Object.freeze({ ok: false, error: "Invalid URL format." });
  }

  const isProduction = process.env.NODE_ENV === "production";
  const allowHttp = options.allowHttp ?? !isProduction;

  if (parsed.protocol !== "https:" && (parsed.protocol !== "http:" || !allowHttp)) {
    return Object.freeze({
      ok: false,
      error: "Webhook destination URL must use HTTPS.",
    });
  }

  if (parsed.username || parsed.password) {
    return Object.freeze({
      ok: false,
      error: "URL must not contain embedded user credentials.",
    });
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known special local/private suffixes
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan")
  ) {
    return Object.freeze({
      ok: false,
      error: "Destination points to a local or internal network.",
    });
  }

  // Check IPv4 addresses
  if (isIpv4Address(hostname)) {
    if (isPrivateIpv4(hostname)) {
      return Object.freeze({
        ok: false,
        error: "Destination points to a private or loopback IP range.",
      });
    }
  }

  // Check IPv6 addresses
  const ipv6 = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  if (isIpv6Address(ipv6)) {
    if (isPrivateIpv6(ipv6)) {
      return Object.freeze({
        ok: false,
        error: "Destination points to a private or loopback IPv6 range.",
      });
    }
  }

  return Object.freeze({ ok: true, url: parsed.toString() });
}

function isIpv4Address(host: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // invalid IP treated as unsafe
  }

  const [a, b] = parts as [number, number, number, number];

  // 0.0.0.0/8
  if (a === 0) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 10.0.0.0/8 (Private)
  if (a === 10) return true;
  // 172.16.0.0/12 (Private: 172.16 - 172.31)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (Private)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (Link-local / AWS/GCP metadata)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 (Carrier NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
  if (a >= 224) return true;

  return false;
}

function isIpv6Address(host: string): boolean {
  return host.includes(":");
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  // Loopback ::1, Unspecified ::
  if (normalized === "::1" || normalized === "::") return true;
  // Unique local fc00::/7 (fc.. or fd..)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  // Link-local fe80::/10
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  // IPv4-mapped IPv6 e.g. ::ffff:127.0.0.1
  if (normalized.startsWith("::ffff:")) {
    const v4 = normalized.slice(7);
    if (isIpv4Address(v4)) return isPrivateIpv4(v4);
  }

  return false;
}
