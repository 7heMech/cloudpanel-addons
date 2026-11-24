let clpSetupPath = '';
let clpSetupOpen = {};
let clpSetupLastFocusCheck = 0;

const SETUP_MARK_TODO = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="none" stroke="var(--muted)" stroke-width="1.6"/></svg>';
const SETUP_MARK_HERE = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="var(--panel)" stroke="var(--accent)" stroke-width="1.8"/><circle cx="8" cy="8" r="3" fill="var(--accent)"/></svg>';

function setupCalm() {
  return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function setupReadState() {
  const node = CLP_ROOT.getElementById('clp-setup-state');
  if (!node) return null;
  try { return JSON.parse(node.textContent || '{}'); } catch (error) { return null; }
}

function setupReadContext() {
  const state = setupReadState();
  return (state && state.context) || null;
}

function setupAnnounce(text) {
  const el = CLP_ROOT.getElementById('setup-announce');
  if (!el) return;
  el.textContent = '';
  setTimeout(function () { el.textContent = text; }, 30);
}

function setupFlash(el, cls, ms) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(function () { el.classList.remove(cls); }, ms || 1100);
}

function setupPathOf(workspace, stepId) {
  const row = workspace.querySelector('[data-setup-step="' + CSS.escape(stepId) + '"]');
  const panel = row && row.closest('[data-setup-path]');
  return panel ? panel.dataset.setupPath : '';
}

function setupSetStepOpen(workspace, pathId, stepId) {
  const panel = workspace.querySelector('[data-setup-path="' + CSS.escape(pathId) + '"]');
  if (!panel) return;
  clpSetupOpen[pathId] = stepId || '';
  panel.querySelectorAll('[data-setup-step]').forEach(function (row) {
    const id = row.dataset.setupStep;
    const state = row.dataset.setupState;
    if (state === 'blocked') return;
    const isOpen = id === stepId;
    row.classList.toggle('is-open', isOpen);
    const head = row.querySelector('[data-setup-toggle]');
    if (head) head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    const body = row.querySelector('.setup-step-body');
    if (body) body.hidden = !isOpen;
    const aside = row.querySelector('.setup-step-aside');
    if (aside) aside.hidden = isOpen;
    if (state === 'todo') {
      const mark = row.querySelector('.setup-mark');
      if (mark) mark.innerHTML = isOpen ? SETUP_MARK_HERE : SETUP_MARK_TODO;
    }
    const seg = workspace.querySelector('[data-setup-seg="' + CSS.escape(id) + '"]');
    if (seg) seg.classList.toggle('is-here', isOpen && pathId === clpSetupPath && state === 'todo');
  });
}

function setupSwitchPath(workspace, pathId, pushHash) {
  const tabs = Array.from(workspace.querySelectorAll('[data-setup-tab]'));
  if (!tabs.length) return;
  const chosen = tabs.some(function (tab) { return tab.dataset.setupTab === pathId; })
    ? pathId
    : (workspace.dataset.initialPath || tabs[0].dataset.setupTab);
  clpSetupPath = chosen;
  tabs.forEach(function (tab) {
    const selected = tab.dataset.setupTab === chosen;
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.setAttribute('tabindex', selected ? '0' : '-1');
  });
  workspace.querySelectorAll('[data-setup-path]').forEach(function (panel) {
    panel.hidden = panel.dataset.setupPath !== chosen;
  });
  workspace.querySelectorAll('[data-setup-seg]').forEach(function (seg) {
    const id = seg.dataset.setupSeg;
    const ownerPath = setupPathOf(workspace, id);
    const isOpen = ownerPath === chosen && clpSetupOpen[chosen] === id && seg.dataset.setupSegState === 'todo';
    seg.classList.toggle('is-here', isOpen);
  });
  if (pushHash && history.replaceState) {
    const openId = clpSetupOpen[chosen];
    history.replaceState(null, '', '#' + encodeURIComponent(openId || ('path:' + chosen)));
  }
}

