// Local UI review with fictional data. Never starts the manager, reads panel
// state or invokes an action. Mutating requests are rejected deliberately.
import { indexPage } from "../cli/index";
import { dashboardView, layout as instaticLayout, newInstanceView, jobView as instaticJobView } from "../addons/instatic/app/views";
import { jobsView, jobView, layout as stagerLayout, newCloneView } from "../addons/stager/app/views";
import type { InstanceView, InstaticJobView } from "../addons/instatic/app/service";
import type { JobView, SiteDetail, SiteSummary } from "../addons/stager/app/service";
import type { AvailableTags } from "../addons/instatic/app/tags";
import { SECURITY_HEADERS } from "../lib/app-http";

const versions: AvailableTags = { tags: ["0.0.19", "0.0.18"], latest: "0.0.19", source: "registry" };
const instances: InstanceView[] = [
  { domain: "pages.example.com", port: 39000, tag: "0.0.19", state: "running" },
  { domain: "docs.example.com", port: 39001, tag: "0.0.18", state: "running" },
  { domain: "preview.example.com", port: 39002, tag: "0.0.18", state: "exited" },
].map((i) => ({ ...i, container: i.domain, siteUser: i.domain.split(".")[0]!, createdAt: "2026-09-10T09:30:00Z", panelSite: true }));
const sites: SiteSummary[] = [
  { domain: "www.example.com", siteType: "php", siteUser: "example", phpVersion: "8.2", application: "WordPress", databases: 1 },
  { domain: "static.example.com", siteType: "static", siteUser: "static", phpVersion: "", application: "Static HTML", databases: 0 },
  { domain: "pages.example.com", siteType: "reverse-proxy", siteUser: "pages", phpVersion: "", application: "Instatic", databases: 0 },
];
const job: JobView = {
  id: "preview-job", source: "www.example.com", target: "stg.example.com", port: 0,
  state: "done", step: "", error: "", panelSite: true,
  createdAt: "2026-09-10T09:30:00Z", startedAt: "2026-09-10T09:30:02Z", finishedAt: "2026-09-10T09:32:10Z",
  result: {
    siteType: "php", siteUser: "staging", phpVersion: "8.2", vhostTemplate: "WordPress",
    vhostCarried: true, vhostCarriedBy: "template", instatic: null,
    database: { source: "example", name: "staging", user: "staging", password: "preview-only-password" },
    notes: ["The source site's files and database were copied successfully."],
  },
};
const logs = "[09:30:02] Preparing staging site\n[09:30:16] Copying files\n[09:31:48] Importing database\n[09:32:10] Clone completed";

