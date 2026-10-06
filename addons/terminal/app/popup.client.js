const termHost = document.getElementById('terminal');
const TERM_DOMAIN = termHost.dataset.domain;
const SESSIONS = '/api/sessions';
const STORE_KEY = 'clp-terminal:' + TERM_DOMAIN;
const FONT_KEY = 'clp-terminal-font-size';
const statusBadge = document.getElementById('term-status');
const userLabel = document.getElementById('term-user');
const termMain = document.getElementById('term-main');
const endedCard = document.getElementById('term-ended');

// Yellow and white are the colours a light background loses, so the light set
// darkens them rather than reusing the dark one.
const LIGHT_THEME = {
  background: '#ffffff', foreground: '#212529', cursor: '#212529', cursorAccent: '#ffffff',
  selectionBackground: 'rgba(38, 125, 221, 0.25)',
  black: '#212529', red: '#bc3636', green: '#23774b', yellow: '#8a5a12',
  blue: '#1d5fb0', magenta: '#94389a', cyan: '#12737a', white: '#6c757d',
  brightBlack: '#5c636a', brightRed: '#d23f3f', brightGreen: '#2b8a57', brightYellow: '#a06a14',
  brightBlue: '#267ddd', brightMagenta: '#ad4bb3', brightCyan: '#16878f', brightWhite: '#495057',
};
const DARK_THEME = {
  background: '#1c1f26', foreground: '#e6e6e6', cursor: '#e6e6e6', cursorAccent: '#1c1f26',
  selectionBackground: 'rgba(124, 179, 240, 0.3)',
  black: '#3a3f4b', red: '#ef9999', green: '#81c9a0', yellow: '#e5bc76',
  blue: '#7cb3f0', magenta: '#d7a2e8', cyan: '#7fd1d6', white: '#d0d4da',
  brightBlack: '#7a8290', brightRed: '#f5b3b3', brightGreen: '#a3dcbb', brightYellow: '#f0d29e',
  brightBlue: '#a3c9f5', brightMagenta: '#e5c0f0', brightCyan: '#a5e3e6', brightWhite: '#ffffff',
};

function termTheme() {
  return document.documentElement.classList.contains('dark') ? DARK_THEME : LIGHT_THEME;
}

function storedFontSize() {
  const size = Number(localStorage.getItem(FONT_KEY));
  return size >= 10 && size <= 24 ? size : 14;
}

// No title, link or clipboard handling is wired to the terminal: what it
// renders comes from the site, and a site must not be able to relabel this
// window as another site's or write to the operator's clipboard.
const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: storedFontSize(),
  cursorBlink: true,
  scrollback: 10000,
  theme: termTheme(),
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(termHost);
fitAddon.fit();
term.focus();

new MutationObserver(function () { term.options.theme = termTheme(); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

let resizeTimer = 0;
window.addEventListener('resize', function () {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () { fitAddon.fit(); }, 80);
});

function changeFont(step) {
  const size = Math.min(24, Math.max(10, term.options.fontSize + step));
  term.options.fontSize = size;
  localStorage.setItem(FONT_KEY, String(size));
  fitAddon.fit();
  term.focus();
}

function setStatus(label, kind) {
  statusBadge.textContent = label;
  statusBadge.className = 'badge' + (kind ? ' ' + kind : '');
}

function decodeOutput(text) {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

let sessionId = null;
let events = null;
let ended = false;

const END_REASONS = {
  exit: 'The shell exited.',
  closed: 'The session was closed.',
  detached: 'The session ended after this window was away for a minute.',
  'signed-out': 'You are no longer signed in to CloudPanel as an administrator.',
  protocol: 'The terminal sent something it should not have, so the session was ended.',
  disconnected: 'The connection to the server was lost.',
  gone: 'This session is no longer running.',
};

function showEnded(text) {
  ended = true;
  if (events) events.close();
  events = null;
  sessionId = null;
  sessionStorage.removeItem(STORE_KEY);
  setStatus('Ended', '');
  document.getElementById('term-ended-text').textContent = text;
  termMain.classList.add('is-ended');
  endedCard.hidden = false;
  document.getElementById('term-new').focus();
}

function finish(info) {
  let text = END_REASONS[info.reason] || END_REASONS.gone;
  if (info.reason === 'exit' && typeof info.code === 'number' && info.code !== 0) {
    text = 'The shell exited with status ' + info.code + '.';
  }
  showEnded(text);
}

async function createSession() {
  setStatus('Connecting', 'state-paused');
  try {
    const reply = await call(SESSIONS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: TERM_DOMAIN, cols: term.cols, rows: term.rows }),
    });
    sessionId = reply.data.id;
    sessionStorage.setItem(STORE_KEY, sessionId);
    attach(false);
  } catch (error) {
    showEnded(error.message);
  }
}

