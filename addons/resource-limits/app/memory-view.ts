import { STOCK_PROFILE, type PoolSiteState } from "../action";
import { esc } from "../../../lib/app-http";
import { CONNECTION_MB, type MemoryProfile } from "../memory";
import type { ResourceMemoryState } from "../memory-settings";

interface Row {
  key: string;
  title: string;
  /** One paragraph, or a line each. */
  description: string | string[];
  /** The switch's state; a row with `control` instead has none. */
  checked?: boolean;
  disabled?: boolean;
  onchange?: string;
  /** What sits where the switch would, such as a select. */
  control?: string;
  extra?: string;
}

function settingRow(row: Row): string {
  const note = `tweak-note-${row.key}`;
  const control = row.control ?? `
            <label class="switch" title="${esc(row.title)}">
              <input type="checkbox" data-setting="${esc(row.key)}" onchange="${row.onchange}"${row.checked ? " checked" : ""}
                ${row.disabled ? "disabled " : ""}aria-label="${esc(row.title)}">
              <span></span>
            </label>`;
  return `
      <div class="tweak-row">
        <div class="tweak-body">
          <div class="tweak-heading">
            <h3>${esc(row.title)}<button class="tweak-more" type="button" aria-expanded="false"
              aria-controls="${note}" aria-label="What ${esc(row.title.toLowerCase())} does"
              onclick="toggleNote(this)"></button></h3>${control}
          </div>
          <div class="tweak-note" id="${note}">${[row.description].flat().map((line) => `<p>${esc(line)}</p>`).join("")}</div>${row.extra ?? ""}
        </div>
      </div>`;
}

function badge(text: string, tone: "ok" | "warn" | "bad" | "plain"): string {
  const state = { ok: " tone-ok", warn: " tone-warn", bad: " tone-bad", plain: "" }[tone];
  return `<span class="badge${state}">${esc(text)}</span>`;
}

type Memory = Exclude<ResourceMemoryState, { error: string }>;

const PROFILE_NAMES: Record<MemoryProfile, string> = { balanced: "Balanced", database: "Database-heavy", cache: "Cache-heavy" };

