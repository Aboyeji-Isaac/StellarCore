import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StellarCore — Anchor Intelligence",
  description: "Compare live Stellar anchor rates, reputation, and corridors.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
