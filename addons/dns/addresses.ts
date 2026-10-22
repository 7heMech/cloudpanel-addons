/**
 * What `{ipv4}` and `{ipv6}` are when the operator has not said: the public
 * IPv4 CloudPanel itself shows, else the one global address of each family on
 * the server's interfaces. More than one global address of a family is not a
 * guess this makes; the page asks for an override instead.
 *
 * An address that cannot be told is null, and stops the sites that use it.
 * Empty means the server has none of that family, so its records are removed;
 * an IPv4 is never taken to be missing, because a server behind NAT has no
 * public IPv4 on any interface once CloudPanel's cached one expires.
 */
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { readPanelPublicIp } from "../../lib/panel-public-ip";

export interface Addresses {
  ipv4: string | null;
  ipv6: string | null;
}

function globalAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return !/^(?:0\.|10\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address);
  }
  // Global unicast is 2000::/3; that leaves out link-local, unique-local, loopback and multicast.
  return /^[23][0-9a-f]{0,3}:/i.test(address) && !/^2001:db8:/i.test(address);
}

type Interfaces = NodeJS.Dict<{ address: string; family: string; internal: boolean }[]>;

export function detectAddresses(interfaces: Interfaces = networkInterfaces(), panel = readPanelPublicIp()): Addresses {
  const addresses = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && globalAddress(entry.address));
  const found = (family: string): string[] =>
    [...new Set(addresses.filter((entry) => entry.family === family).map((entry) => entry.address.toLowerCase()))];
  const ipv4 = found("IPv4");
  const ipv6 = found("IPv6");
  return {
    ipv4: isIP(panel) === 4 ? panel : ipv4.length === 1 ? ipv4[0]! : null,
    ipv6: ipv6.length > 1 ? null : ipv6[0] ?? "",
  };
}