/** Whole GB above 10, one decimal below, MB under 1 GB. */
export function size(mb: number): string {
  if (mb < 1024) return `${mb} MB`;
  const gb = mb / 1024;
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

/**
 * One bar the size of RAM: what the profile gives each service, then PHP's
 * worst case, every site's worker limit × memory_limit at once, which runs off
 * the end when it does not fit. MySQL and Redis are counted at the profile's
 * sizes even while their switch is off.
 */
function memoryBudget(state: Memory, sites: PoolSiteState[]): string {
  const { plan } = state;
  const parts = [
    { name: "MySQL", tone: "s1", mb: state.mysql.installed ? plan.bufferPoolMb + plan.tempTableRamMb + plan.maxConnections * CONNECTION_MB : 0 },
    { name: "Redis", tone: "s2", mb: state.redis.installed ? plan.redisMb : 0 },
    { name: "Varnish", tone: "s3", mb: state.varnishMb ?? 0 },
    { name: "Memcached", tone: "s4", mb: state.memcachedMb ?? 0 },
  ].filter((part) => part.mb > 0);
  const servicesMb = parts.reduce((sum, part) => sum + part.mb, 0);
  const leftMb = Math.max(plan.ramMb - servicesMb, 0);
  const counted = sites.filter((site) => site.memoryLimitMb !== null && site.memoryLimitMb > 0);
  const worst = (site: PoolSiteState) => site.current.maxChildren * site.memoryLimitMb!;
  const phpMb = counted.reduce((sum, site) => sum + worst(site), 0);
  const overMb = servicesMb + phpMb - plan.ramMb;
  const over = overMb > 0;
  const php = { name: "PHP worst case", tone: "php", mb: over ? leftMb : phpMb };
  const blocks = [...parts, php].filter((part) => part.mb > 0).map((part) => `<span class="mb-part mb-${part.tone}${part === php && over ? " mb-over" : ""}" style="flex-grow:${part.mb / plan.ramMb}" title="${esc(`${part.name}: ${size(part === php ? phpMb : part.mb)}`)}"></span>`).join("");
  const free = over ? "" : `<span class="mb-part mb-free" style="flex-grow:${(leftMb - phpMb) / plan.ramMb}" title="${esc(`Free: ${size(leftMb - phpMb)}`)}"></span>`;
  const legend = [...parts, { ...php, mb: phpMb }].map((part) => `<li><i class="mb-${part.tone}"></i>${esc(part.name)} <b>${esc(size(part.mb))}</b></li>`).join("");
  const stock = counted.filter((site) => site.categoryId === null || site.drifted);
  const loose = stock.filter((site) => site.categoryId === null).length;
  const stockMb = stock.reduce((sum, site) => sum + worst(site), 0);
  const fix = loose === stock.length ? "put them in a category" : loose ? "put them in a category, or back in theirs below" : "put them back below";
  const biggest = [...Map.groupBy(counted.filter((site) => !stock.includes(site)), (site) => site.categoryName ?? "")]
    .map(([name, list]) => [name, list.reduce((sum, site) => sum + worst(site), 0)] as const).sort((a, b) => b[1] - a[1])[0];
  const why = servicesMb >= plan.ramMb
    ? "The services alone take more than RAM: choose another profile, or give Varnish or Memcached less."
    : stock.length
    ? `${size(stockMb)} of it is ${stock.length === 1 ? "1 site" : `${stock.length} sites`} on CloudPanel's ${STOCK_PROFILE.maxChildren} workers: ${stock.length === 1 ? fix.replace("them", "it").replace("theirs", "its") : fix}.`
    : biggest ? `Lower ${biggest[0]}'s worker limit, or its sites' memory_limit.` : "";
  const uncounted = sites.length - counted.length;
  const unknown = `${uncounted} ${uncounted === 1 ? "site has" : "sites have"} an unlimited or unreadable memory_limit and ${uncounted === 1 ? "is" : "are"} not counted.`;
  const verdict = over
    ? `${badge(`${size(overMb)} over`, "warn")} <span>${esc(why)}${uncounted ? ` ${esc(unknown)}` : ""}</span>`
    : uncounted
      ? `${badge("Unknown", "warn")} <span>${esc(unknown)}</span>`
      : `${badge("Fits", "ok")} <span>Every PHP worker at its memory_limit fits in RAM.</span>`;
  return `
      <div class="mb" id="memory-budget">
        <div class="mb-head"><span>Memory budget</span><b>${esc(size(plan.ramMb))} RAM</b></div>
        <div class="mb-bar${over ? " mb-bar-over" : ""}" role="img" aria-label="${esc(`${size(plan.ramMb)} RAM: ${[...parts, { ...php, mb: phpMb }].map((part) => `${part.name} ${size(part.mb)}`).join(", ")}`)}">${blocks}${free}</div>
        <ul class="mb-legend">${legend}</ul>
        <p class="mb-verdict">${verdict}</p>
      </div>`;
}

function mysqlMemoryLine(state: Memory): string {
  const { plan } = state;
  const numbers = `${size(plan.bufferPoolMb)} buffer pool, up to ${plan.maxConnections} connections`;
  if (!state.mysql.installed && !state.settings.mysql) return `${badge("Not installed", "plain")} <span>MySQL is not installed here.</span>`;
  if (state.settings.mysql && !state.mysql.inPlace) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  if (state.settings.mysql && state.mysql.pending) {
    return `${badge("Pending", "warn")} <span>${esc(numbers)} from MySQL's next restart: systemctl restart mysql.</span>`;
  }
  if (state.settings.mysql) return `${badge("On", "ok")} <span>${esc(numbers)}.</span>`;
  if (state.mysql.pending) return `${badge("Off", "plain")} <span>CloudPanel's values come back at MySQL's next restart.</span>`;
  return `${badge("Off", "plain")} <span>CloudPanel's fixed values, the same on every server.</span>`;
}

function redisMemoryLine(state: Memory): string {
  const redis = state.redis;
  if (!redis.installed && !state.settings.redis) return `${badge("Not installed", "plain")} <span>Redis is not installed here.</span>`;
  if (redis.problem) return `${badge("Unknown", "warn")} <span>${esc(redis.problem)}</span>`;
  const used = redis.usedMb === null ? "" : `Using ${size(redis.usedMb)}`;
  if (state.settings.redis && redis.capped) return `${badge("On", "ok")} <span>${esc(used)} of ${esc(size(state.plan.redisMb))}.</span>`;
  if (state.settings.redis) return `${badge("Not applied", "warn")} <span>${redis.maxmemoryMb === null ? "Redis is not running; the cap applies when it starts." : "Run clp-addons repair."}</span>`;
  if (redis.maxmemoryMb === null) return `${badge("Off", "plain")}`;
  return `${badge("Off", "plain")} <span>${esc(used)}${redis.maxmemoryMb ? `, with Redis's own limit of ${esc(size(redis.maxmemoryMb))}` : ", with no limit"}.</span>`;
}

function oomLine(state: Memory): string {
  if (state.oom.inPlace && state.settings.oom) return `${badge("On", "ok")} <span>A site's PHP is killed first.</span>`;
  if (state.settings.oom) return `${badge("Not applied", "warn")} <span>Run clp-addons repair.</span>`;
  return `${badge("Off", "plain")} <span>The kernel usually kills MySQL first, the largest process.</span>`;
}

export function memoryCard(state: ResourceMemoryState, sites: PoolSiteState[]): string {
  if ("error" in state) {
    return `
    <div class="card">
      <div class="card-header"><h2>Memory</h2></div>
      <div class="alert st-alert" role="alert">${esc(state.error)}</div>
    </div>`;
  }
  const select = `
            <select id="memory-profile" aria-label="Memory profile" data-current="${esc(state.settings.profile)}" onchange="setMemory(this)">${(Object.keys(PROFILE_NAMES) as MemoryProfile[])
    .map((profile) => `<option value="${profile}"${profile === state.settings.profile ? " selected" : ""}>${esc(PROFILE_NAMES[profile])}</option>`).join("")}</select>`;
  return `
    <div class="card">
      <div class="card-header"><h2>Memory</h2></div>
      <div class="tweak-list">${settingRow({
        key: "memoryProfile",
        title: "Memory profile",
        description: [
          "How MySQL and Redis share this server's RAM: Balanced, more for the database, or more for the cache. Only the sizing switches enabled below use this profile.",
          "Only a share is saved. The sizes are worked out again each time MySQL or Redis starts, so a server resized up or down gets new ones at its next boot.",
        ],
        control: select,
        extra: `${!state.settings.mysql && !state.settings.redis
          ? `<p class="st-status">${badge("Sizing off", "plain")} <span>The profile is saved; MySQL sizing and Cap Redis are both off.</span></p>` : ""}${memoryBudget(state, sites)}`,
      })}${settingRow({
        key: "memory-mysql",
        title: "Size MySQL to this server",
        description: [
          "Sets MySQL's buffer pool, connection limit and per-connection buffers from the profile. CloudPanel's fixed values let 512 connections of up to 34 MB each, more than a small server has.",
          "Applies at MySQL's next restart; Resource Limits never restarts it. More connections at once than the limit get Too many connections.",
        ],
        checked: state.settings.mysql,
        disabled: !state.mysql.installed && !state.settings.mysql,
        onchange: "setMemory(this)",
        extra: `<p class="st-status">${mysqlMemoryLine(state)}</p>`,
      })}${settingRow({
        key: "memory-redis",
        title: "Cap Redis",
        description: [
          "Limits Redis to the profile's share and, when full, evicts the keys used least recently, so a growing cache cannot run the server out of memory. Applies at once.",
          "Leave it off if a site keeps data in Redis it cannot lose, such as a job queue.",
        ],
        checked: state.settings.redis,
        disabled: !state.redis.installed && !state.settings.redis,
        onchange: "setMemory(this)",
        extra: `<p class="st-status">${redisMemoryLine(state)}</p>`,
      })}${settingRow({
        key: "memory-oom",
        title: "Protect MySQL and nginx when memory runs out",
        description: [
          "When the server runs out of memory, the kernel kills a site's PHP worker, which fails one request, instead of MySQL or nginx, which takes every site down.",
          "Independent of the memory profile and sizing switches above.",
        ],
        checked: state.settings.oom,
        onchange: "setMemory(this)",
        extra: `<p class="st-status">${oomLine(state)}</p>`,
      })}
      </div>
    </div>`;
}
