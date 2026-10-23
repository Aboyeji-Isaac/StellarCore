import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "StellarCore — Anchor Intelligence",
  description: "Read-only Stellar anchor, corridor, rate-evidence, and reputation intelligence.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Nonce-based CSP requires request-time rendering so Next.js can read the
  // middleware-provided CSP/x-nonce request headers and nonce framework output.
  await headers();

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
