import { fullSchema, RuntimeConfig, getSchemaForEnvironment } from './schema';
import { z } from 'zod';

let validatedConfig: RuntimeConfig | null = null;
let validationErrors: z.ZodIssue[] | null = null;

export function validateConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  if (validatedConfig) {
    return validatedConfig;
  }

  const schema = getSchemaForEnvironment(env.NODE_ENV || 'development');
  const result = schema.safeParse(env);

  if (!result.success) {
    validationErrors = result.error.errors;
    const safeErrors = result.error.errors.map(err => {
      const path = err.path.join('.');
      if (err.code === z.ZodIssueCode.invalid_type) {
        return `${path} must be a ${err.expected}`;
      }
      if (err.code === z.ZodIssueCode.invalid_enum_value) {
        return `${path} must be one of: ${err.options.join(', ')}`;
      }
      if (err.code === z.ZodIssueCode.too_small) {
        return `${path} must be at least ${err.minimum} characters`;
      }
      if (err.code === z.ZodIssueCode.invalid_string) {
        if (err.validation === 'url') {
          return `${path} must be a valid URL`;
        }
      }
      return `${path} is invalid: ${err.message}`;
    });

    throw new Error(`Configuration validation failed:\n${safeErrors.join('\n')}`);
  }

  validatedConfig = result.data;
  return validatedConfig;
}

export function getConfig(): RuntimeConfig {
  if (!validatedConfig) {
    throw new Error('Configuration not validated. Call validateConfig() first.');
  }
  return validatedConfig;
}

export function resetConfig(): void {
  validatedConfig = null;
  validationErrors = null;
}

export function getValidationErrors(): z.ZodIssue[] | null {
  return validationErrors;
}

export function createTestConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const base: RuntimeConfig = {
    NODE_ENV: 'test',
    PORT: 3000,
    LOG_LEVEL: 'debug',
    DATABASE_URL: 'postgresql://localhost:5432/test',
    DATABASE_POOL_MAX: 10,
    DATABASE_POOL_MIN: 1,
    CRON_SECRET: 'test_cron_secret_123456789012345678901234',
    SESSION_SECRET: 'test_session_secret_1234567890123456789012',
    ENABLE_RATE_LIMIT: false,
    STELLAR_NETWORK: 'testnet',
    STELLAR_RPC_URL: 'https://rpc-testnet.stellar.org',
    ENABLE_ANALYTICS: false,
    ENABLE_EXPERIMENTAL_API: false,
  };

  return { ...base, ...overrides };
}

export { RuntimeConfig };
