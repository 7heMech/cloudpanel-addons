// The job progress endpoint, shared by every addon that runs work as a
// background job.
//
// Stager and Instatic each had their own byte-identical copy of this. They were
// identical by accident rather than by contract, which is how one of them ended
// up polling a job read that took a lock the runner held for the whole job:
// there was no single place where "how a job is watched" was decided. There is
// now.
//
// The addon supplies only a reader. Everything about the wire format -- the
// poll interval, what counts as a change, when the stream closes, the keepalive
// -- lives here.
import type { Server } from "bun";
import { jsonResponse, policyHeaders, safeDecodePathSegment } from "./app-http";
import { validateJobId } from "./job-id";
import { stillAuthorized } from "./sso-auth";

/** How often the reader is asked for a fresh view of the job. */
const POLL_INTERVAL_MS = 1000;

/**
 * How many poll ticks pass between re-checks of the session.
 *
 * A stream is authorized once, when it opens, and then runs until the job ends.
 * What it sends is the job record, and a clone's record holds the database and
 * Instatic passwords it generated, so a session revoked mid-job would keep
 * receiving them. This bounds that to one interval.
 */
const AUTH_RECHECK_TICKS = 15;

/** The fields the stream itself reasons about; addons add their own alongside. */
export interface JobProgress {
  state: string;
  step: string;
  /** Optional one-shot SSE event name for client-side state transitions. */
  event?: string;
}

export interface JobSnapshot<J extends JobProgress = JobProgress> {
  job: J;
  log: string;
}

export interface JobReadResult<J extends JobProgress> {
  ok: boolean;
  data?: JobSnapshot<J>;
  error?: string;
}

export type JobReader<J extends JobProgress> = (id: string) => Promise<JobReadResult<J>>;

export interface JobApiRoute<J extends JobProgress> {
  req: Request;
  /** Path with the addon's mount prefix already stripped. */
  path: string;
  method: string;
  server?: Server<unknown> | null;
  getJob: JobReader<J>;
}

/**
 * Answer the two job-observation routes every addon has, or return null.
 *
 * `/api/jobs/:id/events` streams, `/api/jobs/:id` polls, and `/api/jobs/:id`
 * with `Accept: text/event-stream` streams too -- a client that cannot set a
 * path but can set a header still gets the live view. Choosing between them
 * was written out twice, character for character, in the Stager and Instatic
 * routers, which is how the two ended up with the same answer by coincidence
 * rather than by contract.
 *
 * Returns null for anything else, including a non-GET on these paths, so the
 * addon's own router decides what that is. The HTML `/jobs/:id` page stays with
 * each addon: what a job looks like is theirs, only how it is watched is shared.
 */
export async function jobApiRoute<J extends JobProgress>(route: JobApiRoute<J>): Promise<Response | null> {
  const events = route.path.match(/^\/api\/jobs\/([^/]+)\/events$/);
  const poll = route.path.match(/^\/api\/jobs\/([^/]+)$/);
  if (!events && !poll) return null;
  if (route.method !== "GET") return null;

  const id = validateJobId(safeDecodePathSegment((events ?? poll)![1]!));
  if (!id) return json({ ok: false, error: "not a valid job id" }, 400);

  const stream = events !== null || route.req.headers.get("accept")?.includes("text/event-stream") === true;
  if (stream) return jobEventStream({ id, req: route.req, server: route.server ?? null, getJob: route.getJob });

  const result = await route.getJob(id);
  return json(result, result.ok ? 200 : 404);
}

/** A job in one of these states will never change again, so the stream ends. */
export function isTerminalJobState(state: string): boolean {
  return state === "done" || state === "failed";
}

function json(body: unknown, status: number): Response {
  return jsonResponse(body, { status });
}

function sse(body: ReadableStream): Response {
  return new Response(body, {
    status: 200,
    headers: policyHeaders("text/event-stream", {
      // A stream's caching rules are its own: `no-store` would be honest but
      // `no-cache, no-transform` is what keeps a proxy from rewriting events.
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Nginx buffers proxied responses by default, which holds every event
      // until the job finishes -- exactly the symptom streaming exists to
      // avoid.
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

/**
 * Stream one job's state, step and log as server-sent events.
 *
 * Resolves to a JSON error response when the job cannot be read at all, so the
 * caller can return it directly either way.
 */
export async function jobEventStream<J extends JobProgress>(options: {
  id: string;
  req: Request;
  getJob: JobReader<J>;
  server?: Server<unknown> | null;
  /** Test-only; production always uses AUTH_RECHECK_TICKS. */
  recheckTicks?: number;
}): Promise<Response> {
  const { id, req, getJob, server } = options;
  const recheckTicks = options.recheckTicks ?? AUTH_RECHECK_TICKS;

  const initial = await getJob(id);
  if (!initial.ok || !initial.data) {
    return json({ ok: false, error: initial.error ?? "job not found" }, 404);
  }

  // Bun closes idle connections on its own schedule, and a job that is pulling
  // an image says nothing for minutes at a time. Opt this one response out.
  if (server && typeof server.timeout === "function") {
    try {
      server.timeout(req, 0);
    } catch {}
  }

  const first = initial.data;
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let inFlight = false;
  let lastState = first.job.state;
  let lastStep = first.job.step;
  let lastLog = first.log;
  let lastEvent = eventName(first.job);

  const stream = new ReadableStream({
    start(controller) {
      const stop = () => {
        closed = true;
        if (timer) clearInterval(timer);
      };
      // Every enqueue can throw once the client has gone away, and there is
      // nothing to do about it but stop polling.
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

      let ticks = 0;
      timer = setInterval(async () => {
        // A read goes through the gateway to the action binary, which can take
        // longer than the interval under load; overlapping them would queue up
        // processes behind a job that is already slow.
        if (closed || inFlight) return;
        inFlight = true;
        try {
          if (++ticks % recheckTicks === 0 && !(await stillAuthorized(req))) {
            send(`event: unauthorized\ndata: ${JSON.stringify({ error: "session is no longer valid" })}\n\n`);
            finish();
            return;
          }
          const res = await getJob(id);
          if (closed) return;
          if (!res.ok || !res.data) {
            send(`event: error\ndata: ${JSON.stringify({ error: res.error ?? "job not found" })}\n\n`);
            finish();
            return;
          }

          const { job, log } = res.data;
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
        } catch {
          // Transient read error; retry on the next tick.
        } finally {
          inFlight = false;
        }
      }, POLL_INTERVAL_MS);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });

  return sse(stream);
}
