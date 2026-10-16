import { Database } from "bun:sqlite";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { validateDomain } from "./app-http";
import { readPanelPublicIp } from "./panel-public-ip";

export interface ProvisioningSite {
  id: number; domain: string; type: string; placeholder: boolean;
  certificateReady: boolean; certificateNames: string[]; cloudflareOnly: boolean;
}
export function provisioningSites(path: string): ProvisioningSite[] {
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(site)").all().map((c) => c.name));
    const certCols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(certificate)").all().map((c) => c.name));
    const cert = cols.has("certificate_id") && certCols.has("type");
    const rows = db.query<{ id: number; domain_name: string; type: string; certificate_type: string | null; pem: string | null; expires_at: string | null; cf_only: number }, []>(
      `SELECT s.id, s.domain_name, s.type, ${cols.has("allow_traffic_from_cloudflare_only") ? "s.allow_traffic_from_cloudflare_only" : "0"} AS cf_only,
       ${cert ? "c.type" : "NULL"} AS certificate_type, ${cert && certCols.has("certificate") ? "c.certificate" : "NULL"} AS pem,
       ${cert && certCols.has("expires_at") ? "c.expires_at" : "NULL"} AS expires_at
       FROM site s ${cert ? "LEFT JOIN certificate c ON c.id = s.certificate_id" : ""} ORDER BY s.domain_name`,
    ).all();
    return rows.map((r) => {
      const domain = validateDomain(r.domain_name);
      if (!domain || !Number.isSafeInteger(r.id) || r.id < 1) throw new Error("CloudPanel returned an invalid site");
      const placeholder = String(r.certificate_type) === "1";
      let certificateReady = false, certificateNames: string[] = [];
      if (!placeholder && r.pem) {
        try {
          const cert = new X509Certificate(r.pem);
          certificateReady = Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now() && Boolean(cert.checkHost(domain));
          certificateNames = (cert.subjectAltName ?? "").split(", ").filter((s) => s.startsWith("DNS:")).map((s) => s.slice(4).toLowerCase());
          if (!certificateNames.length && cert.checkHost(domain)) certificateNames = [domain];
        } catch {}
      }
      return { id: r.id, domain, type: String(r.type), placeholder, certificateReady, certificateNames, cloudflareOnly: Boolean(r.cf_only) };
    });
  } finally { db.close(); }
}
function publicAddress(ip: string): boolean {
  if (isIP(ip) === 6) return !/^(?:fe[89ab]|f[cd]|::|ff)/i.test(ip);
  return !/^(?:127\.|10\.|169\.254\.|192\.168\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(ip);
}
export function detectedServerIps(): { ipv4: string; ipv6: string } {
  const addresses = Object.values(networkInterfaces()).flatMap((v) => v ?? []).filter((a) => !a.internal && publicAddress(a.address));
  const one = (family: string) => {
    const found = [...new Set(addresses.filter((a) => a.family === family).map((a) => a.address))];
    return found.length === 1 ? found[0]! : "";
  };
  const cached = readPanelPublicIp();
  return { ipv4: cached && isIP(cached) === 4 ? cached : one("IPv4"), ipv6: one("IPv6") };
}
