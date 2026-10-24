/**
 * What profiles ask of a whole zone: its SSL/TLS mode, Always Use HTTPS, and
 * three rules. Every site in a zone shares these, so they are worked out from
 * all of that zone's profiles together, and profiles that disagree are
 * reported rather than taking turns.
 *
 * The rules are zone-wide, one of each, so a zone with many sites still uses
 * one rule of each kind against the plan's rule quota. A rule that already does
 * the same thing -- one an earlier tool created -- counts as present.
 */
import type { CfRuleset, RuleWrite } from "./cloudflare";
import type { Profile, SslMode } from "./model";

export interface ZoneWants {
  ssl: SslMode | null;
  alwaysHttps: boolean | null;
  acme: boolean;
  webmail: boolean;
  skipIps: string[];
}

export const SSL_LABELS: Record<SslMode, string> = { off: "Off", flexible: "Flexible", full: "Full", strict: "Full (strict)" };

export function zoneWants(profiles: Profile[]): { wants: ZoneWants; problems: string[] } {
  const problems: string[] = [];
  const ssl = new Set(profiles.map((profile) => profile.zone.ssl).filter((mode) => mode !== null));
  const https = new Set(profiles.map((profile) => profile.zone.alwaysHttps).filter((value) => value !== null));
  if (ssl.size > 1) problems.push("The profiles in this zone ask for different SSL/TLS modes");
  if (https.size > 1) problems.push("The profiles in this zone disagree on Always Use HTTPS");
  return {
    wants: {
      ssl: ssl.size === 1 ? [...ssl][0]! : null,
      alwaysHttps: https.size === 1 ? [...https][0]! : null,
      acme: profiles.some((profile) => profile.zone.acmeFullSsl),
      webmail: profiles.some((profile) => profile.zone.webmailFullSsl),
      skipIps: [...new Set(profiles.flatMap((profile) => profile.zone.skipFirewallIps))].sort(),
    },
    problems,
  };
}

/** The settings Cloudflare names, with the values a profile's choice becomes. */
export function wantedSettings(wants: ZoneWants): { setting: string; value: string; label: string }[] {
  const settings: { setting: string; value: string; label: string }[] = [];
  if (wants.ssl) settings.push({ setting: "ssl", value: wants.ssl, label: `SSL/TLS ${SSL_LABELS[wants.ssl]}` });
  if (wants.alwaysHttps !== null) {
    settings.push({ setting: "always_use_https", value: wants.alwaysHttps ? "on" : "off", label: `Always Use HTTPS ${wants.alwaysHttps ? "on" : "off"}` });
  }
  return settings;
}

export const CONFIG_PHASE = "http_config_settings";
export const FIREWALL_PHASE = "http_request_firewall_custom";

export interface RuleSpec {
  phase: string;
  label: string;
  rule: RuleWrite;
}

export function wantedRules(wants: ZoneWants): RuleSpec[] {
  const rules: RuleSpec[] = [];
  if (wants.acme) {
    rules.push({
      phase: CONFIG_PHASE,
      label: "Full SSL for Let's Encrypt checks",
      rule: {
        ref: "clp_dns_acme", action: "set_config", enabled: true,
        expression: 'starts_with(http.request.uri.path, "/.well-known/acme-challenge/")',
        description: "CloudPanel DNS: Full SSL for Let's Encrypt HTTP-01",
        action_parameters: { ssl: "full" },
      },
    });
  }
  if (wants.webmail) {
    rules.push({
      phase: CONFIG_PHASE,
      label: "Full SSL for webmail",
      rule: {
        ref: "clp_dns_webmail", action: "set_config", enabled: true,
        expression: 'starts_with(http.host, "webmail.")',
        description: "CloudPanel DNS: Full SSL for webmail",
        action_parameters: { ssl: "full" },
      },
    });
  }
  if (wants.skipIps.length) {
    rules.push({
      phase: FIREWALL_PHASE,
      label: `Firewall skip for ${wants.skipIps.join(", ")}`,
      rule: {
        ref: "clp_dns_skip", action: "skip", enabled: true,
        expression: `ip.src in {${wants.skipIps.join(" ")}}`,
        description: "CloudPanel DNS: skip Super Bot Fight Mode and managed rules",
        action_parameters: { phases: ["http_request_sbfm", "http_request_firewall_managed"] },
        logging: { enabled: true },
      },
    });
  }
  return rules;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]));
  }
  return value;
}

function sameRule(current: CfRuleset["rules"][number], wanted: RuleWrite): boolean {
  return current.enabled
    && current.action === wanted.action
    && current.expression.replace(/\s+/g, " ").trim() === wanted.expression
    && JSON.stringify(sorted(current.action_parameters ?? {})) === JSON.stringify(sorted(wanted.action_parameters ?? {}));
}

export type RuleState =
  | { state: "present" }
  | { state: "create" }
  | { state: "update"; ruleId: string };

export function ruleState(ruleset: CfRuleset | null, wanted: RuleWrite): RuleState {
  const rules = ruleset?.rules ?? [];
  const ours = rules.find((rule) => rule.ref === wanted.ref);
  if (ours) return sameRule(ours, wanted) ? { state: "present" } : { state: "update", ruleId: ours.id };
  return rules.some((rule) => sameRule(rule, wanted)) ? { state: "present" } : { state: "create" };
}
