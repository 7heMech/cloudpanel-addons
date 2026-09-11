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
import { SECURITY_HEADERS } from "./app-http";

/** How often the reader is asked for a fresh view of the job. */
const POLL_INTERVAL_MS = 1000;

/** The fields the stream itself reasons about; addons add their own alongside. */
export interface JobProgress {
  state: string;
  step: string;
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

/** A job in one of these states will never change again, so the stream ends. */
export function isTerminalJobState(state: string): boolean {
  return state === "done" || state === "failed";
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS },
  });
}

function sse(body: ReadableStream): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // Nginx buffers proxied responses by default, which holds every event
      // until the job finishes -- exactly the symptom streaming exists to
      // avoid.
      "X-Accel-Buffering": "no",
      ...SECURITY_HEADERS,
    },
  });
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
}): Promise<Response> {
  const { id, req, getJob, server } = options;

  const initial = await getJob(id);
  if (!initial.ok || !initial.data) {
    return jsonResponse({ ok: false, error: initial.error ?? "job not found" }, 404);
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

      if (!send(`data: ${JSON.stringify({ job: first.job, log: first.log })}\n\n`)) return;
      if (isTerminalJobState(first.job.state)) {
        finish();
        return;
      }

      timer = setInterval(async () => {
        // A read goes through the gateway to the action binary, which can take
        // longer than the interval under load; overlapping them would queue up
        // processes behind a job that is already slow.
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

          const { job, log } = res.data;
          if (job.state !== lastState || job.step !== lastStep || log !== lastLog) {
            lastState = job.state;
            lastStep = job.step;
            lastLog = log;
            if (!send(`data: ${JSON.stringify({ job, log })}\n\n`)) return;
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
