// Checks for values a verb takes on its command line or in its request body.
import { failAction } from "./action";
import { JOB_ID_RE } from "./job-id";

const HOSTNAME_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** A lowercase hostname of two or more labels. */
export const HOSTNAME_RE = new RegExp(`^(?:${HOSTNAME_LABEL})(?:\\.${HOSTNAME_LABEL})+$`);
export const WILDCARD_HOSTNAME_RE = new RegExp(`^\\*\\.(?:${HOSTNAME_LABEL})(?:\\.${HOSTNAME_LABEL})+$`);

export function matchesEntire(pattern: RegExp, value: string): boolean {
  const match = value.match(pattern);
  return match?.[0] === value;
}

export function validatePort(value: string): number {
  if (!value) failAction("missing --port");
  if (!matchesEntire(/^[0-9]{1,5}$/, value)) failAction(`port must be an integer: '${value}'`);
  const port = Number(value);
  if (port < 39000 || port > 39999) {
    failAction(`port ${value} outside reserved range 39000-39999`);
  }
  return port;
}

export function validateTag(value: string): string {
  if (!value) failAction("missing --tag");
  if (!matchesEntire(/^\d+\.\d+\.\d+$/, value)) {
    failAction(`tag must be an exact version like 0.0.18, got: '${value}'`);
  }
  return value;
}

export function validateFlag(value: string, what: string): string {
  if (value !== "yes" && value !== "no") failAction(`--${what} takes yes or no, got: '${value}'`);
  return value;
}

export function validateJob(value: string): string {
  if (!value) failAction("missing --job");
  if (!JOB_ID_RE.test(value)) {
    failAction(`invalid job id: '${value}'`);
  }
  return value;
}

export function validateEmail(value: string): string {
  if (!value) failAction("missing --email");
  if (value.length > 254) failAction("--email is too long");
  if (!matchesEntire(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/, value)) {
    failAction(`invalid email address: '${value}'`);
  }
  return value;
}

export function validateMfa(value: string): string {
  if (!matchesEntire(/^[A-Za-z0-9-]{6,32}$/, value)) failAction("the authentication code has an unexpected shape");
  return value;
}

/** One line of plain text: no control characters, no runs of whitespace. */
export function oneLine(value: unknown, what: string, max: number, required: boolean): string {
  if (value == null && !required) return "";
  if (typeof value !== "string") failAction(`${what} must be text`);
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text && required) failAction(`${what} is required`);
  if (text.length > max) failAction(`${what} must be at most ${max} characters`);
  return text;
}

/**
 * The stable identifier a named record keeps for its whole life, derived from
 * the name it was created with. Renaming leaves it alone, so whatever is
 * assigned to the record does not come loose when it is renamed.
 */
export function nameSlug(name: string, what: string, max = 40): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, max).replace(/^-+|-+$/g, "");
  if (!slug) failAction(`${what} needs at least one letter or digit`);
  return slug;
}
