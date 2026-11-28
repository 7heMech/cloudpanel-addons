/**
 * Pure Cloudflare zone-wide edge defaults and zone planner shared between
 * `lib/cloudflare/` (for token permission checks) and Firewall's Cloudflare
 * edge section. Keeps Firewall decoupled from DNS.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { failAction } from "../action";
import type { CfRuleset, RuleWrite } from "./api";

export const SSL_MODES = ["off", "flexible", "full", "strict"] as const;
export type SslMode = (typeof SSL_MODES)[number];

export const SSL_LABELS: Record<SslMode, string> = {
  off: "Off",
  flexible: "Flexible",
  full: "Full",
  strict: "Full (strict)",
};

/** Higher rank means stricter origin TLS verification; lowering rank is a destructive SSL downgrade. */
export const SSL_RANK: Record<SslMode, number> = {
  off: 0,
  flexible: 1,
  full: 2,
  strict: 3,
};

export const MAX_SKIP_IPS = 20;
export const CONFIG_PHASE = "http_config_settings";
export const FIREWALL_PHASE = "http_request_firewall_custom";

export type EdgeRuleKey = "acme" | "webmail" | "skip";

export interface EdgeDefaults {
  /** Null leaves each zone's existing SSL/TLS mode untouched. */
  ssl: SslMode | null;
  /** Null leaves each zone's Always Use HTTPS setting untouched. */
  alwaysHttps: boolean | null;
  /** Full SSL for Let's Encrypt HTTP-01 checks so proxied sites can issue and renew certificates. */
  acmeFullSsl: boolean;
  /** Full SSL for `webmail.` hosts whose origin is the mail server. */
  webmailFullSsl: boolean;
  /** Addresses that skip Super Bot Fight Mode and managed WAF rules. */
  skipFirewallIps: string[];
}

export const DEFAULT_EDGE_DEFAULTS: EdgeDefaults = {
  ssl: "strict",
  alwaysHttps: true,
  acmeFullSsl: true,
  webmailFullSsl: false,
  skipFirewallIps: [],
};

export const EMPTY_EDGE_DEFAULTS: EdgeDefaults = {
  ssl: null,
  alwaysHttps: null,
  acmeFullSsl: false,
  webmailFullSsl: false,
  skipFirewallIps: [],
};

/** Managed refs recognized for each rule kind: current Firewall refs plus legacy DNS refs for zero-churn upgrades. */
export const MANAGED_RULE_REFS: Record<EdgeRuleKey, readonly string[]> = {
  acme: ["clp_fw_acme", "clp_dns_acme"],
  webmail: ["clp_fw_webmail", "clp_dns_webmail"],
  skip: ["clp_fw_skip", "clp_dns_skip"],
};

const RULE_SUBJECTS: Record<EdgeRuleKey, string> = {
  acme: "Full SSL for Let's Encrypt",
  webmail: "Full SSL for webmail",
  skip: "WAF skip rule",
};

/** Managed rules a zone still holds that `defaults` no longer want; removing them needs the same edit permission. */
export function pendingRuleCleanup(defaults: EdgeDefaults, tracked: Record<string, readonly string[]>): EdgeRuleKey[] {
  const held = new Set(Object.values(tracked).flat());
  const wanted: Record<EdgeRuleKey, boolean> = {
    acme: defaults.acmeFullSsl,
    webmail: defaults.webmailFullSsl,
    skip: defaults.skipFirewallIps.length > 0,
  };
  return (["acme", "webmail", "skip"] as const).filter((key) => held.has(key) && !wanted[key]);
}

export const RULE_PHASES: Record<EdgeRuleKey, string> = {
  acme: CONFIG_PHASE,
  webmail: CONFIG_PHASE,
  skip: FIREWALL_PHASE,
};

const ACME_PATH = "/.well-known/acme-challenge/";
const ACME_EXPRESSION = `starts_with(http.request.uri.path, "${ACME_PATH}")`;
const WEBMAIL_EXPRESSION = 'starts_with(http.host, "webmail.")';
const SKIP_PHASES = ["http_request_sbfm", "http_request_firewall_managed"] as const;

function flag(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") failAction(`${what} must be on or off`);
  return value;
}

