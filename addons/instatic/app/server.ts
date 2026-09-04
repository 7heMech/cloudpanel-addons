import { instaticService } from "./service";
import { layout, dashboardView, newInstanceView } from "./views";

const PORT = Number(process.env.PORT || 39001);
const HOST = process.env.HOST || "127.0.0.1";

console.log(`[INFO] Starting CloudPanel Addons Instatic Manager on http://${HOST}:${PORT}`);

Bun.serve({
  port: PORT,
  hostname: HOST,

  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method;

    // Health check
    if (pathname === "/health") {
      return Response.json({ status: "ok", timestamp: new Date().toISOString() });
    }

    // Root redirects to /instatic
    if (pathname === "" || pathname === "/") {
      return Response.redirect(`${url.origin}/instatic`, 302);
    }

    // Dashboard
    if (pathname === "/instatic" && method === "GET") {
      const instances = await instaticService.listInstances();
      const nextPort = instaticService.getNextPort();
      const html = layout("Dashboard", dashboardView(instances, nextPort));
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // New Site
    if (pathname === "/instatic/new" && method === "GET") {
      const nextPort = instaticService.getNextPort();
      const tags = instaticService.getAvailableTags();
      const html = layout("New Instatic Site", newInstanceView(nextPort, tags));
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // --- REST APIs ---

    // GET /api/instances
    if (pathname === "/api/instances" && method === "GET") {
      const instances = await instaticService.listInstances();
      return Response.json({ ok: true, instances });
    }

    // POST /api/instances
    if (pathname === "/api/instances" && method === "POST") {
      try {
        const body = (await req.json()) as any;
        if (!body.domain || !body.tag) {
          return Response.json({ ok: false, error: "domain and tag are required" }, { status: 400 });
        }
        const result = await instaticService.createInstance(body);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      } catch (err: any) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    // Instance specific actions: /api/instances/:domain/:action
    const match = pathname.match(/^\/api\/instances\/([a-z0-9.-]+)\/([a-z]+)$/);
    if (match) {
      const [, domain, action] = match;

      if (action === "logs" && method === "GET") {
        const logs = await instaticService.getLogs(domain);
        return new Response(logs, { headers: { "Content-Type": "text/plain" } });
      }

      if (action === "update" && method === "POST") {
        const body = (await req.json()) as any;
        const result = await instaticService.updateInstance(domain, body.tag);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }

      if (action === "start" && method === "POST") {
        const result = await instaticService.startInstance(domain);
        return Response.json(result);
      }

      if (action === "stop" && method === "POST") {
        const result = await instaticService.stopInstance(domain);
        return Response.json(result);
      }

      if (action === "restart" && method === "POST") {
        const result = await instaticService.restartInstance(domain);
        return Response.json(result);
      }

      if (action === "delete" && method === "POST") {
        const result = await instaticService.deleteInstance(domain);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }

      if (action === "snapshot" && method === "POST") {
        const result = await instaticService.snapshotInstance(domain);
        return Response.json(result);
      }
    }

    return new Response("Not Found", { status: 404 });
  }
});
