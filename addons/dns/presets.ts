/**
 * Rows a profile can start from. A preset only fills the editor: once saved,
 * the rows are the profile's own and nothing here changes them.
 */
import type { Policy, Profile, RecordTemplate, ZoneOptions } from "./model";
import { EMPTY_MAILCOW } from "./model";

type Row = Partial<RecordTemplate> & Pick<RecordTemplate, "type" | "name" | "content">;

function row(fields: Row): RecordTemplate {
  return { proxied: false, ttl: 1, priority: null, apexOnly: false, ...fields };
}

export interface Preset {
  id: string;
  label: string;
  records: RecordTemplate[];
  /** Turned on with the rows, because the rows need it. */
  mailcow?: boolean;
  zone?: Partial<ZoneOptions>;
}

export const PRESETS: Preset[] = [
  {
    id: "web",
    label: "Web (CloudPanel)",
    records: [
      row({ type: "A", name: "{domain}", content: "{ipv4}", proxied: true }),
      row({ type: "AAAA", name: "{domain}", content: "{ipv6}", proxied: true }),
      row({ type: "A", name: "www.{domain}", content: "{ipv4}", proxied: true, apexOnly: true }),
      row({ type: "AAAA", name: "www.{domain}", content: "{ipv6}", proxied: true, apexOnly: true }),
    ],
    zone: { ssl: "strict", alwaysHttps: true, acmeFullSsl: true },
  },
  {
    id: "mailcow",
    label: "Mailcow",
    records: [
      row({ type: "MX", name: "{domain}", content: "{mailcow.host}", priority: 10 }),
      row({ type: "TXT", name: "{domain}", content: "v=spf1 mx ~all" }),
      row({ type: "TXT", name: "{mailcow.selector}._domainkey.{domain}", content: "{mailcow.dkim}" }),
      row({ type: "CNAME", name: "autoconfig.{domain}", content: "{mailcow.host}" }),
      row({ type: "CNAME", name: "autodiscover.{domain}", content: "{mailcow.host}" }),
      row({ type: "SRV", name: "_autodiscover._tcp.{domain}", content: "0 443 {mailcow.host}", priority: 0 }),
      row({ type: "CNAME", name: "webmail.{domain}", content: "{mailcow.host}", proxied: true, apexOnly: true }),
    ],
    mailcow: true,
    zone: { webmailFullSsl: true },
  },
  {
    id: "google",
    label: "Google Workspace",
    records: [
      row({ type: "MX", name: "{domain}", content: "smtp.google.com", priority: 1 }),
      row({ type: "TXT", name: "{domain}", content: "v=spf1 include:_spf.google.com ~all" }),
    ],
  },
  {
    id: "dmarc",
    label: "DMARC (monitor)",
    records: [row({ type: "TXT", name: "_dmarc.{domain}", content: "v=DMARC1; p=none" })],
  },
];

export const EMPTY_ZONE_OPTIONS: ZoneOptions = {
  ssl: null, alwaysHttps: null, acmeFullSsl: false, webmailFullSsl: false, skipFirewallIps: [], createIn: null,
};

/** A profile built from presets, as a new install offers them. */
function seeded(id: string, name: string, presetIds: string[]): Profile {
  const chosen = PRESETS.filter((preset) => presetIds.includes(preset.id));
  return {
    id,
    name,
    mode: "report",
    records: chosen.flatMap((preset) => preset.records.map((record) => ({ ...record }))),
    mailcow: chosen.some((preset) => preset.mailcow),
    zone: Object.assign({ ...EMPTY_ZONE_OPTIONS }, ...chosen.map((preset) => preset.zone ?? {})),
  };
}

/** Produced on read, like PHP Resources' categories, so a read never writes and a deleted one stays deleted. */
export function seededPolicy(): Policy {
  return {
    version: 1,
    profiles: [seeded("web", "Web", ["web"]), seeded("web-mailcow", "Web and Mailcow", ["web", "mailcow"])],
    defaultProfileId: null,
    assignments: {},
    knownSiteIds: [],
    held: [],
    connections: [],
    zoneChoices: {},
    server: { ipv4: "", ipv6: "" },
    mailcow: { ...EMPTY_MAILCOW },
  };
}
