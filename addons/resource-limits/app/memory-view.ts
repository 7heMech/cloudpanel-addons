import type { PoolSiteState } from "../action";
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
 * What the profile gives each part of the server, and what is left for PHP.
 * MySQL and Redis are counted at the profile's sizes even while their switch
 * is off, since what they use then is not known here.
 */
function memoryBudget(state: Memory, sites: PoolSiteState[]): string {
  const { plan } = state;
  const parts: [string, number][] = [
    ["MySQL buffer pool", state.mysql.installed ? plan.bufferPoolMb : 0],
    ["MySQL temporary tables", state.mysql.installed ? plan.tempTableRamMb : 0],
    ["MySQL connections, at most", state.mysql.installed ? plan.maxConnections * CONNECTION_MB : 0],
    ["Redis", state.redis.installed ? plan.redisMb : 0],
    ["Varnish", state.varnishMb ?? 0],
    ["Memcached", state.memcachedMb ?? 0],
  ];
  const unknown = sites.filter((site) => site.memoryLimitMb === null).length;
  const unlimited = sites.filter((site) => site.memoryLimitMb === -1).length;
  const phpMb = sites.reduce((sum, site) => sum + (site.memoryLimitMb !== null && site.memoryLimitMb > 0 ? site.current.maxChildren * site.memoryLimitMb : 0), 0);
  parts.push(["PHP workers × memory_limit", phpMb]);
  const shown = parts.filter(([, mb]) => mb > 0);
  const left = plan.ramMb - shown.reduce((total, [, mb]) => total + mb, 0);
  const rows = shown.map(([name, mb]) => `
          <dt>${esc(name)}</dt><dd>${esc(size(mb))}</dd>`).join("");
  const rest = unknown || unlimited ? `<dt>Remaining budget</dt><dd>${badge("Unknown", "warn")} ${unlimited} site(s) have unlimited PHP memory; ${unknown} have no readable limit.</dd>` : left > 0 ? `<dt>Left for the OS and other processes</dt><dd>${esc(size(left))}</dd>`
    : `<dt>Left for the OS and other processes</dt><dd>${badge("None", "bad")} These add up to more than the server's ${esc(size(plan.ramMb))}.</dd>`;
  return `
      <details class="st-fold" id="memory-budget">
        <summary>Preview this profile's memory budget</summary>
        <p class="hint st-suggest">Assumes both MySQL sizing and Cap Redis are on. PHP uses each pool’s current worker limit × its CloudPanel memory_limit; this is an estimate of simultaneous request limits, not measured usage or a process memory cap. PHP extensions and other services need additional RAM.</p>
        <dl class="kv st-kv">
          <dt>RAM</dt><dd>${esc(size(plan.ramMb))}</dd>${rows}
          ${rest}
        </dl>
      </details>`;
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
