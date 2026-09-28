/**
 * Minimal, dependency-free five-field cron evaluation.
 *
 * StellarCore only needs to know one thing about a cron expression: the largest
 * interval that can elapse between two consecutive dispatches. Anything this
 * module cannot prove is reported as unsupported rather than guessed, so the
 * scheduling audit fails closed instead of deploying an unproven cadence.
 *
 * Supported syntax per field: `*`, `*\/N`, literal `N`, comma lists of
 * literals, and inclusive ranges `A-B`. Day-of-month, month, and day-of-week
 * must all be `*`, because a calendar-qualified schedule is not a fixed
 * sub-daily cadence.
 */

const MINUTES_PER_DAY = 24 * 60;

export function intervalMsFromCronExpression(expression: string): number | null {
  const fields = String(expression).trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string, string, string, string, string,
  ];
  if ([dayOfMonth, month, dayOfWeek].some((field) => field.trim() !== "*")) {
    return null;
  }

  const minutes = parseField(minute, 0, 59);
  const hours = parseField(hour, 0, 23);
  if (!minutes || !hours || minutes.length === 0 || hours.length === 0) {
    return null;
  }

  const offsets = new Set<number>();
  for (const hourValue of hours) {
    for (const minuteValue of minutes) {
      offsets.add(hourValue * 60 + minuteValue);
    }
  }

  const ordered = [...offsets].sort((left, right) => left - right);
  let smallestGap = MINUTES_PER_DAY;
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    const next = index + 1 < ordered.length
      ? ordered[index + 1]!
      : ordered[0]! + MINUTES_PER_DAY;
    smallestGap = Math.min(smallestGap, next - current);
  }

  return smallestGap * 60_000;
}

function parseField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const token = part.trim();
    if (token === "") return null;

    if (token === "*") {
      for (let value = min; value <= max; value += 1) values.add(value);
      continue;
    }

    const step = /^(?:\*|(\d{1,2})-(\d{1,2}))\/(\d{1,2})$/.exec(token);
    if (step) {
      const stepSize = Number(step[3]);
      const start = step[1] === undefined ? min : Number(step[1]);
      const end = step[2] === undefined ? max : Number(step[2]);
      if (!inRange(start, min, max) || !inRange(end, min, max) || start > end) {
        return null;
      }
      if (!inRange(stepSize, 1, max - min + 1)) return null;
      for (let value = start; value <= end; value += stepSize) values.add(value);
      continue;
    }

    const range = /^(\d{1,2})-(\d{1,2})$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!inRange(start, min, max) || !inRange(end, min, max) || start > end) {
        return null;
      }
      for (let value = start; value <= end; value += 1) values.add(value);
      continue;
    }

    if (!/^\d{1,2}$/.test(token)) return null;
    const literal = Number(token);
    if (!inRange(literal, min, max)) return null;
    values.add(literal);
  }

  return values.size > 0 ? [...values].sort((left, right) => left - right) : null;
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}