const instaticCreationJob: InstaticJobView = {
  id: "preview-instatic-job",
  domain: "blog.example.com",
  port: 39003,
  tag: "0.0.19",
  tls: true,
  state: "done",
  step: "instance created successfully",
  createdAt: "2026-09-10T09:30:00Z",
  startedAt: "2026-09-10T09:30:01Z",
  finishedAt: "2026-09-10T09:31:15Z",
};
const instaticLogs = "[instatic] creating CloudPanel reverse-proxy site for blog.example.com\n[instatic] preparing instance storage\n[instatic] pulling ghcr.io/corebunch/instatic:0.0.19\n[instatic] starting instatic-blog.example.com on 127.0.0.1:39003\n[instatic] waiting for health check\n[instatic] requesting a Let's Encrypt certificate for blog.example.com\n[instatic] instance created successfully";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT || 4100),
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method !== "GET") return Response.json({ ok: false, error: "UI preview only; no changes were made." }, { status: 409 });
    // These are the same two logo URLs the installed manager gets from its
    // CloudPanel origin. Only this development preview fetches the public demo.
    if (["/assets/images/logo.svg", "/assets/images/logo-dark.svg"].includes(path)) {
      const upstream = await fetch(`https://demo.cloudpanel.io${path}`);
      // fetch decodes compression; do not forward the original Content-Encoding.
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" },
      });
    }
    if (["/", "/dashboard"].includes(path)) return Response.redirect("/addons/");
    const empty = url.searchParams.has("empty");
    const notice = url.searchParams.has("update") ? { current: "0.9.3", latest: "0.9.4" } : null;
    const age = url.searchParams.has("stale") ? 7200 : 30;
    const state = url.searchParams.get("state");
    const currentJob: JobView = state && ["running", "failed", "queued"].includes(state)
      ? { ...job, state, result: null, finishedAt: "", step: "Copying files", error: state === "failed" ? "Could not copy the source files. The staging site was removed." : "" }
      : job;
    let html: string;
    if (path === "/addons/") return indexPage(empty ? [] : ["instatic", "stager"], notice);
    if (path === "/addons/instatic/") {
      html = instaticLayout("Instatic sites", dashboardView(empty ? [] : instances, 39003, age,
        sites.map((s) => ({ domain: s.domain, type: s.siteType, user: s.siteUser })), versions), notice);
    } else if (path === "/addons/instatic/new") {
      html = instaticLayout("New Instatic site", newInstanceView(39003, versions), notice);
    } else if (path === "/addons/instatic/jobs/preview-instatic-job") {
      html = instaticLayout("Creating blog.example.com", instaticJobView(instaticCreationJob, instaticLogs), notice);
    } else if (path.startsWith("/addons/instatic/api/") && path.endsWith("/creation-log")) {
      return Response.json({ ok: true, data: { domain: "pages.example.com", log: instaticLogs } });
    } else if (path.startsWith("/addons/instatic/api/") && path.endsWith("/logs")) {
      return Response.json({ ok: true, data: { logs: "Instatic listening on 127.0.0.1:39000\nReady to accept requests" } });
    } else if (path === "/addons/instatic/api/jobs/preview-instatic-job/events" || (path === "/addons/instatic/api/jobs/preview-instatic-job" && req.headers.get("accept")?.includes("text/event-stream"))) {
      if (server && typeof server.timeout === "function") {
        try { server.timeout(req, 0); } catch {}
      }
      return new Response(
        `data: ${JSON.stringify({ job: instaticCreationJob, log: instaticLogs })}\n\n`,
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            ...SECURITY_HEADERS,
          },
        },
      );
    } else if (path === "/addons/instatic/api/jobs/preview-instatic-job") {
      return Response.json({ ok: true, data: { job: instaticCreationJob, log: instaticLogs } });
    } else if (path === "/addons/stager/") {
      html = stagerLayout("Staging sites", jobsView(empty ? [] : [currentJob], age), notice);
    } else if (path === "/addons/stager/new") {
      const source = sites.find((s) => s.domain === url.searchParams.get("source"));
      const detail: SiteDetail | null = source ? {
        ...source, instatic: source.siteType === "reverse-proxy", rootDirectory: source.domain,
        database: source.databases ? "example" : "", sizeMb: 148,
      } : null;
      html = stagerLayout("New staging site", newCloneView(detail, empty ? [] : sites), notice);
    } else if (path === "/addons/stager/jobs/preview-job") {
      html = stagerLayout("Staging site details", jobView(currentJob, logs), notice);
    } else if (path === "/addons/stager/api/jobs/preview-job/events" || (path === "/addons/stager/api/jobs/preview-job" && req.headers.get("accept")?.includes("text/event-stream"))) {
      if (server && typeof server.timeout === "function") {
        try { server.timeout(req, 0); } catch {}
      }
      return new Response(
        `data: ${JSON.stringify({ job: { ...currentJob, state: "running", result: null }, log: logs })}\n\n`,
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            ...SECURITY_HEADERS,
          },
        },
      );
    } else if (path === "/addons/stager/api/jobs/preview-job") {
      return Response.json({ ok: true, data: { job: { ...currentJob, state: "running", result: null }, log: logs } });
    } else return new Response("Not found", { status: 404 });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  },
});
console.log(`UI preview (fictional data): ${server.url}addons/`);
