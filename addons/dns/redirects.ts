/**
 * Redirect domains on Cloudflare: one Single Redirect rule per domain in the
 * zone's `http_request_dynamic_redirect` entrypoint, beside whatever else is
 * there.
 *
 * A rule another tool wrote is taken over in place. It is found by the hosts
 * its expression names, whether or not it has a `ref`, so a domain never gets
 * a second rule; a rule that names a domain's host in a way that cannot be
 * read as "this host, whole" stops the domain instead.
 */
import { createHash } from "node:crypto";
import { getDomain } from "tldts";
import type { CfRule, CfRuleset, RuleWrite } from "./cloudflare";
import { dnsName, REDIRECT_STATUSES, type Redirect, type RedirectStatus } from "./model";

export const REDIRECT_PHASE = "http_request_dynamic_redirect";

/** The placeholder a proxied redirect host points at: Cloudflare answers, so the address is never reached. */
export const PLACEHOLDER = "100::";

const ACME_EXCLUSION = / and not starts_with\(http\.request\.uri\.path, "\/\.well-known\/acme-challenge\/"\)$/;

/** The source, and its `www` when the source is its zone's apex. */
export function redirectHosts(source: string, zone: string): string[] {
  return source === zone ? [source, `www.${source}`] : [source];
}

/** The hosts a stand-in site answers for, with no zone to tell the apex by: the registrable domain is one. */
export function standInHosts(source: string): string[] {
  return redirectHosts(source, getDomain(source, { allowPrivateDomains: false }) ?? source);
}

