const termHost = document.getElementById('terminal');
const TERM_DOMAIN = termHost.dataset.domain;
const SESSIONS = '/api/sessions';
const STORE_KEY = 'clp-terminal:' + TERM_DOMAIN;
const FONT_KEY = 'clp-terminal-font-size';
const MIN_FONT_SIZE = 9;
const DEFAULT_FONT_SIZE = 14;
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
  return size >= MIN_FONT_SIZE && size <= 24 ? size : DEFAULT_FONT_SIZE;
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
function refit() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () { fitAddon.fit(); }, 80);
}
window.addEventListener('resize', refit);

// A phone's keyboard covers the bottom of the page without resizing it in
// every browser, which would leave the extra keys and the prompt beneath it.
// The window follows the visible part instead, and the terminal refits to it.
if (window.visualViewport) {
  const fitVisible = function () {
    const root = document.documentElement.style;
    root.setProperty('--term-visible-height', visualViewport.height + 'px');
    root.setProperty('--term-visible-top', visualViewport.offsetTop + 'px');
    refit();
  };
  visualViewport.addEventListener('resize', fitVisible);
  visualViewport.addEventListener('scroll', fitVisible);
  fitVisible();
}

const fontReset = document.getElementById('term-font-reset');

function setFont(size) {
  term.options.fontSize = size;
  if (size === DEFAULT_FONT_SIZE) localStorage.removeItem(FONT_KEY);
  else localStorage.setItem(FONT_KEY, String(size));
  fontReset.disabled = size === DEFAULT_FONT_SIZE;
  fitAddon.fit();
}

function changeFont(step) {
  setFont(Math.min(24, Math.max(MIN_FONT_SIZE, term.options.fontSize + step)));
  term.focus();
}

function resetFont() {
  setFont(DEFAULT_FONT_SIZE);
  term.focus();
}

fontReset.disabled = term.options.fontSize === DEFAULT_FONT_SIZE;

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

