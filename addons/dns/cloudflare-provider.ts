/**
 * Cloudflare implementation of `DnsProvider`, wrapping the shared
 * `lib/cloudflare/api.ts` client and exposing Cloudflare Single Redirect
 * rules through `.edge`.
 */
import { CloudflareApi } from "../../lib/cloudflare/api";
import { readTokenAccess } from "../../lib/cloudflare/store";
import { errorMessage } from "../../lib/errors";
import type { ApiFetch } from "../../lib/provider-http";
import type {
  CloudflareEdgeClient, DnsProvider, DnsRecord, DnsZone, ProviderCapabilities, ProviderCheckResult, RecordOp,
} from "./provider";

export const CLOUDFLARE_CAPABILITIES: ProviderCapabilities = {
  proxy: true,
  edgeRedirects: true,
  createZone: true,
  autoTtl: true,
  comments: true,
};

export class CloudflareDnsProvider implements DnsProvider {
  readonly kind = "cloudflare" as const;
  readonly capabilities = CLOUDFLARE_CAPABILITIES;
  readonly defaultTtl = 1;
  readonly api: CloudflareApi;
  readonly edge: CloudflareEdgeClient;

  constructor(token: string, fetcher?: ApiFetch, backoff?: { until: number }) {
    this.api = new CloudflareApi(token, fetcher, backoff);
    this.edge = {
      entrypoint: (zoneId, phase) => this.api.entrypoint(zoneId, phase),
      createEntrypoint: (zoneId, phase, rules) => this.api.createEntrypoint(zoneId, phase, rules),
      addRule: (zoneId, phase, rulesetId, rule) => this.api.addRule(zoneId, phase, rulesetId, rule),
      updateRule: (zoneId, phase, rulesetId, ruleId, rule) => this.api.updateRule(zoneId, phase, rulesetId, ruleId, rule),
      deleteRule: (zoneId, phase, rulesetId, ruleId) => this.api.deleteRule(zoneId, phase, rulesetId, ruleId),
    };
  }

  async discover(readTokens = false): Promise<ProviderCheckResult> {
    try {
      const verified = await this.api.verify();
      if (!verified.active) {
        return {
          active: false,
          status: verified.status,
          accounts: [],
          zones: [],
          error: `Cloudflare reports this token as ${verified.status}`,
        };
      }
      const [zones, accounts] = await Promise.all([this.api.zones(), this.api.accounts()]);
      const known = new Map(accounts.map((account) => [account.id, account]));
      for (const zone of zones) if (!known.has(zone.account.id)) known.set(zone.account.id, zone.account);
      const token = readTokens
        ? await readTokenAccess(this.api, verified, {
          zones: zones.map((zone) => ({ id: zone.id, name: zone.name, accountId: zone.account.id })),
          accounts: [...known.values()],
        })
        : undefined;
      return {
        active: true,
        status: verified.status,
        accounts: [...known.values()],
        zones,
        error: null,
        ...(token ? { token } : {}),
      };
    } catch (error) {
      return { active: false, status: "error", accounts: [], zones: [], error: errorMessage(error) };
    }
  }

  listZones(): Promise<DnsZone[]> {
    return this.api.zones();
  }

  createZone(name: string, accountId?: string): Promise<DnsZone> {
    if (!accountId) throw new Error("Cloudflare zone creation requires an account identifier");
    return this.api.createZone(accountId, name);
  }

  listRecords(zone: DnsZone): Promise<DnsRecord[]> {
    return this.api.records(zone.id);
  }

  async applyRecords(
    zone: DnsZone,
    ops: RecordOp[],
    currentRecords: DnsRecord[],
    options: { comment?: string; onApplied?: (op: RecordOp, records: DnsRecord[]) => void } = {},
  ): Promise<DnsRecord[]> {
    let records = [...currentRecords];
    const comment = options.comment ?? "";
    for (const op of ops) {
      if (op.action === "delete") {
        await this.api.deleteRecord(zone.id, op.current!.id);
        records = records.filter((record) => record.id !== op.current!.id);
      } else if (op.action === "update") {
        const updated = await this.api.updateRecord(zone.id, op.current!.id, op.record);
        records = records.map((current) => current.id === updated.id ? updated : current);
      } else {
        const created = await this.api.createRecord(zone.id, op.record, comment);
        records = [...records, created];
      }
      options.onApplied?.(op, records);
    }
    return records;
  }

  refusedPermissions(): string[] {
    return [...this.api.refused];
  }
}
