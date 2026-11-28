/**
 * Rows an HTTP or Mail profile can start from. A preset only fills the editor:
 * once saved, the rows are the profile's own and nothing here changes them.
 */
import type { Policy, Profile, ProfileRole, RecordTemplate } from "./model";
import { EMPTY_MAILCOW } from "./model";

type Row = Partial<RecordTemplate> & Pick<RecordTemplate, "type" | "name" | "content">;

function row(fields: Row): RecordTemplate {
  return { proxied: false, ttl: 1, priority: null, apexOnly: false, ...fields };
}

export interface Preset {
  id: string;
  label: string;
  role: ProfileRole;
  records: RecordTemplate[];
  /** Turned on with the rows, because the rows need it. */
  mailcow?: boolean;
}

export const PRESETS: Preset[] = [
  {
    id: "web",
    label: "Web (CloudPanel)",
    role: "http",
    records: [
      row({ type: "A", name: "{domain}", content: "{ipv4}", proxied: true }),
      row({ type: "AAAA", name: "{domain}", content: "{ipv6}", proxied: true }),
      row({ type: "A", name: "*.{domain}", content: "{ipv4}", proxied: true, apexOnly: true }),
      row({ type: "AAAA", name: "*.{domain}", content: "{ipv6}", proxied: true, apexOnly: true }),
    ],
  },
  {
    id: "mailcow",
    label: "Mailcow",
    role: "mail",
    records: [
      row({ type: "MX", name: "{domain}", content: "{mailcow.host}", priority: 10 }),
      row({ type: "TXT", name: "{domain}", content: "v=spf1 mx ~all" }),
      row({ type: "TXT", name: "{mailcow.selector}._domainkey.{domain}", content: "{mailcow.dkim}" }),
      row({ type: "CNAME", name: "autoconfig.{domain}", content: "{mailcow.host}", apexOnly: true }),
      row({ type: "CNAME", name: "autodiscover.{domain}", content: "{mailcow.host}", apexOnly: true }),
      row({ type: "SRV", name: "_autodiscover._tcp.{domain}", content: "0 443 {mailcow.host}", priority: 0, apexOnly: true }),
      row({ type: "CNAME", name: "webmail.{domain}", content: "{mailcow.host}", proxied: true, apexOnly: true }),
    ],
    mailcow: true,
  },
  {
    id: "google",
    label: "Google Workspace",
    role: "mail",
    records: [
      row({ type: "MX", name: "{domain}", content: "smtp.google.com", priority: 1 }),
      row({ type: "TXT", name: "{domain}", content: "v=spf1 include:_spf.google.com ~all" }),
    ],
  },
  {
    id: "dmarc",
    label: "DMARC (monitor)",
    role: "mail",
    records: [row({ type: "TXT", name: "_dmarc.{domain}", content: "v=DMARC1; p=none", apexOnly: true })],
  },
];

/** Presets offered in the editor: omit Mailcow until a Mailcow server is linked. */
export function presetsFor(mailcowLinked: boolean): Preset[] {
  return mailcowLinked ? PRESETS : PRESETS.filter((preset) => !preset.mailcow);
}

/** A profile built from one role's presets. */
function seeded(id: string, name: string, role: ProfileRole, presetIds: string[]): Profile {
  const chosen = PRESETS.filter((preset) => presetIds.includes(preset.id));
  return {
    id,
    name,
    role,
    records: chosen.flatMap((preset) => preset.records.map((record) => ({ ...record }))),
    mailcow: role === "mail" && chosen.some((preset) => preset.mailcow),
  };
}

/** Built when an operator links Mailcow for the first time and no Mailcow profile exists yet. */
export function mailcowSeededProfile(id = "mailcow"): Profile {
  return seeded(id, "Mailcow", "mail", ["mailcow"]);
}

/** Produced on read on a fresh install: omits Mailcow until linked, so a deleted profile stays deleted. */
export function seededPolicy(): Policy {
  return {
    version: 2,
    automatic: false,
    createIn: null,
    profiles: [
      seeded("web", "Web", "http", ["web"]),
      seeded("google", "Google Workspace", "mail", ["google"]),
      seeded("dmarc", "DMARC", "mail", ["dmarc"]),
    ],
    defaultHttpProfileId: null,
    defaultMailProfileId: null,
    assignments: {},
    knownSiteIds: [],
    held: [],
    connections: [],
    powerdns: [],
    zoneChoices: {},
    server: { ipv4: "", ipv6: "" },
    mailcow: { ...EMPTY_MAILCOW },
    panelHost: null,
  };
}
