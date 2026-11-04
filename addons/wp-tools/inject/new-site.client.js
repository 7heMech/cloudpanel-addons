// Plugins for the site CloudPanel's New WordPress Site form is about to create.
//
// Written for the panel's page, not for an addon page: no shared client code
// reaches here, so this is plain ES5 with its own fetch. Every name and summary
// shown came from WordPress.org or from a zip, so each goes in as text.
//
// None of these controls has a name: Symfony refuses a field its form does not
// declare. The choice is sent to WordPress Tools instead, just before the form
// is, and the job it records waits for the site. It is kept in this tab's
// session storage as well, so a form CloudPanel sends back with an error still
// has it, and the page the site lands on can follow the job.
(function () {
  var box = document.getElementById('clp-wp-plugins');
  var form = box && box.closest('form');
  if (!form) return;
  var url = box.getAttribute('data-url');
  var CHOICE = 'clp-addons-new-site-plugins';
  var JOB = 'clp-addons-new-site-job';
  var MAX = 20;
  var MAX_BYTES = 32 * 1024 * 1024;
  var search = document.getElementById('clp-wp-plugin-search');
  var results = document.getElementById('clp-wp-plugin-results');
  var list = document.getElementById('clp-wp-plugin-chosen');
  var file = document.getElementById('clp-wp-plugin-file');
  var error = document.getElementById('clp-wp-plugins-error');
  var domainInput = form.querySelector('input[id$="_domainName"]');
  // { source: 'wordpress.org' | 'upload', slug, name, activate, id?, pending? }
  var chosen = [];
  var saved = false;
  var timer = null;
  var asked = 0;

  // Drawn for administrators only: nobody else may hand a site a zip.
  var canUpload = Boolean(file);
  try {
    chosen = JSON.parse(sessionStorage.getItem(CHOICE) || '[]').filter(function (item) {
      return !item.pending && (canUpload || item.source !== 'upload');
    });
  }
  catch (e) { chosen = []; }

  function remember() {
    try {
      var kept = chosen.filter(function (item) { return !item.pending; });
      if (kept.length) sessionStorage.setItem(CHOICE, JSON.stringify(kept)); else sessionStorage.removeItem(CHOICE);
    } catch (e) {}
  }

  function showError(text) {
    error.textContent = text;
    error.hidden = !text;
  }

  function csrf() {
    var match = document.cookie.match(/(?:^|;\s*)clp_addons_csrf=([^;]+)/);
    if (match) return Promise.resolve(match[1]);
    // A CloudPanel page sets no cookie of ours; this route hands one out and reads nothing.
    return fetch(url + '/api/session', { credentials: 'same-origin' }).then(function () {
      var again = document.cookie.match(/(?:^|;\s*)clp_addons_csrf=([^;]+)/);
      if (!again) throw new Error('WordPress Tools did not answer. Reload the page and try again.');
      return again[1];
    });
  }

  function call(path, options) {
    options = options || {};
    var ready = options.method === 'POST' ? csrf() : Promise.resolve('');
    return ready.then(function (token) {
      options.credentials = 'same-origin';
      options.headers = options.headers || {};
      if (token) options.headers['X-CLP-Addons-CSRF'] = token;
      return fetch(url + path, options);
    }).then(function (response) {
      return response.json().catch(function () {
        return { ok: false, error: 'WordPress Tools answered ' + response.status };
      });
    }, function () {
      return { ok: false, error: 'WordPress Tools did not answer' };
    }).then(function (reply) {
      if (!reply.ok) throw new Error(reply.error || 'the request failed');
      return reply.data;
    });
  }

  function has(slug) {
    return chosen.some(function (item) { return item.slug.toLowerCase() === slug.toLowerCase(); });
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function paint() {
    list.textContent = '';
    chosen.forEach(function (item) {
      var row = element('li', 'clp-wp-plugin-item');
      row.appendChild(element('span', 'clp-wp-plugin-name', item.name));
      row.appendChild(element('span', 'clp-wp-plugin-source', item.pending ? 'Uploading…' : item.source === 'upload' ? 'Uploaded zip' : 'WordPress.org'));
      if (!item.pending) {
        var label = element('label', 'form-check clp-wp-plugin-activate');
        var check = element('input', 'form-check-input');
        check.type = 'checkbox';
        check.checked = item.activate;
        check.addEventListener('change', function () { item.activate = check.checked; remember(); });
        label.appendChild(check);
        label.appendChild(element('span', 'form-check-label', 'Activate'));
        row.appendChild(label);
        var remove = element('button', 'btn-close clp-wp-plugin-remove');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Remove ' + item.name);
        remove.addEventListener('click', function () { drop(item); });
        row.appendChild(remove);
      }
      list.appendChild(row);
    });
    list.hidden = chosen.length === 0;
    remember();
  }

  function drop(item) {
    chosen = chosen.filter(function (other) { return other !== item; });
    // Nothing waits on the answer: an upload nobody claims expires on its own.
    if (item.id) call('/api/plugin-discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) }).catch(function () {});
    paint();
    paintResults();
  }

  function full() {
    if (chosen.length < MAX) return false;
    showError('A new site takes at most ' + MAX + ' plugins.');
    return true;
  }

  // --- search ---------------------------------------------------------------

  var found = [];
  // Installed on every new site by WordPress Tools' own automation, which owns them.
  var automatic = [];
  var AUTOMATIC_LABEL = 'Installed automatically';
  function paintResults() {
    results.textContent = '';
    found.forEach(function (plugin) {
      var row = element('li');
      row.setAttribute('role', 'presentation');
      var pick = element('button', 'clp-wp-plugin-result');
      pick.type = 'button';
      pick.setAttribute('role', 'option');
      var head = element('span', 'clp-wp-plugin-result-head');
      head.appendChild(element('strong', '', plugin.name));
      var meta = [plugin.author ? 'by ' + plugin.author : '', installs(plugin.activeInstalls)].filter(Boolean).join(' · ');
      if (meta) head.appendChild(element('span', 'clp-wp-plugin-meta', meta));
      pick.appendChild(head);
      if (plugin.summary) pick.appendChild(element('span', 'clp-wp-plugin-summary', plugin.summary));
      var added = has(plugin.slug);
      var auto = automatic.indexOf(plugin.slug) !== -1;
      pick.appendChild(element('span', 'clp-wp-plugin-add', auto ? AUTOMATIC_LABEL : added ? 'Added' : 'Add'));
      pick.disabled = added || auto;
      if (auto) pick.classList.add('is-automatic');
      pick.addEventListener('click', function () {
        if (has(plugin.slug) || full()) return;
        showError('');
        chosen.push({ source: 'wordpress.org', slug: plugin.slug, name: plugin.name, activate: true });
        paint();
        paintResults();
      });
      row.appendChild(pick);
      results.appendChild(row);
    });
    results.hidden = found.length === 0;
    search.setAttribute('aria-expanded', found.length ? 'true' : 'false');
  }

  function installs(count) {
    if (!count) return '';
    if (count >= 1000000) return Math.floor(count / 1000000) + 'M+ installs';
    if (count >= 1000) return Math.floor(count / 1000) + 'k+ installs';
    return count + '+ installs';
  }

  function find() {
    var term = search.value.trim();
    var ticket = ++asked;
    if (term.length < 2) { found = []; paintResults(); return; }
    box.classList.add('is-searching');
    call('/api/plugin-search?q=' + encodeURIComponent(term)).then(function (data) {
      if (ticket !== asked) return;
      found = data.plugins;
      automatic = data.automatic || [];
      if (!found.length) showError('WordPress.org has no plugin matching “' + term + '”.'); else showError('');
      paintResults();
    }, function (failure) {
      if (ticket === asked) showError(failure.message);
    }).then(function () {
      if (ticket === asked) box.classList.remove('is-searching');
    });
  }

  search.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(find, 350);
  });
  // Enter searches; it must not submit the form.
  search.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); clearTimeout(timer); find(); }
    if (event.key === 'Escape' && found.length) { event.preventDefault(); found = []; paintResults(); }
  });

  // --- uploads --------------------------------------------------------------

  if (file) file.addEventListener('change', function () {
    var files = Array.prototype.slice.call(file.files || []);
    file.value = '';
    showError('');
    files.forEach(upload);
  });

  function upload(picked) {
    if (!/\.zip$/i.test(picked.name)) { showError(picked.name + ' is not a .zip file.'); return; }
    if (picked.size > MAX_BYTES) { showError(picked.name + ' is larger than 32 MB.'); return; }
    if (full()) return;
    var item = { source: 'upload', slug: '', name: picked.name, activate: true, pending: true };
    chosen.push(item);
    paint();
    call('/api/plugin-upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: picked }).then(function (data) {
      var plugin = data.upload;
      if (has(plugin.slug)) {
        chosen = chosen.filter(function (other) { return other !== item; });
        call('/api/plugin-discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: plugin.id }) }).catch(function () {});
        showError(plugin.name + ' is already chosen.');
      } else {
        item.pending = false;
        item.id = plugin.id;
        item.slug = plugin.slug;
        item.name = plugin.name + (plugin.version ? ' ' + plugin.version : '');
      }
      paint();
      paintResults();
    }, function (failure) {
      chosen = chosen.filter(function (other) { return other !== item; });
      paint();
      showError(picked.name + ': ' + failure.message);
    });
  }

  // --- submitting -----------------------------------------------------------

  // Ahead of CloudPanel's own handler, which submits the form and starts its
  // progress counter: the choice is recorded first, then the form goes as it
  // would have. Recording it replaces any choice still waiting for the same
  // domain, so a form CloudPanel sent back and submitted again with every
  // plugin removed still clears the one recorded the first time.
  document.addEventListener('submit', function (event) {
    if (event.target !== form || saved) return;
    var domain = domainInput ? domainInput.value.trim().toLowerCase() : '';
    var ready = chosen.filter(function (item) { return !item.pending; });
    var earlier = null;
    try { earlier = JSON.parse(sessionStorage.getItem(JOB) || 'null'); } catch (e) {}
    var clearing = !ready.length && earlier && earlier.domain === domain;
    // A form CloudPanel will send back anyway, or nothing chosen now or before.
    if (!domain || (!chosen.length && !clearing)) {
      if (!chosen.length) try { sessionStorage.removeItem(JOB); } catch (e) {}
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (ready.length !== chosen.length) { showError('Wait for the upload to finish, then create the site.'); return; }
    var buttons = form.querySelectorAll('button[type="submit"], input[type="submit"]');
    var busy = function (on) { Array.prototype.forEach.call(buttons, function (button) { button.disabled = on; }); };
    busy(true);
    showError('');
    call('/api/new-site', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: domain,
        plugins: ready.filter(function (item) { return item.source !== 'upload'; }).map(function (item) { return { slug: item.slug, activate: item.activate }; }),
        uploads: ready.filter(function (item) { return item.source === 'upload'; }).map(function (item) { return { id: item.id, activate: item.activate }; })
      })
    }).then(function (data) {
      try {
        if (data.job) sessionStorage.setItem(JOB, JSON.stringify({ domain: domain, id: data.job.id }));
        else sessionStorage.removeItem(JOB);
      } catch (e) {}
      saved = true;
      busy(false);
      if (form.requestSubmit) form.requestSubmit(); else window.jQuery(form).trigger('submit');
    }, function (failure) {
      busy(false);
      showError(clearing
        ? 'The plugins chosen before could not be cleared: ' + failure.message.replace(/\.?$/, '.') + ' Try again.'
        : 'The plugins could not be saved: ' + failure.message.replace(/\.?$/, '.') + ' Remove them to create the site without them.');
    });
  }, true);

  paint();
})();
