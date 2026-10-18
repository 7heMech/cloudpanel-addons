/**
 * What `{ipv4}` and `{ipv6}` are when the operator has not said: the public
 * IPv4 CloudPanel itself shows, else the one global address of each family on
 * the server's interfaces. More than one global address of a family is not a
 * guess this makes; the page asks for an override instead.
 */
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { readPanelPublicIp } from "../../lib/panel-public-ip";

function globalAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return !/^(?:0\.|10\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address);
  }
  // Global unicast is 2000::/3; that leaves out link-local, unique-local, loopback and multicast.
  return /^[23][0-9a-f]{0,3}:/i.test(address) && !/^2001:db8:/i.test(address);
}

export function detectAddresses(): { ipv4: string; ipv6: string } {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal && globalAddress(entry.address));
  const only = (family: string): string => {
    const found = [...new Set(addresses.filter((entry) => entry.family === family).map((entry) => entry.address.toLowerCase()))];
    return found.length === 1 ? found[0]! : "";
  };
  const panel = readPanelPublicIp();
  return { ipv4: isIP(panel) === 4 ? panel : only("IPv4"), ipv6: only("IPv6") };
}