function setupSelectStep(stepId, pushHash) {
  const workspace = CLP_ROOT.querySelector('[data-setup-workspace]');
  if (!workspace || !stepId) return;
  const pathId = setupPathOf(workspace, stepId);
  if (!pathId) return;
  const row = workspace.querySelector('[data-setup-step="' + CSS.escape(stepId) + '"]');
  if (row && row.dataset.setupState === 'blocked') {
    const btn = row.querySelector('[data-setup-jump]');
    if (btn) setupJumpTo(btn.dataset.setupJump, stepId);
    return;
  }
  setupSwitchPath(workspace, pathId, false);
  setupSetStepOpen(workspace, pathId, stepId);
  if (pushHash && history.replaceState) {
    history.replaceState(null, '', '#' + encodeURIComponent(stepId));
  }
}

function setupJumpTo(targetId, fromStepId) {
  const workspace = CLP_ROOT.querySelector('[data-setup-workspace]');
  if (!workspace || !targetId) return;
  const targetRow = workspace.querySelector('[data-setup-step="' + CSS.escape(targetId) + '"]');
  if (!targetRow) return;
  // A Guide button pointing to a step that is currently locked forwards to its prerequisite.
  if (targetRow.dataset.setupState === 'blocked') {
    const reqBtn = targetRow.querySelector('[data-setup-jump]');
    if (reqBtn && reqBtn.dataset.setupJump && reqBtn.dataset.setupJump !== targetId) {
      setupJumpTo(reqBtn.dataset.setupJump, targetId);
    }
    return;
  }
  const toPath = setupPathOf(workspace, targetId);
  if (!toPath) return;
  const fromPath = fromStepId ? setupPathOf(workspace, fromStepId) : '';
  setupSwitchPath(workspace, toPath, false);
  setupSetStepOpen(workspace, toPath, targetId);
  if (history.replaceState) history.replaceState(null, '', '#' + encodeURIComponent(targetId));

  const control = targetRow.querySelector('.setup-host-input')
    || targetRow.querySelector('.setup-step-body .btn-primary')
    || targetRow.querySelector('.setup-step-body .btn')
    || targetRow.querySelector('[data-setup-toggle]');
  if (control) {
    const rect = control.getBoundingClientRect();
    if (rect.top < 12 || rect.bottom > window.innerHeight - 12) {
      control.scrollIntoView({ block: 'center', behavior: setupCalm() ? 'auto' : 'smooth' });
    }
    control.focus({ preventScroll: true });
    if (control.classList.contains('setup-host-input') || control.classList.contains('btn')) {
      setupFlash(control, 'is-pulse', 800);
    }
  }
  setupFlash(targetRow.querySelector('.setup-unlocks'), 'is-pulse', 1200);

  if (fromStepId && fromPath && fromPath === toPath) {
    const panel = workspace.querySelector('[data-setup-path="' + CSS.escape(toPath) + '"]');
    const rows = panel ? Array.from(panel.querySelectorAll('[data-setup-step]')) : [];
    const ids = rows.map(function (el) { return el.dataset.setupStep; });
    const a = ids.indexOf(targetId);
    const b = ids.indexOf(fromStepId);
    if (a >= 0 && b > a) {
      rows.forEach(function (el, idx) {
        const cls = idx === a ? 'trace-from' : idx === b ? 'trace-to' : (idx > a && idx < b ? 'trace-mid' : '');
        if (cls) setupFlash(el, cls, 1000);
      });
    }
  }
  const targetTitleEl = targetRow.querySelector('.setup-step-title');
  const title = targetTitleEl ? targetTitleEl.textContent.replace(/^(Done|Open|Skipped|Waiting|Does not apply):\s*/, '').trim() : targetId;
  setupAnnounce('Moved to ' + title + '.');
}

