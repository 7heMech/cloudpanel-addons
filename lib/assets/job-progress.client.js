// A background job that works through sites draws a progress bar, from the
// server on every load and repaint (`jobProgressHtml`), and this follows each
// one until it ends: a reload finds the job in the page again, and nothing else
// on the page waits for it. Server-sent events with polling where they cannot
// be had or drop.
const followedJobs = new Set();

// Follow every bar on the page not already followed. `onFinished(job)` runs
// once, when the job is done or failed; `onUpdate(job)`, if given, after each
// update is painted.
function followJobProgress(onFinished, onUpdate) {
  CLP_ROOT.querySelectorAll('.job-progress[data-job]').forEach(function (element) {
    const id = element.dataset.job;
    if (!id || followedJobs.has(id)) return;
    followedJobs.add(id);
    followJobStream(id, function (job) {
      paintJobProgress(job);
      if (onUpdate) onUpdate(job);
    }, onFinished);
  });
}

// "12 of 40: site" beside the bar's title; the server writes the same.
function jobProgressText(job) {
  const count = job.total ? Math.min(job.completed + 1, job.total) + ' of ' + job.total + ': ' : '';
  return job.state === 'queued' ? 'Waiting to start' : job.site ? count + job.site : job.step;
}

function paintJobProgress(job) {
  const element = CLP_ROOT.querySelector('.job-progress[data-job="' + CSS.escape(job.id) + '"]');
  if (!element) return;
  const bar = element.querySelector('.job-progress-bar');
  const step = element.querySelector('.job-progress-step');
  if (bar) {
    bar.max = Math.max(job.total, 1);
    if (job.total) bar.value = job.completed; else bar.removeAttribute('value');
  }
  if (step) step.textContent = jobProgressText(job);
}

function followJobStream(id, update, onFinished) {
  let finished = false;
  const receive = function (job) {
    if (finished || !job) return;
    update(job);
    if (job.state !== 'done' && job.state !== 'failed') return;
    finished = true;
    onFinished(job);
  };
  const poll = async function () {
    while (!finished) {
      try {
        receive((await call('/api/jobs/' + encodeURIComponent(id))).data.job);
      } catch (error) {
        // A manager restarting answers again shortly.
      }
      if (!finished) await new Promise(function (resolve) { setTimeout(resolve, 2000); });
    }
  };
  if (typeof EventSource === 'undefined') { poll(); return; }
  const events = new EventSource(CLP_BASE + '/api/jobs/' + encodeURIComponent(id) + '/events');
  events.onmessage = function (event) {
    try { receive(JSON.parse(event.data).job); } catch (error) {}
    if (finished) events.close();
  };
  // The session ended under the stream; the job carries on without the page.
  events.addEventListener('unauthorized', function () {
    finished = true;
    events.close();
    notify('Your panel session ended. Sign in again to follow the job.', 'error');
  });
  events.onerror = function () {
    events.close();
    if (!finished) poll();
  };
}
