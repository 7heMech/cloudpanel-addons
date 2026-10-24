import { expect, test } from "bun:test";

test("Cloudflare preview mutations persist for API reads but reset on a new fixture page", async () => {
  const portProbe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = portProbe.port!;
  portProbe.stop(true);
  const server = Bun.spawn([process.execPath, "tools/preview-ui.ts"], {
    env: { ...process.env, PORT: String(port) }, stdout: "ignore", stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}/addons/cloudflare-ips/`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(base)).ok; } catch {}
      if (ready) break;
      await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    const response = await fetch(`${base}api/protection`, {
      method: "POST", headers: { "Content-Type": "application/json", Referer: base }, body: JSON.stringify({ enabled: false }),
    });
    expect(response.ok).toBe(true);
    const state = await (await fetch(`${base}api/sites`, { headers: { Referer: base } })).json() as { data: { protection: { wanted: boolean } } };
    expect(state.data.protection.wanted).toBe(false);
    const empty = await (await fetch(`${base}?empty`)).text();
    expect(empty.match(/<p id="cf-summary">([^<]*)<\/p>/)?.[1]).toBe("No sites found in CloudPanel.");
    const none = await (await fetch(`${base}?sites=none`)).text();
    expect(none.match(/<p id="cf-summary">([^<]*)<\/p>/)?.[1]).toBe("0 of 4 sites allow Cloudflare only.");
  } finally { server.kill(); await server.exited; }
}, 10_000);
