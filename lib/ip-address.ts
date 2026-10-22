import { isIP } from "node:net";

export function normalizeMappedIpv4(address: string): string {
  if (isIP(address) !== 6) return address;
  let host: string;
  try {
    host = new URL(`http://[${address}]/`).hostname;
  } catch {
    return address;
  }
  const mapped = /^\[::ffff:([0-9a-f]+):([0-9a-f]+)\]$/.exec(host);
  if (!mapped) return address;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}