function setupApplyPasskeyOrigin() {
  const isIp = /^[\d.]+$|^\[/.test(location.hostname);
  const standardHttpsPort = !location.port || location.port === '443';
  const usable = Boolean(window.PublicKeyCredential && navigator.credentials && window.isSecureContext && !isIp && standardHttpsPort);
  const ctx = setupReadContext();
  const configuredDomain = ctx && ctx.customDomain && ctx.customDomain.name ? String(ctx.customDomain.name).toLowerCase() : '';
  // Never unlock on an alternate origin when CloudPanel already has a custom domain waiting on its certificate.
  const originMatches = !configuredDomain || configuredDomain === location.hostname.toLowerCase();
  const blocked = CLP_ROOT.querySelector('[data-setup-panel="passkeys"] [data-setup-passkey-blocked]');
  if (blocked && usable && originMatches) {
    const box = CLP_ROOT.querySelector('[data-setup-panel="passkeys"] [data-setup-blocked-box]');
    const head = CLP_ROOT.querySelector('[data-setup-panel="passkeys"] [data-setup-passkey-head]');
    if (box) box.hidden = true;
    if (head) head.hidden = false;
    blocked.hidden = false;
    const note = blocked.querySelector('[data-setup-passkey-note]');
    if (note) note.textContent = 'This browser is already on ' + location.origin + ', which supports passkeys directly.';
  }
  const live = CLP_ROOT.querySelector('[data-setup-passkey-live]');
  if (live) {
    const domain = live.dataset.customDomain;
    const warn = live.querySelector('[data-setup-origin-warn]');
    const link = live.querySelector('[data-setup-passkey-link]');
    if (domain && location.origin !== 'https://' + domain) {
      if (warn) {
        warn.textContent = 'Passkeys bind permanently to the address you add them on. Open CloudPanel at https://' + domain + ' before adding a key.';
        warn.hidden = false;
      }
      if (link) {
        link.href = 'https://' + domain + '/security';
        link.textContent = 'Open https://' + domain + '/security';
      }
    }
  }
}

function setupSnapshotDom() {
  const workspace = CLP_ROOT.querySelector('[data-setup-workspace]');
  if (!workspace) return null;
  const states = {};
  const branches = {};
  workspace.querySelectorAll('[data-setup-step]').forEach(function (row) {
    const id = row.dataset.setupStep;
    states[id] = row.dataset.setupState;
    if (row.dataset.setupBranchOf) branches[id] = row.dataset.setupBranchOf;
  });
  const tabCounts = {};
  workspace.querySelectorAll('[data-setup-tab-count]').forEach(function (el) {
    tabCounts[el.dataset.setupTabCount] = el.textContent;
  });
  return { states: states, branches: branches, tabCounts: tabCounts, path: clpSetupPath, open: Object.assign({}, clpSetupOpen) };
}

function setupAnimateDiff(before) {
  if (!before || setupCalm()) return;
  const workspace = CLP_ROOT.querySelector('[data-setup-workspace]');
  if (!workspace) return;
  const freed = [];
  const parentsToDraw = new Set();
  workspace.querySelectorAll('[data-setup-step]').forEach(function (row) {
    const id = row.dataset.setupStep;
    const now = row.dataset.setupState;
    const prev = before.states[id];
    if (prev && prev !== now) {
      const seg = workspace.querySelector('[data-setup-seg="' + CSS.escape(id) + '"]');
      if (seg) setupFlash(seg, 'is-changed', 1000);
    }
    if (prev === 'blocked' && now !== 'blocked') {
      freed.push({ row: row, id: id, parent: before.branches[id] || '' });
      if (before.branches[id]) parentsToDraw.add(before.branches[id]);
    }
  });
  workspace.querySelectorAll('[data-setup-tab-count]').forEach(function (el) {
    const pathId = el.dataset.setupTabCount;
    if (before.tabCounts[pathId] !== undefined && before.tabCounts[pathId] !== el.textContent) {
      setupFlash(el, 'is-changed', 1000);
    }
  });
  freed.forEach(function (entry, idx) {
    entry.row.classList.add('just-unlocked');
    if (entry.parent) {
      entry.row.style.setProperty('--d', ((idx + 1) * 90) + 'ms');
      entry.row.classList.add('just-promoted');
      const ghost = document.createElement('span');
      ghost.className = 'setup-arm is-ghost';
      ghost.setAttribute('aria-hidden', 'true');
      entry.row.insertBefore(ghost, entry.row.firstChild);
    }
  });
  parentsToDraw.forEach(function (parentId) {
    const parentRow = workspace.querySelector('[data-setup-step="' + CSS.escape(parentId) + '"]');
    if (parentRow) parentRow.classList.add('rail-draw');
  });
  if (freed.length) {
    setTimeout(function () {
      workspace.querySelectorAll('.just-unlocked, .just-promoted, .rail-draw').forEach(function (el) {
        el.classList.remove('just-unlocked', 'just-promoted', 'rail-draw');
        el.style.removeProperty('--d');
      });
      workspace.querySelectorAll('.setup-arm.is-ghost').forEach(function (el) { el.remove(); });
    }, 1600);
  }
}

function setupInitPage(before) {
  const state = setupReadState();
  if (state && typeof clpSetupShow === 'function') clpSetupShow(state.show, state.attention);
  const workspace = CLP_ROOT.querySelector('[data-setup-workspace]');
  if (!workspace) return;
  // Seed each path's default open step from the server-rendered markup.
  const defaults = {};
  workspace.querySelectorAll('[data-setup-path]').forEach(function (panel) {
    const openRow = panel.querySelector('[data-setup-step].is-open');
    defaults[panel.dataset.setupPath] = openRow ? openRow.dataset.setupStep : '';
  });
  if (before) {
    // Preserve the operator's tab and open step unless that step just completed or was skipped.
    Object.keys(defaults).forEach(function (pathId) {
      const prevOpen = before.open[pathId];
      const prevRow = prevOpen && workspace.querySelector('[data-setup-step="' + CSS.escape(prevOpen) + '"]');
      const keepPrev = prevRow && prevRow.dataset.setupState === before.states[prevOpen] && prevRow.dataset.setupState !== 'blocked';
      clpSetupOpen[pathId] = keepPrev ? prevOpen : defaults[pathId];
      setupSetStepOpen(workspace, pathId, clpSetupOpen[pathId]);
    });
    setupSwitchPath(workspace, before.path || workspace.dataset.initialPath || '', false);
    setupAnimateDiff(before);
  } else {
    clpSetupOpen = defaults;
    let fromHash = '';
    try { fromHash = decodeURIComponent((location.hash || '').replace(/^#/, '')); } catch (error) { fromHash = ''; }
    if (fromHash.startsWith('path:')) {
      setupSwitchPath(workspace, fromHash.slice(5), false);
    } else if (fromHash && setupPathOf(workspace, fromHash)) {
      setupSelectStep(fromHash, false);
    } else {
      setupSwitchPath(workspace, clpSetupPath || workspace.dataset.initialPath || '', false);
    }
  }
  setupApplyPasskeyOrigin();
}

async function setupApi(body, fresh) {
  const options = { credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.headers['X-CLP-Addons-CSRF'] = csrf();
    options.body = JSON.stringify(body);
  }
  const response = await fetch('/addons/api/setup' + (fresh ? '?fresh=1' : ''), options);
  let reply = null;
  try { reply = await response.json(); } catch (error) {}
  if (!response.ok || !reply || !reply.ok) throw new Error((reply && reply.error) || 'request failed with ' + response.status);
  return reply.data;
}

async function setupRefresh(body, fresh) {
  const root = CLP_ROOT.getElementById('setup-page-root');
  if (!root) return;
  const before = setupSnapshotDom();
  const data = await setupApi(body, fresh);
  repaintView(root, data.html);
  if (typeof clpSetupShow === 'function') clpSetupShow(data.show, data.attention);
  setupInitPage(before);
  return data;
}

function setupRandomLabel() {
  const first = 'abcdefghjkmnpqrstuvwxyz';
  const rest = 'abcdefghjkmnpqrstuvwxyz23456789';
  const pick = function (alphabet) {
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;
    const buf = new Uint8Array(1);
    let n = 256;
    while (n >= limit) { crypto.getRandomValues(buf); n = buf[0]; }
    return alphabet[n % alphabet.length];
  };
  let out = pick(first);
  for (let i = 1; i < 8; i++) out += pick(rest);
  return out;
}

function setupCopyText(value) {
  if (!value) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value)
      .then(function () { notify('Copied ' + value + '.', 'ok'); })
      .catch(function () { notify('Copy ' + value + ' manually.', 'warn'); });
  } else {
    notify('Copy ' + value + ' manually.', 'warn');
  }
}

function setupCopyAndOpen(value, url) {
  if (value && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value)
      .then(function () { notify('Copied ' + value + '. Paste it under Custom Domain.', 'ok'); })
      .catch(function () {});
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

function setupRandomPanelHost() {
  const input = CLP_ROOT.getElementById('setup-panel-host-name');
  if (!input) return;
  const ctx = setupReadContext();
  const zones = ((ctx && ctx.dnsZones) || []).slice().sort(function (a, b) { return b.length - a.length; });
  const clean = input.value.trim().toLowerCase().replace(/\.+$/, '');
  let base = '';
  if (clean && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean)) {
    base = zones.find(function (zone) { return clean === zone || clean.endsWith('.' + zone); }) || input.dataset.randomBase || clean;
  } else if (zones.length === 1) {
    base = zones[0];
  }
  if (!base) {
    input.focus();
    notify('Enter your domain first, such as example.com, then choose Random.', 'warn');
    return;
  }
  input.dataset.randomBase = base;
  input.value = setupRandomLabel() + '.' + base;
  input.focus();
}

function setupReviewLines(review) {
  const labels = { create: 'Create', update: 'Update', delete: 'Delete', note: 'Note' };
  const lines = [];
  (review.sites || []).forEach(function (plan) {
    (plan.problems || []).forEach(function (problem) {
      lines.push((plan.domain ? plan.domain + ': ' : '') + problem);
    });
    (plan.changes || []).forEach(function (change) {
      const verb = labels[change.action] || change.action || 'Change';
      const detail = change.detail ? ' (' + change.detail + ')' : '';
      const before = change.before ? ' [now: ' + change.before + ']' : '';
      lines.push((plan.domain ? plan.domain + ': ' : '') + verb + ' ' + change.subject + detail + before);
    });
  });
  return lines;
}

async function setupSavePanelHostName(name, source) {
  if (!name) return;
  if (source) source.disabled = true;
  try {
    const response = await fetch('/addons/dns/api/panel-host', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CLP-Addons-CSRF': csrf() },
      body: JSON.stringify({ name: name }),
    });
    let reply = null;
    try { reply = await response.json(); } catch (error) {}
    if (!response.ok || !reply || !reply.ok) throw new Error((reply && reply.error) || 'request failed with ' + response.status);
    const review = reply.data && reply.data.review;
    if (review) {
      const details = setupReviewLines(review);
      if (review.blocked || !review.token) {
        const message = [review.text].concat(details).filter(Boolean).join(' ') || ('Could not save ' + name + '.');
        throw new Error(message);
      }
      const promptText = [reply.data.notice, review.text].filter(Boolean).join(' ');
      const accepted = await confirmAction({
        title: review.title || ('Apply DNS changes for ' + name + '?'),
        text: promptText,
        details: details,
        confirmLabel: review.confirmLabel || 'Apply changes',
        danger: Boolean(review.danger),
      });
      if (!accepted) {
        if (source) source.disabled = false;
        return;
      }
      const confirm = await fetch('/addons/dns/api/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CLP-Addons-CSRF': csrf() },
        body: JSON.stringify({ token: review.token }),
      });
      let confirmed = null;
      try { confirmed = await confirm.json(); } catch (error) {}
      if (!confirm.ok || !confirmed || !confirmed.ok) throw new Error((confirmed && confirmed.error) || 'Could not apply DNS change');
      if (confirmed.data && confirmed.data.review) {
        throw new Error('The DNS plan changed before confirmation. Open DNS to review it.');
      }
      notify((confirmed.data && confirmed.data.notice) || ('DNS points ' + name + ' at this server.'), 'ok');
    } else {
      notify((reply.data && reply.data.notice) || ('Saved ' + name + '.'), 'ok');
    }
    await setupRefresh(null, true);
  } catch (error) {
    notify(error.message, 'error');
    if (source) source.disabled = false;
  }
}

