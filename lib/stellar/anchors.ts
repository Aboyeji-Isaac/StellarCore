import { TRANSFER_SEPS } from "@/constants/seps";

export function transferCapable(seps: readonly number[]): boolean {
  return seps.some((sep) =>
    TRANSFER_SEPS.some((transferSep) => transferSep === sep),
  );
}
