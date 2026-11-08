/**
 * Nginx maps that define `$<prefix>_ip`: the address in `CF-Connecting-IP`
 * when Cloudflare set that header, and `fallback` otherwise. Cloudflare set it
 * when the connection came from one of its ranges, from cloudflared on this
 * server (a loopback peer on 80 or 443), or from CloudPanel's front server (a
 * loopback peer on another port, such as 8080) whose `X-Real-IP` names one of
 * those. Any other client's `CF-Connecting-IP` is ignored.
 */
export function cloudflareVisitorMaps(prefix: string, ranges: string[], fallback: string): string {
  const v = (name: string) => `$${prefix}_${name}`;
  const trusted = ["127.0.0.1", "::1", ...ranges];
  return `map $realip_remote_addr ${v("peer")} {
    "" $remote_addr;
    default $realip_remote_addr;
}
geo ${v("peer")} ${v("peer_kind")} {
    default direct;
    127.0.0.1 local;
    ::1 local;
${ranges.map((range) => `    ${range} cloudflare;`).join("\n")}
}
geo $http_x_real_ip ${v("forwarded_trusted")} {
    default 0;
${trusted.map((range) => `    ${range} 1;`).join("\n")}
}
map "${v("peer_kind")}:$server_port:${v("forwarded_trusted")}" ${v("cloudflare_set")} {
    default 0;
    ~^cloudflare: 1;
    ~^local:(80|443): 1;
    ~^local:[0-9]+:1$ 1;
}
map $http_cf_connecting_ip ${v("cf_header")} {
    default "";
    ~^[0-9A-Fa-f:.]+$ $http_cf_connecting_ip;
}
map "${v("cloudflare_set")}:${v("cf_header")}" ${v("ip")} {
    default ${fallback};
    ~^1:.+$ ${v("cf_header")};
}
`;
}
