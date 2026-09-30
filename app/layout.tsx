import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { headers } from 'next/headers';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'StellarCore',
  description: 'Stellar blockchain core application',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = headers().get('x-nonce') || '';

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta httpEquiv="Content-Security-Policy" content={headers().get('Content-Security-Policy') || ''} />
      </head>
      <body className={inter.className}>
        {children}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
              window.__NONCE__ = '${nonce}';
            `,
          }}
        />
      </body>
    </html>
  );
}