export function redirectRef(source: string): string {
  return `clp_dns_redirect_${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}

function hostExpression(hosts: string[]): string {
  const tests = hosts.map((host) => `http.host eq "${host}"`);
  return tests.length === 1 ? tests[0]! : `(${tests.join(" or ")})`;
}

export function wantedRedirectRule(redirect: Redirect, hosts: string[]): RuleWrite {
  return {
    ref: redirectRef(redirect.source),
    action: "redirect",
    enabled: true,
    expression: hostExpression(hosts),
    description: `CloudPanel DNS: redirect ${redirect.source}`,
    action_parameters: {
      from_value: {
        status_code: redirect.status,
        target_url: redirect.keepPath ? { expression: `concat("${redirect.target}", http.request.uri.path)` } : { value: redirect.target },
        preserve_query_string: redirect.keepQuery,
      },
    },
  };
}

/** One line for a redirect, as the page shows it. */
export function describeRedirect(redirect: Pick<Redirect, "target" | "status" | "keepPath" | "keepQuery">): string {
  const kept = [redirect.keepPath && "path", redirect.keepQuery && "query string"].filter(Boolean);
  return `${redirect.status} to ${redirect.target}${kept.length ? ` · keeps the ${kept.join(" and ")}` : ""}`;
}

function normalised(expression: string): string {
  return expression.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

/** `text` without parentheses that wrap all of it. */
function unwrap(text: string): string {
  while (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      if (depth === 0 && i < text.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

/**
 * The hosts an expression matches when it matches whole hosts and nothing else,
 * such as `(http.host eq "a" or http.host eq "www.a")`; Let's Encrypt's path
 * may be left out, as Terraform's rules did. Null for anything else.
 */
export function wholeHostHosts(expression: string): string[] | null {
  const text = unwrap(normalised(expression).replace(ACME_EXCLUSION, ""));
  const set = /^http\.host in \{((?: ?"[^"]+")+) ?\}$/.exec(text);
  const hosts = set
    ? [...set[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
    : text.split(" or ").map((part) => /^http\.host (?:eq|==) "([^"]+)"$/.exec(unwrap(part.trim()))?.[1] ?? "");
  const names = hosts.map((host) => host.toLowerCase());
  return names.length && names.every((name) => dnsName(name) && !name.startsWith("*.")) ? [...new Set(names)] : null;
}

/** Whether any string in the expression names `host` itself, not a host under it. */
function mentions(expression: string, host: string): boolean {
  const pattern = new RegExp(`(^|[^a-z0-9.-])${host.replace(/[.]/g, "\\.")}($|[^a-z0-9.-])`);
  return [...expression.toLowerCase().matchAll(/"((?:[^"\\]|\\.)*)"/g)].some((match) => pattern.test(match[1]!));
}

export interface RedirectAction {
  target: string;
  status: RedirectStatus;
  keepPath: boolean;
  keepQuery: boolean;
}

/** What a rule's redirect does, when it is a fixed URL or a fixed URL with the path appended. */
export function redirectAction(rule: Pick<CfRule, "action" | "action_parameters">): RedirectAction | null {
  if (rule.action !== "redirect") return null;
  const from = (rule.action_parameters as { from_value?: Record<string, unknown> } | undefined)?.from_value;
  if (!from || typeof from !== "object") return null;
  const status = REDIRECT_STATUSES.find((code) => code === Number(from.status_code ?? 301));
  const url = (from.target_url ?? {}) as { value?: unknown; expression?: unknown };
  if (!status) return null;
  const keepQuery = from.preserve_query_string === true;
  if (typeof url.value === "string") return { target: url.value, status, keepPath: false, keepQuery };
  const concat = typeof url.expression === "string" && /^concat\("([^"\\]+)", ?http\.request\.uri\.path\)$/.exec(normalised(url.expression));
  return concat ? { target: concat[1]!, status, keepPath: true, keepQuery } : null;
}

function sameRule(current: CfRule, wanted: RuleWrite): boolean {
  const action = redirectAction(current);
  const want = redirectAction(wanted)!;
  return current.enabled && normalised(current.expression) === wanted.expression
    && action !== null && JSON.stringify(action) === JSON.stringify(want);
}

export type RedirectRuleState =
  | { state: "present"; rule: CfRule }
  | { state: "create" }
  | { state: "update"; rule: CfRule }
  | { state: "problem"; problem: string };

function ruleLabel(rule: CfRule): string {
  return rule.description ? `"${rule.description}"` : rule.expression.slice(0, 160);
}

/** Our rule for `redirect`, found by its `ref` or by the hosts it names, and whether it needs writing. */
export function redirectRuleState(ruleset: CfRuleset | null, redirect: Redirect, hosts: string[]): RedirectRuleState {
  const wanted = wantedRedirectRule(redirect, hosts);
  const related = (ruleset?.rules ?? []).filter((rule) => rule.ref === wanted.ref || hosts.some((host) => mentions(rule.expression, host)));
  if (!related.length) return { state: "create" };
  if (related.length > 1) {
    return {
      state: "problem",
      problem: `${related.length} redirect rules in Cloudflare already match ${hosts.join(" or ")} (${related.map(ruleLabel).join("; ")}); delete all but one in Cloudflare`,
    };
  }
  const rule = related[0]!;
  if (rule.ref !== wanted.ref) {
    const ruleHosts = wholeHostHosts(rule.expression);
    if (!ruleHosts || !ruleHosts.includes(redirect.source) || ruleHosts.some((host) => !hosts.includes(host))) {
      return { state: "problem", problem: `A rule in Cloudflare already redirects ${redirect.source} in a way DNS cannot take over (${ruleLabel(rule)}); change or delete it in Cloudflare` };
    }
  }
  return sameRule(rule, wanted) ? { state: "present", rule } : { state: "update", rule };
}

export interface FoundRedirect extends RedirectAction {
  source: string;
  zone: string;
}

/**
 * A rule that redirects one whole host, or a zone's apex and its `www`, to a
 * fixed URL, read as the redirect domain it would be. Null for any other rule.
 */
export function foundRedirect(rule: CfRule, zone: string): FoundRedirect | null {
  const action = redirectAction(rule);
  const hosts = wholeHostHosts(rule.expression);
  if (!action || !hosts || !rule.enabled) return null;
  const inZone = hosts.every((host) => host === zone || host.endsWith(`.${zone}`));
  if (!inZone) return null;
  const sorted = [...hosts].sort((a, b) => a.length - b.length);
  if (sorted.length === 2 && !(sorted[0] === zone && sorted[1] === `www.${zone}`)) return null;
  if (sorted.length > 2) return null;
  return { source: sorted[0]!, zone, ...action };
}