// The browser's own reconnect resends the last event id, and the server
// replays what was missed from there.
function attach(reattaching) {
  let joined = false;
  events = new EventSource(CLP_BASE + SESSIONS + '/' + encodeURIComponent(sessionId) + '/events');
  events.addEventListener('session', function (event) {
    const info = JSON.parse(event.data);
    userLabel.textContent = 'as ' + info.user;
    userLabel.hidden = false;
    joined = true;
    setStatus('Connected', 'state-running');
    sendSize();
  });
  events.addEventListener('reset', function (event) {
    term.reset();
    term.write(decodeOutput(event.data));
  });
  events.onmessage = function (event) { term.write(decodeOutput(event.data)); };
  events.addEventListener('ended', function (event) { finish(JSON.parse(event.data)); });
  events.onerror = function () {
    if (ended || !events) return;
    if (events.readyState !== EventSource.CLOSED) {
      setStatus('Reconnecting', 'state-paused');
      return;
    }
    events = null;
    // A reload whose session has gone starts a new one rather than an error.
    if (reattaching && !joined) {
      sessionStorage.removeItem(STORE_KEY);
      sessionId = null;
      createSession();
      return;
    }
    finish({ reason: 'gone' });
  };
}

function newSession() {
  ended = false;
  endedCard.hidden = true;
  termMain.classList.remove('is-ended');
  userLabel.hidden = true;
  term.reset();
  term.focus();
  createSession();
}

// Keystrokes go out in order, one request at a time, with whatever was typed
// meanwhile sent together in the next.
let pendingInput = '';
let pendingSize = null;
let sending = false;

function sendSize() {
  pendingSize = [term.cols, term.rows];
  pump();
}

async function pump() {
  if (sending || ended || !sessionId || (!pendingInput && !pendingSize)) return;
  sending = true;
  const body = {};
  if (pendingSize) body.size = pendingSize;
  pendingSize = null;
  if (pendingInput) {
    let end = Math.min(pendingInput.length, 8192);
    const last = pendingInput.charCodeAt(end - 1);
    if (end < pendingInput.length && last >= 0xd800 && last <= 0xdbff) end--;
    body.data = pendingInput.slice(0, end);
    pendingInput = pendingInput.slice(end);
  }
  let response = null;
  try {
    response = await fetch(CLP_BASE + SESSIONS + '/' + encodeURIComponent(sessionId) + '/input', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-CLP-Addons-CSRF': csrf() },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // Not delivered: put it back in front of anything typed since, and retry.
    pendingInput = (body.data || '') + pendingInput;
    if (body.size && !pendingSize) pendingSize = body.size;
    sending = false;
    setTimeout(pump, 1000);
    return;
  }
  sending = false;
  if (response.status === 204) return pump();
  if (response.type === 'opaqueredirect') return finish({ reason: 'signed-out' });
  finish({ reason: 'gone' });
}

let ctrlHeld = false;
const ctrlButton = document.getElementById('term-ctrl');

function withCtrl(data) {
  if (!ctrlHeld || data.length !== 1) return data;
  ctrlHeld = false;
  ctrlButton.setAttribute('aria-pressed', 'false');
  const code = data.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  return data === ' ' ? '\x00' : data;
}

term.onData(function (data) {
  if (ended || !sessionId) return;
  pendingInput += withCtrl(data);
  pump();
});
term.onResize(function (size) {
  pendingSize = [size.cols, size.rows];
  pump();
});

// Ctrl+Shift+C copies the selection. Ctrl+Shift+V is left to the browser,
// whose paste event the terminal already takes.
term.attachCustomKeyEventHandler(function (event) {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return true;
  if (event.code === 'KeyC') {
    if (event.type === 'keydown' && term.hasSelection() && navigator.clipboard) {
      navigator.clipboard.writeText(term.getSelection());
    }
    event.preventDefault();
    return false;
  }
  return event.code !== 'KeyV';
});

function sendKey(name) {
  if (name === 'ctrl') {
    ctrlHeld = !ctrlHeld;
    ctrlButton.setAttribute('aria-pressed', String(ctrlHeld));
    term.focus();
    return;
  }
  const cursor = term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[';
  const keys = { esc: '\x1b', tab: '\t', up: cursor + 'A', down: cursor + 'B', right: cursor + 'C', left: cursor + 'D' };
  if (!ended && sessionId && keys[name]) {
    pendingInput += keys[name];
    pump();
  }
  term.focus();
}

// Tells the server the window is going; a reload comes back within the grace
// it allows and carries on.
window.addEventListener('pagehide', function () {
  if (!sessionId || ended) return;
  fetch(CLP_BASE + SESSIONS + '/' + encodeURIComponent(sessionId), {
    method: 'DELETE',
    keepalive: true,
    headers: { 'X-CLP-Addons-CSRF': csrf() },
  }).catch(function () {});
});

const storedSession = sessionStorage.getItem(STORE_KEY);
if (storedSession) {
  sessionId = storedSession;
  setStatus('Connecting', 'state-paused');
  attach(true);
} else {
  createSession();
}
