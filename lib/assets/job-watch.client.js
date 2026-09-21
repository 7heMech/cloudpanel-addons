
function jobElement(root, id) {
  const scope = root || CLP_ROOT;
  return scope.querySelector ? scope.querySelector('#' + id) : CLP_ROOT.getElementById(id);
}

function updateJobUI(job, log, root) {
  if (!job) return false;
  const state = jobElement(root, 'job-state');
  if (state) {
    state.textContent = job.state || '';
    state.className = 'badge state-' + (job.state || 'unknown');
  }
  const step = jobElement(root, 'job-step');
  if (step) step.textContent = job.step || '';
  const pre = jobElement(root, 'job-log');
  if (pre) {
    const details = pre.closest ? pre.closest('details') : null;
    if (details && !details.dataset.logBound) {
      details.dataset.logBound = 'true';
      details.addEventListener('toggle', function () {
        if (!details.open) details.dataset.userClosed = 'true';
        else delete details.dataset.userClosed;
      });
    }
    if (log !== undefined) {
      pre.textContent = log || '(no output yet)';
      pre.scrollTop = pre.scrollHeight;
      if (log && log.trim() && details && !details.open && !details.dataset.userClosed) {
        details.open = true;
      }
    }
  }
  return job.state === 'done' || job.state === 'failed';
}

function showJobReconnecting(root) {
  const state = jobElement(root, 'job-state');
  if (state) {
    state.textContent = 'reconnecting';
    state.className = 'badge state-queued';
  }
  const step = jobElement(root, 'job-step');
  if (step) step.textContent = 'The manager is restarting; waiting for it to come back…';
}

// The server sends {job, log}; tolerate the {data:{...}} envelope too, because
// the polling fallback reads the JSON reply from that same route.
function jobPayload(raw) {
  const body = raw && raw.data ? raw.data : raw;
  return body || {};
}

function watchJob(id, root) {
  let finished = false;
  // Reloading rather than patching the page: a finished job turns the progress
  // view into a result view, and the server already knows how to draw that.
  const done = function (close) {
    if (finished) return true;
    finished = true;
    if (close) close();
    location.reload();
    return true;
  };

  if (typeof EventSource !== 'undefined') {
    const es = new EventSource(CLP_BASE + '/api/jobs/' + encodeURIComponent(id) + '/events');
    es.onmessage = function (ev) {
      if (finished) return;
      try {
        const payload = jobPayload(JSON.parse(ev.data));
        if (updateJobUI(payload.job, payload.log, root)) done(function () { es.close(); });
      } catch (e) {}
    };
    es.addEventListener('restarting', function () {
      if (!finished) showJobReconnecting(root);
    });
    // The session went away under the stream. Reloading lands on the gate,
    // which sends the browser to the login page.
    es.addEventListener('unauthorized', function () {
      es.close();
      location.reload();
    });
    es.onerror = function () {
      if (finished) return;
      es.close();
      showJobReconnecting(root);
      waitForManager(id, done, root);
    };
    return;
  }
  pollJob(id, done, root);
}

function waitForManager(id, done, root) {
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try {
      const res = await fetch(CLP_BASE + '/health', {
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
      });
      // A session that lapsed during the restart is redirected to the login
      // page, which fetch follows and reports as a perfectly good 200. Waiting
      // for it would spin here forever; reloading lands on the gate instead.
      if (res.redirected) {
        stopped = true;
        location.reload();
        return;
      }
      const body = res.ok ? await res.json().catch(function () { return null; }) : null;
      if (body && body.ok === true) {
        stopped = true;
        pollJob(id, done, root);
        return;
      }
    } catch (e) {}
    setTimeout(tick, 1000);
  }
  tick();
}

function pollJob(id, done, root) {
  let stopped = false;
  async function tick() {
    if (stopped) return;
    try {
      const payload = jobPayload(await call('/api/jobs/' + encodeURIComponent(id)));
      if (updateJobUI(payload.job, payload.log, root)) {
        stopped = true;
        done(null);
        return;
      }
    } catch (e) {}
    setTimeout(tick, 2000);
  }
  tick();
}
