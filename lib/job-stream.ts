import { errorMessage } from "./errors";
import { jsonResponse, policyHeaders, safeDecodePathSegment } from "./app-http";
import { streamGatewayAction, type ActionResult, type GatewayStream } from "./gateway-client";
import type { GatewayAddon, StreamVerb } from "./gateway-protocol";
import { isTerminalJobState, validateJobId } from "./job-id";
import { stillAuthorized } from "./sso-auth";

export { isTerminalJobState } from "./job-id";

const POLL_INTERVAL_MS = 1000;
const KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * A stream is authorized once, when it opens, and then runs until the job ends.
 * What it sends is the job record, and a clone's record holds the database and
 * Instatic passwords it generated, so a session revoked mid-job would keep
 * receiving them. This bounds that to one interval.
 */
const AUTH_RECHECK_MS = 15_000;

export interface JobProgress {
  state: string;
  step: string;
  /** A one-shot SSE event name for client-side state transitions. */
  event?: string;
}

interface JobSnapshot<J extends JobProgress = JobProgress> {
  job: J;
  log: string;
}

interface JobReadResult<J extends JobProgress> {
  ok: boolean;
  data?: JobSnapshot<J>;
  error?: string;
}

type JobReader<J extends JobProgress> = (id: string) => Promise<JobReadResult<J>>;

export type JobWatcher<J extends JobProgress> = (
  id: string,
  handlers: {
    onSnapshot: (snapshot: JobSnapshot<J>) => void;
    onClose: (error?: string) => void;
  },
) => { close(): void };

type JobAddon = { [A in GatewayAddon]: "watch-job" extends StreamVerb<A> ? A : never }[GatewayAddon];

export function watchGatewayJob<J extends JobProgress>(
  addon: JobAddon,
  id: string,
  handlers: Parameters<JobWatcher<J>>[1],
): GatewayStream {
  let ended = false;
  const close = (error?: string) => {
    if (ended) return;
    ended = true;
    handlers.onClose(error);
  };
  return streamGatewayAction({
    addon,
    verb: "watch-job",
    args: ["--job", id],
    onReply(reply: ActionResult<JobSnapshot<J>>) {
      if (reply.ok && reply.data) handlers.onSnapshot(reply.data);
      else close(reply.error ?? "the gateway returned an empty job snapshot");
    },
    onClose: close,
  });
}

interface JobApiRoute<J extends JobProgress> {
  req: Request;
  /** Path with the addon's mount prefix already stripped. */
  path: string;
  method: string;
  /** Also admit site managers when rechecking this addon's stream. */
  siteManager?: boolean;
  getJob: JobReader<J>;
  watchJob?: JobWatcher<J>;
}

/**
 * `/api/jobs/:id` with `Accept: text/event-stream` streams too: a client that
 * cannot set a path but can set a header still gets the live view.
 */
export async function jobApiRoute<J extends JobProgress>(route: JobApiRoute<J>): Promise<Response | null> {
  const events = route.path.match(/^\/api\/jobs\/([^/]+)\/events$/);
  const poll = route.path.match(/^\/api\/jobs\/([^/]+)$/);
  if (!events && !poll) return null;
  if (route.method !== "GET") return null;

  const id = validateJobId(safeDecodePathSegment((events ?? poll)![1]!));
  if (!id) return jsonResponse({ ok: false, error: "not a valid job id" }, 400);

  const stream = events !== null || route.req.headers.get("accept")?.includes("text/event-stream") === true;
  if (stream) {
    return jobEventStream({
      id,
      req: route.req,
      siteManager: route.siteManager,
      getJob: route.getJob,
      watchJob: route.watchJob,
    });
  }

  const result = await route.getJob(id);
  return jsonResponse(result, result.ok ? 200 : 404);
}

function sse(body: ReadableStream): Response {
  return new Response(body, {
    status: 200,
    headers: policyHeaders("text/event-stream", {
      // `no-transform` keeps a proxy from rewriting events.
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Nginx buffers proxied responses by default, which would hold every
      // event until the job finishes.
      "X-Accel-Buffering": "no",
    }),
  });
}

function eventName<J extends JobProgress>(job: J): string | null {
  return typeof job.event === "string" && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(job.event)
    ? job.event
    : null;
}