function showEnded(text, title) {
  ended = true;
  if (events) events.close();
  events = null;
  sessionId = null;
  pendingInput = '';
  pendingSize = null;
  unconfirmed = null;
  sessionStorage.removeItem(STORE_KEY);
  setStatus('Ended', '');
  document.getElementById('term-ended-title').textContent = title || 'Session ended';
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
  events.addEventListener('moved', function () {
    showEnded('This session was opened in another window.', 'Session moved');
  });
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
// meanwhile sent together in the next. Each batch is numbered, so one resent
// after a network error is not typed twice when it had arrived after all.
const WRITER = Math.random().toString(36).slice(2, 12) || 'w';
let pendingInput = '';
let pendingSize = null;
let sending = false;
let inputSeq = 0;
let unconfirmed = null;

function sendSize() {
  pendingSize = [term.cols, term.rows];
  pump();
}

async function pump() {
  if (sending || ended || !sessionId || (!unconfirmed && !pendingInput && !pendingSize)) return;
  sending = true;
  const id = sessionId;
  if (!unconfirmed) {
    unconfirmed = { writer: WRITER, seq: ++inputSeq };
    if (pendingSize) unconfirmed.size = pendingSize;
    pendingSize = null;
    if (pendingInput) {
      let end = Math.min(pendingInput.length, 8192);
      const last = pendingInput.charCodeAt(end - 1);
      if (end < pendingInput.length && last >= 0xd800 && last <= 0xdbff) end--;
      unconfirmed.data = pendingInput.slice(0, end);
      pendingInput = pendingInput.slice(end);
    }
  }
  let response = null;
  try {
    response = await fetch(CLP_BASE + SESSIONS + '/' + encodeURIComponent(id) + '/input', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-CLP-Addons-CSRF': csrf() },
      body: JSON.stringify(unconfirmed),
    });
  } catch (error) {
    // Perhaps not delivered: the same batch goes again, ahead of anything since.
    sending = false;
    if (sessionId === id) setTimeout(pump, 1000);
    else pump();
    return;
  }
  sending = false;
  // A reply about a session this window has since left says nothing about the current one.
  if (sessionId !== id) return pump();
  unconfirmed = null;
  if (response.status === 204) return pump();
  if (response.type === 'opaqueredirect') return finish({ reason: 'signed-out' });
  // The event stream says how a session ended, and may say it a moment later.
  setTimeout(function () { if (!ended && sessionId === id) finish({ reason: 'gone' }); }, 1000);
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

function arrowKey(direction) {
  return (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + { up: 'A', down: 'B', right: 'C', left: 'D' }[direction];
}

function typeText(text) {
  if (ended || !sessionId || !text) return;
  pendingInput += text;
  pump();
}

function sendKey(name) {
  if (name === 'ctrl') {
    ctrlHeld = !ctrlHeld;
    ctrlButton.setAttribute('aria-pressed', String(ctrlHeld));
    return;
  }
  const keys = { esc: '\x1b', tab: '\t' };
  typeText(keys[name] || arrowKey(name));
}

// The extra keys act on touch-down and never take focus, so the keyboard
// stays as it was, open or closed. Arrows repeat while held, as a keyboard's
// do.
const REPEATING = ['up', 'down', 'left', 'right'];
document.querySelectorAll('.term-keys button[data-key]').forEach(function (button) {
  const name = button.dataset.key;
  let delay = 0;
  let repeat = 0;
  const release = function () {
    clearTimeout(delay);
    clearInterval(repeat);
    button.classList.remove('is-down');
  };
  const press = function (event) {
    event.preventDefault();
    release();
    button.classList.add('is-down');
    sendKey(name);
    if (REPEATING.indexOf(name) !== -1) {
      delay = setTimeout(function () { repeat = setInterval(function () { sendKey(name); }, 60); }, 400);
    }
  };
  button.addEventListener('touchstart', press, { passive: false });
  button.addEventListener('mousedown', press);
  ['touchend', 'touchcancel', 'mouseup', 'mouseleave'].forEach(function (type) { button.addEventListener(type, release); });
  // Enter or Space on a focused key arrives as a click with no pointer.
  button.addEventListener('click', function (event) { if (event.detail === 0) sendKey(name); });
});

// Text selection by touch. xterm's own selection needs a mouse, so holding a
// finger on the terminal lays a plain-text copy of it exactly over the top --
// same font, cell size, rows and scroll position -- and the phone's own
// long-press selection, handles and Copy menu work on that. Clearing the
// selection takes it away again.
const selectLayer = document.getElementById('term-select');
let selecting = false;

function screenBox() {
  const screen = termHost.querySelector('.xterm-screen');
  const box = screen.getBoundingClientRect();
  const main = termMain.getBoundingClientRect();
  return {
    left: box.left - main.left, top: box.top - main.top,
    cellWidth: box.width / term.cols, rowHeight: box.height / term.rows,
  };
}

/** Every buffer row, with wrapped rows left unbroken so a copy is the real line. */
function bufferText() {
  const buffer = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    const next = buffer.getLine(i + 1);
    if (!line) continue;
    // A row that wraps onto the next keeps its trailing spaces, or the rows
    // after it would start in the wrong column.
    const text = line.translateToString(!(next && next.isWrapped));
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n');
}

function naturalCharWidth(font) {
  const canvas = naturalCharWidth.canvas || (naturalCharWidth.canvas = document.createElement('canvas'));
  const context = canvas.getContext('2d');
  context.font = font;
  return context.measureText('W'.repeat(50)).width / 50;
}

function showSelectLayer() {
  if (selecting) return;
  const box = screenBox();
  const theme = termTheme();
  const font = term.options.fontSize + 'px ' + term.options.fontFamily;
  const style = selectLayer.style;
  style.left = box.left + 'px';
  style.top = box.top + 'px';
  style.width = box.cellWidth * term.cols + 'px';
  style.height = box.rowHeight * term.rows + 'px';
  style.font = font;
  style.lineHeight = box.rowHeight + 'px';
  style.letterSpacing = (box.cellWidth - naturalCharWidth(font)) + 'px';
  style.color = theme.foreground;
  style.background = theme.background;
  selectLayer.textContent = bufferText();
  selectLayer.hidden = false;
  selectLayer.scrollTop = term.buffer.active.viewportY * box.rowHeight;
  selecting = true;
}

function hideSelectLayer() {
  if (!selecting) return;
  selecting = false;
  selectLayer.hidden = true;
  selectLayer.textContent = '';
  selectLayer.blur();
}

function hasSelection() {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selectLayer.contains(selection.anchorNode));
}

/** The word under a point, for a browser whose long-press did not select one. */
function selectWordAt(x, y) {
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
  else if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y);
    if (position) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
    }
  }
  if (!range || !selectLayer.contains(range.startContainer)) return;
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  if (selection.modify) {
    selection.modify('move', 'backward', 'word');
    selection.modify('extend', 'forward', 'word');
  }
}

// The copy is editable, with no keyboard of its own, so the phone's long-press
// menu offers Paste beside Copy. A paste goes to the shell; nothing else may
// edit the copy. Copying, cutting or pasting is the end of a selection.
selectLayer.addEventListener('paste', function (event) {
  event.preventDefault();
  const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
  hideSelectLayer();
  term.paste(text);
  term.focus();
});
selectLayer.addEventListener('beforeinput', function (event) { event.preventDefault(); });
selectLayer.addEventListener('drop', function (event) { event.preventDefault(); });
selectLayer.addEventListener('cut', function (event) {
  event.preventDefault();
  const selection = window.getSelection();
  if (event.clipboardData && selection) event.clipboardData.setData('text/plain', selection.toString());
  setTimeout(hideSelectLayer, 0);
});
selectLayer.addEventListener('copy', function () { setTimeout(hideSelectLayer, 0); });

