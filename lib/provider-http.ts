import { readBoundedText } from "./app-http";

export type ApiFetch = (url: string, init: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  constructor(readonly provider: string, message: string, readonly status = 0, readonly retryAt = 0) {
    super(`${provider}: ${message}`);
  }
}

export class ProviderHttp {
  retryAt: number;
  constructor(
    readonly provider: string,
    private readonly base: string,
    private readonly headers: Record<string, string>,
    private readonly fetcher: ApiFetch = fetch,
    retryAt = 0,
    private readonly timeoutMs = 15_000,
  ) { this.retryAt = retryAt; }

  async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    if (Date.now() < this.retryAt) throw new ProviderError(this.provider, "rate limited; waiting for the provider's retry time", 429, this.retryAt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.base}${path}`, {
        method, headers: { ...this.headers, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal, redirect: "error",
      });
      if (response.status === 429) {
        const retry = response.headers.get("retry-after") ?? "";
        const seconds = /^\d+$/.test(retry) ? Number(retry) : null;
        const at = seconds === null ? Date.parse(retry) : Date.now() + seconds * 1000;
        this.retryAt = Number.isFinite(at) && (seconds !== null && seconds >= 0 || at > Date.now()) ? at : Date.now() + 300_000;
        await response.body?.cancel();
        throw new ProviderError(this.provider, "rate limited; waiting for the provider's retry time", 429, this.retryAt);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(this.provider, `HTTP ${response.status}; check credentials, permissions and provider availability`, response.status);
      }
      let raw: string;
      try { raw = await readBoundedText(response, 2 * 1024 * 1024); }
      catch { throw new ProviderError(this.provider, "response exceeded the size limit or could not be read"); }
      try { return JSON.parse(raw); }
      catch { throw new ProviderError(this.provider, "response was not JSON"); }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(this.provider, controller.signal.aborted ? "request timed out" : "request failed; check the HTTPS endpoint and connectivity");
    } finally { clearTimeout(timer); }
  }
}
