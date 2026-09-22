import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StellarCore — Anchor Intelligence",
  description: "Read-only Stellar anchor, corridor, rate-evidence, and reputation intelligence.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
