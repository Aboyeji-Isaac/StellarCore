"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type CspNonceContextValue = {
  nonce: string | null;
};

const CspNonceContext = createContext<CspNonceContextValue>({ nonce: null });

export function CspNonceProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [nonce, setNonce] = useState<string | null>(null);

  useEffect(() => {
    const cookieValue = document.cookie
      .split("; ")
      .find((row) => row.startsWith("csp-nonce="))
      ?.split("=")[1];

    if (cookieValue) {
      setNonce(decodeURIComponent(cookieValue));
    }
  }, []);

  return (
    <CspNonceContext.Provider value={{ nonce }}>
      {children}
    </CspNonceContext.Provider>
  );
}

export function useCspNonce(): string | null {
  const { nonce } = useContext(CspNonceContext);
  return nonce;
}

export function NonceScript({ children, ...props }: Readonly<{ children: string } & React.ScriptHTMLAttributes<HTMLScriptElement>>) {
  const nonce = useCspNonce();
  return <script nonce={nonce ?? undefined} {...props}>{children}</script>;
}

export function NonceStyle({ children, ...props }: Readonly<{ children: string } & React.StyleHTMLAttributes<HTMLStyleElement>>) {
  const nonce = useCspNonce();
  return <style nonce={nonce ?? undefined} {...props}>{children}</style>;
}