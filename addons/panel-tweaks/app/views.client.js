
async function setTweak(input) {
  const key = input.dataset.tweak;
  const wanted = input.checked;
  clearNotice();
  busy(true);
  try {
    const reply = await call('/api/tweaks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: wanted }),
    });
    input.closest('.tweak-row').classList.toggle('is-enabled', wanted);
    const frame = document.getElementById('preview-frame');
    if (frame) frame.src = CLP_BASE + '/preview?refresh=' + Date.now();
    busy(false);
    // After busy(), which restores every control to what it was disabled as.
    syncDependents(key, wanted);
    if (key === 'diskUsage' && wanted) {
      const button = input.closest('.tweak-row').querySelector('.tweak-scan .btn');
      if (button) { await measureNow(button); return; }
    }
    notify('Saved.', 'ok');
  } catch (error) {
    // A reply carrying data saved the switch and failed to write the panel's
    // copy of it, so putting the switch back would show the opposite of what
    // is stored.
    if (error.data) {
      input.closest('.tweak-row').classList.toggle('is-enabled', wanted);
      busy(false);
      syncDependents(key, wanted);
    } else {
      input.checked = !wanted;
      busy(false);
    }
    notify(error.message, 'error');
  }
}

// A nested switch follows its parent: the action turns it off with the parent,
// and it cannot be reached again until the parent is back on.
function syncDependents(key, on) {
  for (const child of document.querySelectorAll('[data-tweak-parent="' + key + '"]')) {
    child.disabled = !on;
    if (on || !child.checked) continue;
    child.checked = false;
    child.closest('.tweak-row').classList.remove('is-enabled');
  }
}

// A measurement runs as a background job. Its progress takes the summary's
// place in the row, and the shared job progress script follows it until it
// ends, after a reload too. Pressing the button while one runs, in another tab
// say, follows that one.
async function measureNow(button) {
  clearNotice();
  button.disabled = true;
  try {
    const reply = await call('/api/measure', { method: 'POST' });
    followMeasurement(reply.data.job);
    notify(reply.data.attached
      ? 'A measurement was already running; this follows it.'
      : 'Measuring. It runs in the background, so you can keep using the page or reload it.', 'ok');
  } catch (error) {
    button.disabled = false;
    notify(error.message, 'error');
  }
}

function measureControls() {
  const scan = document.querySelector('.tweak-scan');
  return scan && {
    summary: scan.querySelector('.tweak-scan-summary'),
    progress: scan.querySelector('.job-progress'),
    button: scan.querySelector('.btn'),
  };
}

function followMeasurement(job) {
  const parts = measureControls();
  if (!parts) return;
  parts.progress.dataset.job = job.id;
  parts.progress.hidden = false;
  parts.summary.hidden = true;
  parts.button.disabled = true;
  parts.button.textContent = 'Measuring…';
  paintJobProgress(job);
  followJobProgress(measurementFinished);
}

function measurementFinished(job) {
  const parts = measureControls();
  if (parts) {
    parts.progress.hidden = true;
    parts.progress.dataset.job = '';
    parts.summary.hidden = false;
    parts.button.disabled = false;
    parts.button.textContent = 'Measure now';
  }
  if (job.state !== 'done' || !job.result) {
    notify('The measurement failed: ' + (job.error || job.step), 'error');
    return;
  }
  const result = job.result;
  const total = result.measured + result.skipped;
  if (parts) parts.summary.textContent = result.measured + ' of ' + total +
    ' site' + (total === 1 ? '' : 's') + ' measured, just now.';
  const sitesTable = document.querySelector('[data-tweak="sitesTable"]');
  const frame = document.getElementById('preview-frame');
  if (sitesTable && sitesTable.checked && frame) frame.src = CLP_BASE + '/preview?refresh=' + Date.now();
  const skipped = result.skipped ? ', ' + result.skipped + ' skipped' : '';
  notify(result.measured + (result.measured === 1 ? ' site measured' : ' sites measured') + skipped + '.', 'ok');
}

// Only the desktop Phone preview adds an inner gutter; an actual phone uses
// the surrounding page's padding.
const previewMobileScreen = window.matchMedia('(max-width: 760px)');

function syncPreviewGutter() {
  const frame = document.getElementById('preview-frame');
  const inner = frame && frame.contentDocument;
  if (!inner) return;
  const wrap = document.querySelector('.preview-frame');
  const framedPhone = !previewMobileScreen.matches && wrap && wrap.classList.contains('is-phone');
  inner.documentElement.classList.toggle('clp-preview-framed-phone', !!framedPhone);
}

previewMobileScreen.addEventListener('change', syncPreviewGutter);

// The frame is this origin's, so its document can be measured directly: it
// grows when the injected script fills the columns, and again whenever a
// column is switched on inside it.
function fitPreview() {
  const frame = document.getElementById('preview-frame');
  if (!frame) return;
  const inner = frame.contentDocument;
  const content = inner && inner.getElementById('clp-preview');
  if (!content) return;
  syncPreviewGutter();
  // The wrapper's height, not the document's or the body's: CloudPanel gives
  // both of those a height of their own, which inside a frame is the frame's
  // height, so measuring either would only ever grow it.
  const measure = () => {
    frame.style.height = Math.max(160, Math.ceil(content.getBoundingClientRect().height)) + 'px';
  };
  measure();
  if (window.ResizeObserver) new ResizeObserver(measure).observe(content);
}

function setPreviewWidth(button) {
  const wrap = document.querySelector('.preview-frame');
  for (const other of button.parentElement.children) other.classList.toggle('is-active', other === button);
  wrap.classList.toggle('is-phone', button.dataset.width !== '0');
  fitPreview();
}

// A page drawn while a measurement runs follows it from the start.
followJobProgress(measurementFinished);
