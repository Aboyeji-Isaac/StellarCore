/**
 * One structured log format for the scheduled/CLI jobs. Every line is a single
 * JSON object with the same five keys plus job-specific fields, so production
 * output stays greppable and machine-parseable without any logging dependency.
 *
 * `formatLogLine` is pure and `createStructuredLogger` accepts injected `now`
 * and `write` functions, which keeps the format testable without touching the
 * process streams.
 */

export type LogLevel = "info" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

export type StructuredLogger = Readonly<{
  info: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
}>;

export type LogEntry = Readonly<{
  timestamp: Date;
  level: LogLevel;
  script: string;
  message: string;
  fields: LogFields;
}>;

export type StructuredLoggerOptions = Readonly<{
  now?: () => Date;
  write?: (level: LogLevel, line: string) => void;
}>;

export function formatLogLine(entry: LogEntry): string {
  return JSON.stringify({
    timestamp: entry.timestamp.toISOString(),
    level: entry.level,
    script: entry.script,
    message: entry.message,
    ...entry.fields,
  });
}

export function createStructuredLogger(
  script: string,
  options: StructuredLoggerOptions = {},
): StructuredLogger {
  const now = options.now ?? (() => new Date());
  const write = options.write ?? writeToProcessStream;

  const emit = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    write(level, formatLogLine({
      timestamp: now(),
      level,
      script,
      message,
      fields: Object.freeze({ ...fields }),
    }));
  };

  return Object.freeze({
    info: (message, fields) => emit("info", message, fields),
    error: (message, fields) => emit("error", message, fields),
  });
}

function writeToProcessStream(level: LogLevel, line: string): void {
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}