function eventData<J extends JobProgress>(job: J, log: string, event: string | null): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify({ job, log })}\n\n`;
}

export async function jobEventStream<J extends JobProgress>(options: {
  id: string;
  req: Request;
  getJob: JobReader<J>;
  watchJob?: JobWatcher<J>;
  recheckMs?: number;
  siteManager?: boolean;
  stillAuthorized?: typeof stillAuthorized;
}): Promise<Response> {
  const { id, req, getJob, watchJob } = options;
  const recheckMs = options.recheckMs ?? AUTH_RECHECK_MS;
  const recheck = options.stillAuthorized ?? stillAuthorized;

  const initial = await getJob(id);
  if (!initial.ok || !initial.data) {
    return jsonResponse({ ok: false, error: initial.error ?? "job not found" }, 404);
  }

  const first = initial.data;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let authTimer: ReturnType<typeof setInterval> | null = null;
  let watcher: ReturnType<JobWatcher<J>> | null = null;
  let closed = false;
  let inFlight = false;
  let authInFlight = false;
  let lastState = first.job.state;
  let lastStep = first.job.step;
  let lastLog = first.log;
  let lastEvent = eventName(first.job);

  const stream = new ReadableStream({
    start(controller) {
      const clearResources = () => {
        if (pollTimer) clearInterval(pollTimer);
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        if (authTimer) clearInterval(authTimer);
        pollTimer = null;
        keepaliveTimer = null;
        authTimer = null;
        if (watcher) {
          const current = watcher;
          watcher = null;
          try { current.close(); } catch {}
        }
      };
      const stop = () => {
        closed = true;
        clearResources();
      };
      const send = (chunk: string): boolean => {
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          stop();
          return false;
        }
      };
      const finish = () => {
        stop();
        try {
          controller.close();
        } catch {}
      };

      if (!send(eventData(first.job, first.log, lastEvent))) return;
      if (isTerminalJobState(first.job.state)) {
        finish();
        return;
      }

      const sendSnapshot = (snapshot: JobSnapshot<J>) => {
        if (closed) return;
        const { job, log } = snapshot;
        const nextEvent = eventName(job);
        if (job.state !== lastState || job.step !== lastStep || log !== lastLog || nextEvent !== lastEvent) {
          const emittedEvent = nextEvent !== lastEvent ? nextEvent : null;
          lastState = job.state;
          lastStep = job.step;
          lastLog = log;
          lastEvent = nextEvent;
          if (!send(eventData(job, log, emittedEvent))) return;
        } else if (!send(": keepalive\n\n")) {
          return;
        }
        if (isTerminalJobState(job.state)) finish();
      };

      const checkAuthorization = async () => {
        if (closed || authInFlight) return;
        authInFlight = true;
        try {
          const auth = await recheck(req, { siteManager: options.siteManager });
          if (auth === false) {
            send(`event: unauthorized\ndata: ${JSON.stringify({ error: "session is no longer valid" })}\n\n`);
            finish();
          }
        } catch {} finally {
          authInFlight = false;
        }
      };

      authTimer = setInterval(() => { void checkAuthorization(); }, recheckMs);

      if (watchJob) {
        keepaliveTimer = setInterval(() => {
          if (!closed) send(": keepalive\n\n");
        }, KEEPALIVE_INTERVAL_MS);
        try {
          watcher = watchJob(id, {
            onSnapshot: sendSnapshot,
            onClose(error) {
              if (closed) return;
              if (error) send(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
              finish();
            },
          });
          if (closed) watcher.close();
        } catch (error) {
          const message = errorMessage(error);
          if (send(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`)) finish();
        }
        return;
      }

      pollTimer = setInterval(async () => {
        if (closed || inFlight) return;
        inFlight = true;
        try {
          const res = await getJob(id);
          if (closed) return;
          if (!res.ok || !res.data) {
            send(`event: error\ndata: ${JSON.stringify({ error: res.error ?? "job not found" })}\n\n`);
            finish();
            return;
          }
          sendSnapshot(res.data);
        } catch {} finally {
          inFlight = false;
        }
      }, POLL_INTERVAL_MS);
    },
    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (authTimer) clearInterval(authTimer);
      pollTimer = null;
      keepaliveTimer = null;
      authTimer = null;
      if (watcher) {
        const current = watcher;
        watcher = null;
        try { current.close(); } catch {}
      }
    },
  });

  return sse(stream);
}
