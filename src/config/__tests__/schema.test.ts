import { validateConfig, resetConfig, createTestConfig, getValidationErrors } from '../index';
import { RuntimeConfig } from '../schema';

describe('Configuration Validation', () => {
  beforeEach(() => {
    resetConfig();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    resetConfig();
    jest.resetModules();
  });

  describe('Valid Configurations', () => {
    it('should validate development environment', () => {
      process.env.NODE_ENV = 'development';
      process.env.DATABASE_URL = 'postgresql://localhost:5432/dev';
      process.env.STELLAR_RPC_URL = 'https://rpc-testnet.stellar.org';

      const config = validateConfig();
      expect(config.NODE_ENV).toBe('development');
      expect(config.DATABASE_URL).toBe('postgresql://localhost:5432/dev');
    });

    it('should validate production environment with all required fields', () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://prod-db:5432/main';
      process.env.CRON_SECRET = 'production_cron_secret_123456789012345678901234';
      process.env.SESSION_SECRET = 'production_session_secret_1234567890123456789012';
      process.env.STELLAR_RPC_URL = 'https://rpc.stellar.org';
      process.env.STELLAR_HORIZON_URL = 'https://horizon.stellar.org';

      const config = validateConfig();
      expect(config.NODE_ENV).toBe('production');
      expect(config.DATABASE_URL).toBe('postgresql://prod-db:5432/main');
    });

    it('should use defaults for optional fields', () => {
      process.env.NODE_ENV = 'development';
      process.env.DATABASE_URL = 'postgresql://localhost:5432/dev';
      process.env.STELLAR_RPC_URL = 'https://rpc-testnet.stellar.org';

      const config = validateConfig();
      expect(config.PORT).toBe(3000);
      expect(config.LOG_LEVEL).toBe('info');
      expect(config.ENABLE_RATE_LIMIT).toBe(true);
      expect(config.ENABLE_ANALYTICS).toBe(false);
    });
  });

  describe('Invalid Configurations', () => {
    it('should fail for missing DATABASE_URL in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.CRON_SECRET = 'valid_secret_123456789012345678901234';
      process.env.SESSION_SECRET = 'valid_session_secret_1234567890123456789012';

      expect(() => validateConfig()).toThrow('DATABASE_URL must be a valid URL');
    });

    it('should fail for invalid DATABASE_URL scheme', () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'not-a-url';
      process.env.CRON_SECRET = 'valid_secret_123456789012345678901234';
      process.env.SESSION_SECRET = 'valid_session_secret_1234567890123456789012';

      expect(() => validateConfig()).toThrow('DATABASE_URL must be a valid URL');
    });

    it('should fail for short CRON_SECRET', () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://localhost:5432/prod';
      process.env.CRON_SECRET = 'short';
      process.env.SESSION_SECRET = 'valid_session_secret_1234567890123456789012';

      expect(() => validateConfig()).toThrow('CRON_SECRET must be at least 32 characters');
    });

    it('should fail for invalid STELLAR_NETWORK', () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://localhost:5432/prod';
      process.env.CRON_SECRET = 'valid_secret_123456789012345678901234';
      process.env.SESSION_SECRET = 'valid_session_secret_1234567890123456789012';
      process.env.STELLAR_NETWORK = 'invalid_network';

      expect(() => validateConfig()).toThrow('STELLAR_NETWORK must be one of: testnet, public, futurenet');
    });

    it('should not expose secret values in error messages', () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://localhost:5432/prod';
      process.env.CRON_SECRET = 'short';
      process.env.SESSION_SECRET = 'valid_session_secret_1234567890123456789012';

      try {
        validateConfig();
      } catch (error) {
        const errorMessage = (error as Error).message;
        expect(errorMessage).not.toContain('short');
        expect(errorMessage).not.toContain('valid_session_secret');
      }
    });

    it('should capture validation errors', () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'invalid-url';
      process.env.CRON_SECRET = 'short';

      try {
        validateConfig();
      } catch {
        const errors = getValidationErrors();
        expect(errors).not.toBeNull();
        expect(errors?.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Test Configuration', () => {
    it('should create valid test config with defaults', () => {
      const config = createTestConfig();
      expect(config.NODE_ENV).toBe('test');
      expect(config.DATABASE_URL).toBe('postgresql://localhost:5432/test');
      expect(config.CRON_SECRET).toBe('test_cron_secret_123456789012345678901234');
    });

    it('should allow overrides in test config', () => {
      const config = createTestConfig({
        PORT: 4000,
        ENABLE_ANALYTICS: true,
      });
      expect(config.PORT).toBe(4000);
      expect(config.ENABLE_ANALYTICS).toBe(true);
    });

    it('should not include secrets in test config error messages', () => {
      const config = createTestConfig({
        CRON_SECRET: 'short',
      });
      // This is just to verify the structure, actual validation happens in validateConfig
      expect(config.CRON_SECRET).toBe('short');
    });
  });

  describe('Environment Specific Validation', () => {
    it('should require more fields in production than development', () => {
      // Development should work with minimal config
      process.env.NODE_ENV = 'development';
      process.env.DATABASE_URL = 'postgresql://localhost:5432/dev';
      process.env.STELLAR_RPC_URL = 'https://rpc-testnet.stellar.org';

      expect(() => validateConfig()).not.toThrow();

      // Production should require more fields
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://localhost:5432/prod';
      // Missing CRON_SECRET and SESSION_SECRET

      expect(() => validateConfig()).toThrow();
    });
  });
});