function anyIp(value: unknown): string {
  if (typeof value !== "string" || !isIP(value.trim())) failAction(`${String(value)} is not an IP address`);
  return value.trim().toLowerCase();
}

export function parseEdgeDefaults(value: unknown): EdgeDefaults {
  const raw = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const ssl = raw.ssl == null || raw.ssl === "" ? null : SSL_MODES.find((mode) => mode === raw.ssl);
  if (ssl === undefined) failAction("the SSL/TLS mode must be Off, Flexible, Full or Full (strict)");
  const alwaysHttps = raw.alwaysHttps == null || raw.alwaysHttps === "" ? null : flag(raw.alwaysHttps, "Always Use HTTPS");
  if (raw.skipFirewallIps != null && !Array.isArray(raw.skipFirewallIps)) failAction("the firewall skip list must be a list");
  const ips = [...new Set(((raw.skipFirewallIps ?? []) as unknown[]).map(anyIp))].sort();
  if (ips.length > MAX_SKIP_IPS) failAction(`at most ${MAX_SKIP_IPS} addresses can skip the firewall`);
  return {
    ssl,
    alwaysHttps,
    acmeFullSsl: flag(raw.acmeFullSsl ?? false, "the Let's Encrypt rule"),
    webmailFullSsl: flag(raw.webmailFullSsl ?? false, "the webmail rule"),
    skipFirewallIps: ips,
  };
}