function setupSavePanelHost(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.namedItem('name').value.trim();
  if (!name) return;
  setupSavePanelHostName(name, form.querySelector('button[type="submit"]'));
}

async function setupRunInline(target) {
  const url = target.dataset.setupInlineUrl;
  const rawBody = target.dataset.setupInlineBody;
  const doneMessage = target.dataset.setupInlineDone || 'Saved.';
  target.disabled = true;
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CLP-Addons-CSRF': csrf() },
      body: rawBody || '{}',
    });
    let reply = null;
    try { reply = await response.json(); } catch (error) {}
    if (!response.ok || !reply || !reply.ok) throw new Error((reply && reply.error) || 'request failed with ' + response.status);
    if (url === '/addons/panel-tweaks/api/tweaks') {
      try { localStorage.setItem('clp_tweaks_rev', String(Date.now())); } catch (error) {}
    }
    notify(doneMessage, 'ok');
    await setupRefresh(null, true);
  } catch (error) {
    target.disabled = false;
    notify(error.message, 'error');
  }
}

async function setupEnableAddon(addon, target) {
  target.disabled = true;
  try {
    const response = await fetch('/addons/api/addons/' + encodeURIComponent(addon) + '/enable', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CLP-Addons-CSRF': csrf() },
      body: '{}',
    });
    let reply = null;
    try { reply = await response.json(); } catch (error) {}
    if (!response.ok || !reply || !reply.ok) throw new Error((reply && reply.error) || 'request failed with ' + response.status);
    const id = reply.data && reply.data.jobId;
    if (!id) throw new Error('the manager did not start a job');
    const existing = reply.data.existing === true;
    const running = existing ? reply.data.job : null;
    const title = existing && running && typeof describeManagerJob === 'function'
      ? describeManagerJob(running)
      : 'Enabling ' + addon;
    const holder = target.closest('[data-manager-job-card]');
    if (holder && typeof showJob === 'function' && typeof watchJob === 'function') {
      showJob(title, holder);
      watchJob(id, holder, async function (job) {
        if (job.state === 'failed') {
          notify(job.error || ('Enabling ' + addon + ' failed.'), 'error');
          target.disabled = false;
          return;
        }
        notify('Enabled ' + (job.addon || addon) + '.', 'ok');
        await setupRefresh(null, true);
      });
    } else {
      await setupRefresh(null, true);
    }
  } catch (error) {
    target.disabled = false;
    notify(error.message, 'error');
  }
}

