import { z } from 'zod';

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'preview', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const databaseSchema = z.object({
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid URL' }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  DATABASE_POOL_MIN: z.coerce.number().int().positive().default(2),
});

const securitySchema = z.object({
  CRON_SECRET: z.string().min(32, { message: 'CRON_SECRET must be at least 32 characters' }),
  SESSION_SECRET: z.string().min(32, { message: 'SESSION_SECRET must be at least 32 characters' }),
  ENABLE_RATE_LIMIT: z.coerce.boolean().default(true),
});

const stellarSchema = z.object({
  STELLAR_NETWORK: z.enum(['testnet', 'public', 'futurenet']).default('testnet'),
  STELLAR_RPC_URL: z.string().url({ message: 'STELLAR_RPC_URL must be a valid URL' }),
  STELLAR_HORIZON_URL: z.string().url({ message: 'STELLAR_HORIZON_URL must be a valid URL' }).optional(),
});

const featureFlagsSchema = z.object({
  ENABLE_ANALYTICS: z.coerce.boolean().default(false),
  ENABLE_EXPERIMENTAL_API: z.coerce.boolean().default(false),
});

export const fullSchema = baseSchema
  .and(databaseSchema)
  .and(securitySchema)
  .and(stellarSchema)
  .and(featureFlagsSchema);

export type RuntimeConfig = z.infer<typeof fullSchema>;

export const environmentSpecificSchemas = {
  development: baseSchema.and(databaseSchema).and(stellarSchema),
  test: baseSchema.and(databaseSchema).and(stellarSchema),
  preview: fullSchema,
  production: fullSchema,
};

export function getSchemaForEnvironment(env: string): z.ZodSchema<RuntimeConfig> {
  const schema = environmentSpecificSchemas[env as keyof typeof environmentSpecificSchemas];
  if (!schema) {
    throw new Error(`Unknown environment: ${env}`);
  }
  return schema;
}
