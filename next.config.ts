import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Required for CSP nonce support in Next.js
    serverComponentsExternalPackages: [],
  },
  // Enable CSP reporting in production
  headers: async () => {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy-Report-Only',
            value: "default-src 'self'; report-uri https://stellarcore.example.com/csp-report-endpoint",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