async function setupHandleClick(event) {
  const workspace = CLP_ROOT.querySelector('[data-setup-workspace]');
  const tab = event.target.closest && event.target.closest('[data-setup-tab]');
  if (tab && workspace) {
    setupSwitchPath(workspace, tab.dataset.setupTab, true);
    return;
  }
  const jump = event.target.closest && event.target.closest('[data-setup-jump]');
  if (jump) {
    setupJumpTo(jump.dataset.setupJump, jump.dataset.setupFrom || '');
    return;
  }
  const toggle = event.target.closest && event.target.closest('[data-setup-toggle]');
  if (toggle && workspace) {
    const id = toggle.dataset.setupToggle;
    const pathId = setupPathOf(workspace, id);
    if (pathId) {
      const next = clpSetupOpen[pathId] === id ? '' : id;
      setupSetStepOpen(workspace, pathId, next);
      if (history.replaceState) history.replaceState(null, '', '#' + encodeURIComponent(next || ('path:' + pathId)));
    }
    return;
  }
  const copyBtn = event.target.closest && event.target.closest('[data-setup-copy]');
  if (copyBtn) {
    setupCopyText(copyBtn.dataset.setupCopy);
    return;
  }
  const copyOpen = event.target.closest && event.target.closest('[data-setup-copy-open]');
  if (copyOpen) {
    setupCopyAndOpen(copyOpen.dataset.setupCopyOpen, copyOpen.dataset.setupOpenUrl || '/admin/settings');
    return;
  }
  const adopt = event.target.closest && event.target.closest('[data-setup-adopt-host]');
  if (adopt) {
    setupSavePanelHostName(adopt.dataset.setupAdoptHost, adopt);
    return;
  }
  const randomHost = event.target.closest && event.target.closest('[data-setup-random-host]');
  if (randomHost) {
    setupRandomPanelHost();
    return;
  }
  const inline = event.target.closest && event.target.closest('[data-setup-inline-url]');
  if (inline) {
    setupRunInline(inline);
    return;
  }
  const enable = event.target.closest && event.target.closest('[data-setup-enable]');
  if (enable) {
    setupEnableAddon(enable.dataset.setupEnable, enable);
    return;
  }
  const refresh = event.target.closest && event.target.closest('[data-setup-refresh]');
  if (refresh) {
    refresh.disabled = true;
    setupRefresh(null, true).catch(function (error) { notify(error.message, 'error'); refresh.disabled = false; });
    return;
  }
  const pref = event.target.closest && event.target.closest('[data-setup-skip], [data-setup-unskip], [data-setup-hide], [data-setup-show]');
  if (!pref) return;
  const data = pref.dataset;
  const body = data.setupSkip ? { skip: data.setupSkip }
    : data.setupUnskip ? { unskip: data.setupUnskip }
    : data.setupHide !== undefined ? { hidden: true }
    : data.setupShow !== undefined ? { hidden: false }
    : null;
  if (!body) return;
  pref.disabled = true;
  try {
    await setupRefresh(body, false);
    if (body.hidden) notify('Setup link hidden from header. Reopen it anytime from the Addons page.', 'ok');
  } catch (error) {
    pref.disabled = false;
    notify(error.message, 'error');
  }
}

function setupHandleKeydown(event) {
  const tab = event.target.closest && event.target.closest('[role="tab"][data-setup-tab]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const workspace = CLP_ROOT.querySelector('[data-setup-workspace]');
  if (!workspace) return;
  const tabs = Array.from(workspace.querySelectorAll('[data-setup-tab]'));
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  event.preventDefault();
  const nextIdx = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
    : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  const nextTab = tabs[nextIdx];
  setupSwitchPath(workspace, nextTab.dataset.setupTab, true);
  nextTab.focus();
}

(function () {
  const root = CLP_ROOT.getElementById('setup-page-root');
  if (!root) return;
  root.addEventListener('click', setupHandleClick);
  root.addEventListener('keydown', setupHandleKeydown);
  window.addEventListener('hashchange', function () { setupInitPage(); });
  window.addEventListener('focus', function () {
    if (Date.now() - clpSetupLastFocusCheck < 4000) return;
    clpSetupLastFocusCheck = Date.now();
    setupRefresh(null, true).catch(function () {});
  });
  setupInitPage();
})();
