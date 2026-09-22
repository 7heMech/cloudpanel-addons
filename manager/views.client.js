
function managerJobCard(source, key, standalone) {
  const fromSource = source && typeof source.closest === 'function'
    ? source.closest('[data-manager-job-card]')
    : null;
  if (fromSource) return fromSource;
  if (!key) return null;
  const owner = Array.from(CLP_ROOT.querySelectorAll('[data-manager-job-card]')).find(function (candidate) {
    return candidate.getAttribute('data-manager-job-card') === key;
  }) || null;
  if (owner || !standalone) return owner;

  const card = document.createElement('article');
  card.className = 'card';
  card.setAttribute('data-manager-job-card', key);
  // Where the server puts a job no card claims: under the heading and above the
  // cards, not below everything else the page has to show.
  const heading = CLP_ROOT.querySelector('.page-heading');
  if (heading && heading.parentNode) heading.parentNode.insertBefore(card, heading.nextSibling);
  else {
    const parent = CLP_ROOT.querySelector('main') || CLP_ROOT.body || CLP_ROOT;
    if (parent && typeof parent.appendChild === 'function') parent.appendChild(card);
  }
  return card;
}

function describeManagerJob(job) {
  if (!job) return 'Working';
  if (job.kind === 'update') return 'Updating clp-addons';
  return (job.kind === 'disable' ? 'Disabling ' : 'Enabling ') + (job.addon || 'an addon');
}

function showJob(title, card) {
  if (!card) return;
  let status = card.querySelector('[data-manager-job-status]');
  if (!status) {
    status = document.createElement('div');
    status.className = 'manager-job-status';
    status.setAttribute('data-manager-job-status', '');
    status.setAttribute('aria-live', 'polite');
    status.innerHTML = '<div class="job-summary">' +
      '<strong id="job-title"></strong>' +
      '<span class="badge state-queued" id="job-state">queued</span>' +
      '</div>' +
      '<p class="step" id="job-step">Starting…</p>' +
      '<details class="job-log-details"><summary>Output</summary><pre id="job-log">(no output yet)</pre></details>';
    card.appendChild(status);
  }
  status.hidden = false;
  const heading = status.querySelector('#job-title');
  if (heading && title) heading.textContent = title;
  const state = status.querySelector('#job-state');
  if (state) {
    state.textContent = 'queued';
    state.className = 'badge state-queued';
  }
  const step = status.querySelector('#job-step');
  if (step) step.textContent = 'Starting…';
}

// Every one of these restarts the manager, so the reply we are waiting for is
// only ever a job id: the outcome arrives through the job record, which
// survives the restart that kills this page's connection.
async function startManagerJob(path, title, source, key) {
  const card = managerJobCard(source, key);
  busy(true);
  try {
    const res = await call(path, { method: 'POST' });
    const id = res.data && res.data.jobId;
    if (!id) throw new Error('the manager did not start a job');
    // A duplicate request follows the job that is already running. Its owner
    // is authoritative; the clicked card is only for a newly created job.
    const existing = res.data.existing === true;
    const running = existing ? res.data.job : null;
    const jobKey = running && running.kind === 'update' ? 'update' : (running && running.addon) || 'manager-job';
    const jobCard = existing ? managerJobCard(null, jobKey, true) : card;
    showJob(existing ? describeManagerJob(running) : title, jobCard);
    watchJob(id, jobCard);
  } catch (err) {
    busy(false);
    // In the page rather than in a modal the browser owns, which would cover
    // the card it is talking about and lose it on dismissal.
    notify(err.message, 'error');
  }
}

function enableAddon(name, source) {
  clearNotice();
  startManagerJob('/api/addons/' + encodeURIComponent(name) + '/enable', 'Enabling ' + name, source, name);
}

// The same dialog every addon uses for a decision an operator has to make, so
// disabling one reads the way turning on global maintenance does. The browser's
// confirm() said the same words in a box this project does not style, cannot
// carry a details list in, and which reads as the page having gone wrong.
async function disableAddon(name, title, source) {
  const accepted = await confirmAction({
    // The name the card shows, not the slug the route takes: an operator
    // reading "Disable instatic?" under a card headed "Instatic CMS" has to
    // stop and match them up.
    title: 'Disable ' + (title || name) + '?',
    text: 'It stops appearing in CloudPanel and its pages stop answering.',
    details: [
      'Nothing it created is deleted: its data is kept and enabling it again returns the same instances.',
      // Double-quoted because of the apostrophe: this is JavaScript inside a
      // TypeScript template literal, where a backslash escape is eaten before
      // the browser ever sees it.
      "Anything it injected into CloudPanel's own pages is removed.",
    ],
    confirmLabel: 'Disable',
    danger: true,
  });
  if (!accepted) return;
  clearNotice();
  startManagerJob('/api/addons/' + encodeURIComponent(name) + '/disable', 'Disabling ' + name, source, name);
}

function updateNow(source) {
  startManagerJob('/api/update', 'Updating clp-addons', source, 'update');
}

// A failure is worth showing once. Remembering the dismissal by job id keeps it
// from reappearing on every visit without needing the server to record that
// somebody has read it.
function dismissFailure(id) {
  try { localStorage.setItem('clp-addons-seen-job', id); } catch (e) {}
  const alertBox = document.getElementById('job-failure');
  if (alertBox) alertBox.remove();
}

(function () {
  const alertBox = document.getElementById('job-failure');
  if (!alertBox) return;
  let seen = null;
  try { seen = localStorage.getItem('clp-addons-seen-job'); } catch (e) {}
  if (seen === alertBox.getAttribute('data-job')) alertBox.remove();
})();