// A swipe scrolls the history, which xterm leaves to a mouse wheel. In a
// full-screen program such as less or vim there is no history to scroll, so
// it moves by arrow keys instead, as phone terminals do.
let touchY = null;
let touchStartX = 0;
let touchStartY = 0;
let touchMoved = false;
let touchActive = false;
let touchCarry = 0;
let touchVelocity = 0;
let touchTime = 0;
let touchStartedAt = 0;
let glide = 0;
let holdTimer = 0;
let wordTimer = 0;

function rowHeight() {
  const screen = termHost.querySelector('.xterm-screen');
  return screen && term.rows ? screen.clientHeight / term.rows : 17;
}

function scrollByPixels(pixels) {
  touchCarry += pixels;
  const lines = Math.trunc(touchCarry / rowHeight());
  if (!lines) return;
  touchCarry -= lines * rowHeight();
  if (term.buffer.active.type === 'alternate') typeText(arrowKey(lines > 0 ? 'down' : 'up').repeat(Math.abs(lines)));
  else term.scrollLines(lines);
}

function cancelHold() {
  clearTimeout(holdTimer);
  clearTimeout(wordTimer);
}

termHost.addEventListener('touchstart', function (event) {
  cancelAnimationFrame(glide);
  cancelHold();
  if (event.touches.length !== 1) return void (touchY = null);
  touchActive = true;
  touchMoved = false;
  touchY = touchStartY = event.touches[0].clientY;
  touchStartX = event.touches[0].clientX;
  touchCarry = 0;
  touchVelocity = 0;
  touchTime = event.timeStamp;
  touchStartedAt = performance.now();
  // Shown before the phone's own long-press fires, so that press lands on
  // selectable text; if it does not select anything, select the word here.
  holdTimer = setTimeout(showSelectLayer, 250);
  wordTimer = setTimeout(function () {
    if (!hasSelection()) selectWordAt(touchStartX, touchStartY);
  }, 650);
}, { passive: true, capture: true });

termHost.addEventListener('touchmove', function (event) {
  // Once the text is up, a moving finger is the browser's to extend the selection with.
  if (selecting || touchY === null || event.touches.length !== 1) return;
  const x = event.touches[0].clientX;
  const y = event.touches[0].clientY;
  if (!touchMoved && Math.hypot(x - touchStartX, y - touchStartY) < 8) return;
  touchMoved = true;
  cancelHold();
  const delta = touchY - y;
  touchVelocity = delta / Math.max(1, event.timeStamp - touchTime);
  touchY = y;
  touchTime = event.timeStamp;
  event.preventDefault();
  event.stopPropagation();
  scrollByPixels(delta);
}, { passive: false, capture: true });

function touchFinished() {
  touchActive = false;
  cancelHold();
  if (touchY === null) return;
  touchY = null;
  if (selecting) {
    // A hold too short for the phone's long-press, that selected nothing, was
    // a tap after all. A long one stays: its menu may be offering Paste.
    const held = performance.now() - touchStartedAt;
    setTimeout(function () { if (held < 450 && !hasSelection()) hideSelectLayer(); }, 150);
    return;
  }
  // A flick keeps going and slows down; arrow keys do not glide.
  if (!touchMoved || term.buffer.active.type === 'alternate' || Math.abs(touchVelocity) < 0.3) return;
  let velocity = touchVelocity;
  let last = performance.now();
  const step = function (now) {
    scrollByPixels(velocity * (now - last));
    velocity *= Math.pow(0.95, (now - last) / 16);
    last = now;
    if (Math.abs(velocity) > 0.05) glide = requestAnimationFrame(step);
  };
  glide = requestAnimationFrame(step);
}
termHost.addEventListener('touchend', touchFinished, { passive: true, capture: true });
termHost.addEventListener('touchcancel', touchFinished, { passive: true, capture: true });
// The layer covers the terminal once it is up, so its own touches end there.
// A quick tap that leaves nothing selected is the way back to the terminal.
let layerTouchAt = 0;
selectLayer.addEventListener('touchstart', function () {
  touchActive = true;
  layerTouchAt = performance.now();
}, { passive: true });
selectLayer.addEventListener('touchend', function () {
  touchActive = false;
  const quick = performance.now() - layerTouchAt < 300;
  setTimeout(function () { if (quick && !hasSelection()) hideSelectLayer(); }, 150);
}, { passive: true });

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
// A page the browser kept for its Back button said it was closing; it asks
// again, and starts afresh if the session has gone meanwhile.
window.addEventListener('pageshow', function (event) {
  if (!event.persisted || !sessionId || ended) return;
  if (events) events.close();
  setStatus('Connecting', 'state-paused');
  attach(true);
});

const storedSession = sessionStorage.getItem(STORE_KEY);
if (storedSession) {
  sessionId = storedSession;
  setStatus('Connecting', 'state-paused');
  attach(true);
} else {
  createSession();
}
