/**
 * The one way DNS talks to Cloudflare and Mailcow: HTTPS, no redirects, a
 * deadline for every request, a bounded reply, and a provider's 429 kept as
 * the time to try again. Credentials go only into request headers.
 */
import { readBoundedText } from "../../lib/app-http";

export type ApiFetch = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
/** Cloudflare blocks a client that exceeds its limit for five minutes. */
const DEFAULT_BACKOFF_MS = 5 * 60_000;

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status = 0,
    /** When the provider asked to be left alone until, for a 429. */
    readonly retryAt = 0,
  ) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }
}

function retryTime(header: string | null, now: number): number {
  if (header && /^\d+$/.test(header)) return now + Number(header) * 1000;
  const date = header ? Date.parse(header) : NaN;
  return Number.isFinite(date) && date > now ? date : now + DEFAULT_BACKOFF_MS;
}

export class ProviderHttp {
  constructor(
    readonly provider: string,
    private readonly base: string,
    private readonly headers: Record<string, string>,
    private readonly fetcher: ApiFetch = fetch,
    /** Shared by every client of one provider in a run, so one 429 stops them all. */
    readonly backoff: { until: number } = { until: 0 },
  ) {}

  /** The parsed JSON body and the status, whatever the status was. */
  async request(path: string, method = "GET", body?: unknown): Promise<{ status: number; json: unknown }> {
    const now = Date.now();
    if (now < this.backoff.until) {
      throw new ProviderError(this.provider, `asked to wait until ${new Date(this.backoff.until).toISOString()}`, 429, this.backoff.until);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response | undefined;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: {
          ...this.headers,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status === 429) {
        await response.body?.cancel();
        this.backoff.until = Math.max(this.backoff.until, retryTime(response.headers.get("retry-after"), Date.now()));
        throw new ProviderError(this.provider, `asked to wait until ${new Date(this.backoff.until).toISOString()}`, 429, this.backoff.until);
      }
      let text: string;
      try {
        text = await readBoundedText(response, MAX_REPLY_BYTES);
      } catch {
        throw new ProviderError(this.provider, "the reply was too large or could not be read", response.status);
      }
      try {
        return { status: response.status, json: text ? JSON.parse(text) : null };
      } catch {
        throw new ProviderError(this.provider, `HTTP ${response.status} without a JSON reply`, response.status);
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(this.provider, controller.signal.aborted ? "the request timed out" : "the request failed; check the address and the network");
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel().catch(() => {});
    }
  }

  /** Text from a reply, without the credential this client sends, which a provider's error may repeat. */
  clean(text: string): string {
    return redact(text, Object.values(this.headers).map((value) => value.replace(/^Bearer /, "")));
  }
}

/** Removes every secret from text that may reach a page or a log. */
export function redact(text: string, secrets: string[]): string {
  let clean = text;
  for (const secret of secrets) if (secret) clean = clean.split(secret).join("[redacted]");
  return clean;
}
