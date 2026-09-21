
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
    input.checked = !wanted;
    busy(false);
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

async function measureNow(button) {
  clearNotice();
  busy(true);
  const originalLabel = button.textContent;
  let completed = false;
  function showProgress(event) {
    if (event.phase === 'complete') {
      completed = true;
      button.textContent = originalLabel;
      const total = event.measured + event.skipped;
      const summary = button.closest('.tweak-scan').querySelector('span');
      if (summary) summary.textContent = event.measured + ' of ' + total +
        ' site' + (total === 1 ? '' : 's') + ' measured, just now.';
      const skipped = event.skipped ? ', ' + event.skipped + ' skipped' : '';
      const sitesTable = document.querySelector('[data-tweak="sitesTable"]');
      const frame = document.getElementById('preview-frame');
      if (sitesTable && sitesTable.checked && frame) {
        frame.src = CLP_BASE + '/preview?refresh=' + Date.now();
      }
      busy(false);
      notify(event.measured + (event.measured === 1 ? ' site measured' : ' sites measured') + skipped + '.', 'ok');
      return;
    }
    const current = Math.min(event.completed + 1, event.total);
    const count = event.total ? current + ' of ' + event.total : 'sites';
    button.textContent = event.total ? current + '/' + event.total : 'Measuring';
    notify('Measuring ' + count + (event.site ? ' — ' + event.site : '') + '.', 'warn');
    // A single large site may be quiet for longer than the ordinary flash.
    clearTimeout(clpFlashTimer);
  }

  notify('Starting size measurement…', 'warn');
  clearTimeout(clpFlashTimer);
  try {
    const res = await fetch(CLP_BASE + '/api/scan', {
      method: 'POST',
      headers: { 'X-CLP-Addons-CSRF': csrf() },
    });
    if (!res.ok || !res.body) {
      let message = 'request failed with ' + res.status;
      try { const body = await res.json(); if (body && body.error) message = body.error; } catch (e) {}
      throw new Error(message);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, boundary);
        const separator = /^\r\n\r\n/.test(buffer.slice(boundary)) ? 4 : 2;
        buffer = buffer.slice(boundary + separator);
        let eventName = 'message';
        const data = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        const event = JSON.parse(data.join('\n'));
        if (eventName === 'error') throw new Error(event.error || 'the scan failed');
        showProgress(event);
      }
      if (chunk.done) break;
    }
    if (!completed) throw new Error('the scan ended before it completed');
  } catch (error) {
    button.textContent = originalLabel;
    busy(false);
    notify(error.message, 'error');
  }
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

function toggleNote(button) {
  const row = button.closest('.tweak-row');
  const open = row.classList.toggle('is-open');
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}
