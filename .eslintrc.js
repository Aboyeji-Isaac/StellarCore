module.exports = {
  // ... existing configuration ...
  plugins: ['prisma-raw'],
  rules: {
    // ... other rules ...
    'prisma-raw/no-unsafe-prisma-raw': 'error',
  },
};
