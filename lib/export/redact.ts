const SECRET_PATTERNS = [
  /^password$/i,
  /^secret$/i,
  /^token$/i,
  /^key$/i,
  /^credential$/i,
  /^auth$/i,
  /^private$/i,
  /^api[_-]?key$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^client[_-]?secret$/i,
  /^database[_-]?url$/i,
  /^connection[_-]?string$/i,
  /^dsn$/i,
  /^pgpassword$/i,
  /^mysql[_-]?pwd$/i,
  /^redis[_-]?password$/i,
  /^jwt$/i,
  /^bearer$/i,
  /^authorization$/i,
  /^cookie$/i,
  /^session$/i,
  /^csrf$/i,
  /^hmac$/i,
  /^signature$/i,
  /^signing[_-]?key$/i,
  /^encryption[_-]?key$/i,
  /^master[_-]?key$/i,
  /^root[_-]?password$/i,
  /^admin[_-]?password$/i,
  /_password$/i,
  /_secret$/i,
  /_token$/i,
  /_key$/i,
] as const;

const SECRET_VALUE_PATTERNS = [
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
  /^sk_(live|test)_[A-Za-z0-9]{24,}$/,
  /^pk_(live|test)_[A-Za-z0-9]{24,}$/,
  /^rk_[A-Za-z0-9]{24,}$/,
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  /^[A-Fa-f0-9]{64}$/,
  /^[A-Fa-f0-9]{32}$/,
  /^postgres(?:ql)?:\/\/[^\s]+$/,
  /^mysql:\/\/[^\s]+$/,
  /^redis:\/\/[^\s]+$/,
  /^mongodb:\/\/[^\s]+$/,
] as const;

export function isSecretKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SECRET_PATTERNS.some((pattern) => pattern.test(lowerKey));
}

export function isSecretValue(value: string): boolean {
  if (value.length < 16) {
    return false;
  }
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function redactValue(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    if (isSecretKey(key) || isSecretValue(value)) {
      return "[REDACTED]";
    }
    return value;
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => redactValue(`${key}[${i}]`, v));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = redactValue(`${key}.${k}`, v);
    }
    return result;
  }
  return value;
}

export function sanitizeForExport<T>(data: T): T {
  return redactValue("root", data) as T;
}

export function assertNoSecrets(data: unknown, path = "root"): void {
  if (typeof data === "string") {
    if (isSecretValue(data)) {
      throw new Error(`Potential secret detected at ${path}: ${data.slice(0, 8)}...`);
    }
    return;
  }
  if (data === null || data === undefined) {
    return;
  }
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      assertNoSecrets(data[i], `${path}[${i}]`);
    }
    return;
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (isSecretKey(key)) {
        throw new Error(`Secret key detected at ${path}.${key}`);
      }
      assertNoSecrets(value, `${path}.${key}`);
    }
    return;
  }
}