/** Deterministic canonical digest for approval and review verification. */
export function edgeDefaultsDigest(defaults: EdgeDefaults): string {
  const canonical: EdgeDefaults = {
    ssl: defaults.ssl,
    alwaysHttps: defaults.alwaysHttps,
    acmeFullSsl: defaults.acmeFullSsl,
    webmailFullSsl: defaults.webmailFullSsl,
    skipFirewallIps: [...new Set(defaults.skipFirewallIps)].sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

export function hasActiveEdgeDefaults(defaults: EdgeDefaults): boolean {
  return defaults.ssl !== null
    || defaults.alwaysHttps !== null
    || defaults.acmeFullSsl
    || defaults.webmailFullSsl
    || defaults.skipFirewallIps.length > 0;
}

export function describeEdgeDefaults(defaults: EdgeDefaults): string {
  const parts: string[] = [];
  if (defaults.ssl) parts.push(`SSL/TLS ${SSL_LABELS[defaults.ssl]}`);
  if (defaults.alwaysHttps !== null) parts.push(`Always Use HTTPS ${defaults.alwaysHttps ? "on" : "off"}`);
  const rules = [
    defaults.acmeFullSsl && "Let's Encrypt Full SSL",
    defaults.webmailFullSsl && "webmail Full SSL",
    defaults.skipFirewallIps.length > 0 && `WAF skip (${defaults.skipFirewallIps.length} IP${defaults.skipFirewallIps.length === 1 ? "" : "s"})`,
  ].filter(Boolean);
  if (rules.length) parts.push(rules.join(", "));
  return parts.join(" · ") || "All edge settings left unchanged";
}

export interface WantedEdgeSetting {
  setting: "ssl" | "always_use_https";
  value: string;
  subject: string;
  label: string;
}

export function wantedEdgeSettings(defaults: EdgeDefaults): WantedEdgeSetting[] {
  const settings: WantedEdgeSetting[] = [];
  if (defaults.ssl) {
    settings.push({
      setting: "ssl",
      value: defaults.ssl,
      subject: "SSL/TLS mode",
      label: SSL_LABELS[defaults.ssl],
    });
  }
  if (defaults.alwaysHttps !== null) {
    settings.push({
      setting: "always_use_https",
      value: defaults.alwaysHttps ? "on" : "off",
      subject: "Always Use HTTPS",
      label: defaults.alwaysHttps ? "On" : "Off",
    });
  }
  return settings;
}

export interface WantedEdgeRule {
  key: EdgeRuleKey;
  phase: string;
  subject: string;
  label: string;
  rule: RuleWrite;
}

export function wantedEdgeRules(defaults: EdgeDefaults): WantedEdgeRule[] {
  const rules: WantedEdgeRule[] = [];
  if (defaults.acmeFullSsl) {
    rules.push({
      key: "acme",
      phase: CONFIG_PHASE,
      subject: RULE_SUBJECTS.acme,
      label: `Full SSL for ${ACME_PATH}`,
      rule: {
        ref: "clp_fw_acme",
        action: "set_config",
        enabled: true,
        expression: ACME_EXPRESSION,
        description: "CloudPanel Firewall: Full SSL for Let's Encrypt HTTP-01",
        action_parameters: { ssl: "full" },
      },
    });
  }
  if (defaults.webmailFullSsl) {
    rules.push({
      key: "webmail",
      phase: CONFIG_PHASE,
      subject: RULE_SUBJECTS.webmail,
      label: "Full SSL for webmail.* hosts",
      rule: {
        ref: "clp_fw_webmail",
        action: "set_config",
        enabled: true,
        expression: WEBMAIL_EXPRESSION,
        description: "CloudPanel Firewall: Full SSL for webmail",
        action_parameters: { ssl: "full" },
      },
    });
  }
  if (defaults.skipFirewallIps.length > 0) {
    const ips = [...new Set(defaults.skipFirewallIps)].sort();
    rules.push({
      key: "skip",
      phase: FIREWALL_PHASE,
      subject: RULE_SUBJECTS.skip,
      label: `Skip Super Bot Fight Mode and managed rules for ${ips.join(", ")}`,
      rule: {
        ref: "clp_fw_skip",
        action: "skip",
        enabled: true,
        expression: `ip.src in {${ips.join(" ")}}`,
        description: "CloudPanel Firewall: skip Super Bot Fight Mode and managed rules",
        action_parameters: { phases: [...SKIP_PHASES] },
        logging: { enabled: true },
      },
    });
  }
  return rules;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

function normalizeExpression(expression: string): string {
  return expression.replace(/\s+/g, " ").trim();
}

/** Parses `ip.src in {a b}` expressions into a sorted, lowercased IP list; returns null for any other expression. */
export function extractSkipIps(expression: string): string[] | null {
  const match = /^ip\.src\s+in\s+\{([^}]*)\}$/.exec(normalizeExpression(expression));
  if (!match) return null;
  const tokens = match[1]!.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.some((token) => !isIP(token))) return null;
  return [...new Set(tokens.map((token) => token.toLowerCase()))].sort();
}

function paramsObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sameSkipParams(current: unknown, wanted: unknown): boolean {
  const norm = (params: unknown) => {
    const copy: Record<string, unknown> = { ...paramsObject(params) };
    if (Array.isArray(copy.phases)) copy.phases = [...copy.phases].map(String).sort();
    return JSON.stringify(sorted(copy));
  };
  return norm(current) === norm(wanted);
}

export function sameEdgeRule(current: CfRuleset["rules"][number], wanted: RuleWrite, key?: EdgeRuleKey): boolean {
  if (!current.enabled || current.action !== wanted.action) return false;
  if (key === "skip") {
    const curIps = extractSkipIps(current.expression);
    const wantIps = extractSkipIps(wanted.expression);
    return curIps !== null && wantIps !== null
      && curIps.length === wantIps.length
      && curIps.every((ip, index) => ip === wantIps[index])
      && sameSkipParams(current.action_parameters, wanted.action_parameters);
  }
  return normalizeExpression(current.expression) === normalizeExpression(wanted.expression)
    && JSON.stringify(sorted(paramsObject(current.action_parameters))) === JSON.stringify(sorted(paramsObject(wanted.action_parameters)));
}

function ruleName(rule: CfRuleset["rules"][number]): string {
  return rule.description?.trim() || rule.ref?.trim() || rule.id;
}

function describeExistingRule(rule: CfRuleset["rules"][number], key: EdgeRuleKey): string {
  const parts: string[] = [];
  if (key === "skip") {
    const ips = extractSkipIps(rule.expression);
    parts.push(ips ? `Skip for ${ips.join(", ")}` : rule.expression);
  } else {
    const params = paramsObject(rule.action_parameters);
    const ssl = typeof params.ssl === "string"
      ? SSL_LABELS[params.ssl as SslMode] ?? params.ssl
      : null;
    parts.push(ssl ? `SSL ${ssl}` : rule.action);
  }
  if (!rule.enabled) parts.push("disabled");
  return parts.join(" · ");
}

function touchesRuleTarget(rule: CfRuleset["rules"][number], key: EdgeRuleKey): boolean {
  const expr = normalizeExpression(rule.expression);
  if (key === "acme") return expr.includes(ACME_PATH);
  if (key === "webmail") return /http\.host\b/.test(expr) && expr.includes("webmail.");
  if (key === "skip") {
    if (rule.action !== "skip") return false;
    if (!/\bip\.src\b/.test(expr)) return false;
    const params = paramsObject(rule.action_parameters);
    const phases = Array.isArray(params.phases) ? params.phases.map(String) : [];
    const ruleset = typeof params.ruleset === "string" ? params.ruleset : "";
    return phases.some((phase) => (SKIP_PHASES as readonly string[]).includes(phase)) || ruleset === "current";
  }
  return false;
}

/**
 * Enabled rules after the ACME rule that set another SSL mode. Every host
 * serves the challenge path, so even a rule for one hostname can match it, and
 * Cloudflare applies the last setting.
 */
function laterSslRules(rules: CfRuleset["rules"], target: CfRuleset["rules"][number], key: EdgeRuleKey): CfRuleset["rules"] {
  if (key !== "acme") return [];
  return rules.slice(rules.indexOf(target) + 1).filter((rule) => {
    const ssl = paramsObject(rule.action_parameters).ssl;
    return rule.enabled && rule.action === "set_config" && typeof ssl === "string" && ssl !== "full";
  });
}

function exactForeignTarget(rule: CfRuleset["rules"][number], key: EdgeRuleKey): boolean {
  const expr = normalizeExpression(rule.expression);
  if (key === "acme") return expr === ACME_EXPRESSION;
  if (key === "webmail") return expr === WEBMAIL_EXPRESSION;
  if (key === "skip") return rule.action === "skip" && extractSkipIps(expr) !== null;
  return false;
}

export interface LiveZoneEdgeState {
  settings: Partial<Record<"ssl" | "always_use_https", string>>;
  rulesets: Partial<Record<string, CfRuleset | null>>;
}

export interface PlannedEdgeChange {
  kind: "setting" | "rule";
  target: "ssl" | "always_use_https" | EdgeRuleKey;
  action: "create" | "update" | "delete";
  subject: string;
  detail: string;
  before?: string;
  /** True for SSL downgrades, turning Always Use HTTPS off, removing skip IPs, or deleting managed rules. */
  destructive?: true;
  /** True when a managed rule was disabled/modified or a single-purpose foreign rule conflicts. */
  conflict?: true;
  /** Human-readable explanation when destructive or conflict is true. */
  reason?: string;
  // Internal apply metadata (stripped from browser views if desired, or kept minimal).
  setting?: "ssl" | "always_use_https";
  value?: string;
  phase?: string;
  rulesetId?: string;
  ruleId?: string;
  keepRef?: string;
  rule?: RuleWrite;
}

export interface ZoneCurrentSummary {
  ssl?: string;
  alwaysHttps?: string;
  acmeRule?: boolean;
  webmailRule?: boolean;
  skipIps?: string[];
}

export interface ZoneEdgePlan {
  changes: PlannedEdgeChange[];
  /** Blocking conflicts (such as compound or multiple competing rules) that require manual cleanup in Cloudflare. */
  conflicts: string[];
  /** Which managed rules (`clp_fw_*` / `clp_dns_*`) currently exist in this zone. */
  managedRules: EdgeRuleKey[];
  current: ZoneCurrentSummary;
}

/**
 * Compares desired zone-wide edge defaults against live Cloudflare settings
 * and rulesets. Distinguishes safe additive/upgrade changes from destructive
 * changes (SSL downgrades, disabling Always Use HTTPS, removing rules or skip
 * IPs) and rule conflicts so callers can auto-apply safe defaults while
 * holding risky or conflicting zones for explicit confirmation.
 */
export function planZoneEdge(defaults: EdgeDefaults, live: LiveZoneEdgeState): ZoneEdgePlan {
  const changes: PlannedEdgeChange[] = [];
  const conflicts: string[] = [];
  const managedRules: EdgeRuleKey[] = [];
  const current: ZoneCurrentSummary = {};

  if (live.settings.ssl !== undefined) {
    current.ssl = SSL_LABELS[live.settings.ssl as SslMode] ?? live.settings.ssl;
  }
  if (live.settings.always_use_https !== undefined) {
    current.alwaysHttps = live.settings.always_use_https === "on" ? "On"
      : live.settings.always_use_https === "off" ? "Off"
      : live.settings.always_use_https;
  }

  for (const wanted of wantedEdgeSettings(defaults)) {
    const liveValue = live.settings[wanted.setting];
    if (liveValue === undefined || liveValue === wanted.value) continue;
    if (wanted.setting === "ssl") {
      const before = SSL_LABELS[liveValue as SslMode] ?? liveValue;
      const curRank = SSL_RANK[liveValue as SslMode];
      const wantRank = SSL_RANK[wanted.value as SslMode];
      const destructive = curRank === undefined || wantRank < curRank;
      changes.push({
        kind: "setting",
        target: "ssl",
        action: "update",
        subject: wanted.subject,
        detail: wanted.label,
        before,
        setting: "ssl",
        value: wanted.value,
        ...(destructive ? { destructive: true as const, reason: `Downgrades SSL/TLS mode from ${before} to ${wanted.label}` } : {}),
      });
    } else {
      const before = liveValue === "on" ? "On" : liveValue === "off" ? "Off" : liveValue;
      const destructive = liveValue === "on" && wanted.value === "off";
      changes.push({
        kind: "setting",
        target: "always_use_https",
        action: "update",
        subject: wanted.subject,
        detail: wanted.label,
        before,
        setting: "always_use_https",
        value: wanted.value,
        ...(destructive ? { destructive: true as const, reason: "Turns off Always Use HTTPS for the whole zone" } : {}),
      });
    }
  }

  const wantedByKey = new Map(wantedEdgeRules(defaults).map((spec) => [spec.key, spec]));
  for (const key of ["acme", "webmail", "skip"] as const) {
    const phase = RULE_PHASES[key];
    if (!(phase in live.rulesets)) continue;
    const ruleset = live.rulesets[phase] ?? null;
    const rules = ruleset?.rules ?? [];
    const ours = rules.filter((rule) => MANAGED_RULE_REFS[key].includes(rule.ref));
    if (ours.length > 0) managedRules.push(key);

    const spec = wantedByKey.get(key);
    // Summarize live rule state for the dashboard.
    if (key === "acme") {
      current.acmeRule = rules.some((rule) => rule.enabled && normalizeExpression(rule.expression) === ACME_EXPRESSION && paramsObject(rule.action_parameters).ssl === "full");
    } else if (key === "webmail") {
      current.webmailRule = rules.some((rule) => rule.enabled && normalizeExpression(rule.expression) === WEBMAIL_EXPRESSION && paramsObject(rule.action_parameters).ssl === "full");
    } else if (key === "skip") {
      const activeSkip = ours.find((rule) => rule.enabled) ?? rules.find((rule) => rule.enabled && touchesRuleTarget(rule, "skip"));
      const ips = activeSkip ? extractSkipIps(activeSkip.expression) : null;
      if (ips) current.skipIps = ips;
    }

    if (!spec) {
      // Setting is disabled/empty: delete any previously managed rule behind an explicit destructive confirmation.
      for (const existing of ours) {
        changes.push({
          kind: "rule",
          target: key,
          action: "delete",
          subject: RULE_SUBJECTS[key],
          detail: "Remove managed rule",
          before: describeExistingRule(existing, key),
          destructive: true,
          reason: `Removes the existing ${RULE_SUBJECTS[key].toLowerCase()} from this zone`,
          phase,
          rulesetId: ruleset!.id,
          ruleId: existing.id,
        });
      }
      continue;
    }

    if (ours.length > 1) {
      conflicts.push(`Multiple managed rules match ${spec.subject} (${ours.map(ruleName).join(", ")}); keep only one in Cloudflare.`);
      continue;
    }

    if (ours.length === 1) {
      const existing = ours[0]!;
      const competitors = rules.filter((rule) => rule.id !== existing.id
        && (touchesRuleTarget(rule, key) || laterSslRules(rules, existing, key).includes(rule)));
      if (competitors.length > 0) {
        const names = competitors.map((rule) => `“${ruleName(rule)}”`).join(", ");
        conflicts.push(
          `Conflicting Cloudflare rule${competitors.length > 1 ? "s" : ""} (${names}) overlap with ${spec.subject}; resolve ${competitors.length > 1 ? "them" : "it"} in Cloudflare first.`,
        );
        continue;
      }
      if (sameEdgeRule(existing, spec.rule, key)) continue;
      let destructive: true | undefined;
      let conflict: true | undefined;
      let reason: string | undefined;
      if (!existing.enabled) {
        conflict = true;
        reason = `Managed rule “${ruleName(existing)}” is disabled in Cloudflare`;
      } else if (key === "skip") {
        const curIps = extractSkipIps(existing.expression);
        if (!curIps || !sameSkipParams(existing.action_parameters, spec.rule.action_parameters)) {
          conflict = true;
          reason = `Managed WAF skip rule “${ruleName(existing)}” was edited in Cloudflare`;
        } else {
          const removed = curIps.filter((ip) => !defaults.skipFirewallIps.includes(ip));
          if (removed.length > 0) {
            destructive = true;
            reason = `Removes ${removed.join(", ")} from the WAF skip rule`;
          }
        }
      } else {
        conflict = true;
        reason = `Managed rule “${ruleName(existing)}” was modified in Cloudflare`;
      }
      changes.push({
        kind: "rule",
        target: key,
        action: "update",
        subject: spec.subject,
        detail: spec.label,
        before: describeExistingRule(existing, key),
        ...(destructive ? { destructive } : {}),
        ...(conflict ? { conflict } : {}),
        ...(reason ? { reason } : {}),
        phase,
        rulesetId: ruleset!.id,
        ruleId: existing.id,
        keepRef: existing.ref,
        rule: spec.rule,
      });
      continue;
    }

    // Check for foreign rules targeting the same condition; adopt an equivalent
    // enabled rule in place with no writes only when no competing rule overlaps.
    const foreign = rules.filter((rule) => touchesRuleTarget(rule, key));
    const equivalent = rules.filter((rule) => sameEdgeRule(rule, spec.rule, key));
    if (equivalent.length > 0) {
      const later = laterSslRules(rules, equivalent[0]!, key);
      const competitors = rules.filter((rule) => rule.id !== equivalent[0]!.id && (foreign.includes(rule) || later.includes(rule)));
      if (competitors.length === 0) continue;
      const names = competitors.map((rule) => `“${ruleName(rule)}”`).join(", ");
      conflicts.push(
        `Conflicting Cloudflare rule${competitors.length > 1 ? "s" : ""} (${names}) overlap with ${spec.subject}; resolve ${competitors.length > 1 ? "them" : "it"} in Cloudflare first.`,
      );
      continue;
    }

    if (foreign.length === 0) {
      changes.push({
        kind: "rule",
        target: key,
        action: "create",
        subject: spec.subject,
        detail: spec.label,
        phase,
        ...(ruleset ? { rulesetId: ruleset.id } : {}),
        rule: spec.rule,
      });
    } else if (foreign.length === 1 && exactForeignTarget(foreign[0]!, key)) {
      const existing = foreign[0]!;
      const curIps = key === "skip" ? extractSkipIps(existing.expression) : null;
      const removed = curIps ? curIps.filter((ip) => !defaults.skipFirewallIps.includes(ip)) : [];
      changes.push({
        kind: "rule",
        target: key,
        action: "update",
        subject: spec.subject,
        detail: spec.label,
        before: describeExistingRule(existing, key),
        conflict: true,
        ...(removed.length > 0 ? { destructive: true as const } : {}),
        reason: `Conflicts with existing rule “${ruleName(existing)}” in Cloudflare`,
        phase,
        rulesetId: ruleset!.id,
        ruleId: existing.id,
        keepRef: existing.ref,
        rule: spec.rule,
      });
    } else {
      const names = foreign.map((rule) => `“${ruleName(rule)}”`).join(", ");
      conflicts.push(
        `Conflicting Cloudflare rule${foreign.length > 1 ? "s" : ""} (${names}) overlap with ${spec.subject}; resolve ${foreign.length > 1 ? "them" : "it"} in Cloudflare first.`,
      );
    }
  }

  return { changes, conflicts, managedRules, current };
}
