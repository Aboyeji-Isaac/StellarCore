import express from 'express';
import { validateConfig, getConfig } from './config';

// Validate configuration at startup
try {
  validateConfig();
  const config = getConfig();

  // Only log non-sensitive config for debugging
  console.log(`Starting StellarCore in ${config.NODE_ENV} mode on port ${config.PORT}`);
  console.log(`Log level: ${config.LOG_LEVEL}`);
  console.log(`Stellar network: ${config.STELLAR_NETWORK}`);

  const app = express();
  const port = config.PORT;

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });

  export default app;
} catch (error) {
  console.error('Configuration error:', (error as Error).message);
  process.exit(1);
}
