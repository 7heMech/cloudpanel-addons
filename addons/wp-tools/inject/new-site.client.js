// Plugins for the site CloudPanel's New WordPress Site form is about to create.
//
// Written for the panel's page, not for an addon page: no shared client code
// reaches here, so this is plain ES5 with its own fetch. Every name and summary
// shown came from WordPress.org or from a zip, so each goes in as text.
//
// None of these controls has a name: Symfony refuses a field its form does not
// declare. The choice is sent to WordPress Tools instead, just before the form
// is, and the job it records waits for the site. It is left in this tab's
// session storage as the form goes, and read back once, so a form CloudPanel
// sends back with an error still has it, and the page the site lands on can
// follow the job. Any other form starts from the account's own default, or the
// server's.
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
  var defaultsLine = document.getElementById('clp-wp-plugins-defaults');
  var origin = document.getElementById('clp-wp-plugins-origin');
  var saveButton = document.getElementById('clp-wp-plugins-save');
  var resetButton = document.getElementById('clp-wp-plugins-reset');
  var domainInput = form.querySelector('input[id$="_domainName"]');
  // { source: 'wordpress.org' | 'upload', slug, name, activate, id?, pending? }
  var chosen = [];
  var saved = false;
  var timer = null;
  var asked = 0;
  // Installed on every new site by WordPress Tools' own automation, which owns them.
  var automatic = [];
  var AUTOMATIC_LABEL = 'Automatic';
  var AUTOMATIC_TITLE = "Installed on every new site by WordPress Tools' automation";
  // { server, account } once WordPress Tools answers; account is null while it follows the server's.
  var defaults = null;
  // Whether this form has a choice of its own, which a default no longer replaces.
  var settled = false;
  var note = '';
  // Until the defaults answer, a submit waits for them rather than going without them.
  var loading = true;
  var waiting = false;

  // Drawn for administrators only: nobody else may hand a site a zip.
  var canUpload = Boolean(file);
  try {
    var kept = sessionStorage.getItem(CHOICE);
    sessionStorage.removeItem(CHOICE);
    if (kept !== null) {
      chosen = JSON.parse(kept).filter(function (item) {
        return !item.pending && (canUpload || item.source !== 'upload');
      });
      settled = true;
    }
  }
  catch (e) { chosen = []; }

  function remember() {
    try { sessionStorage.setItem(CHOICE, JSON.stringify(chosen.filter(function (item) { return !item.pending; }))); } catch (e) {}
  }

  function touched() {
    settled = true;
    note = '';
  }

  function isAutomatic(item) {
    return item.source !== 'upload' && automatic.indexOf(item.slug) !== -1;
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
      var auto = isAutomatic(item);
      var row = element('li', 'clp-wp-plugin-item');
      row.appendChild(element('span', 'clp-wp-plugin-name', item.name));
      row.appendChild(element('span', 'clp-wp-plugin-source', item.pending ? 'Uploading…' : item.source === 'upload' ? 'Uploaded zip' : 'WordPress.org'));
      if (!item.pending) {
        // Automation installs it on every new site, so the form leaves it out and has nothing to activate.
        if (auto) {
          var automatic = element('span', 'clp-wp-plugin-automatic', AUTOMATIC_LABEL);
          automatic.title = AUTOMATIC_TITLE;
          row.appendChild(automatic);
        } else {
          var label = element('label', 'form-check clp-wp-plugin-activate');
          var check = element('input', 'form-check-input');
          check.type = 'checkbox';
          check.checked = item.activate;
          check.addEventListener('change', function () { touched(); item.activate = check.checked; paintDefaults(); });
          label.appendChild(check);
          label.appendChild(element('span', 'form-check-label', 'Activate'));
          row.appendChild(label);
        }
        var remove = element('button', 'btn-close clp-wp-plugin-remove');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Remove ' + item.name);
        remove.addEventListener('click', function () { drop(item); });
        row.appendChild(remove);
      }
      list.appendChild(row);
    });
    list.hidden = chosen.length === 0;
    paintDefaults();
  }

  function drop(item) {
    touched();
    chosen = chosen.filter(function (other) { return other !== item; });
    // Nothing waits on the answer: an upload nobody claims expires on its own.
    if (item.id) call('/api/plugin-discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) }).catch(function () {});
    paint();
    paintResults();
  }

  function full() {
    if (chosen.filter(function (item) { return !isAutomatic(item); }).length < MAX) return false;
    showError('A new site takes at most ' + MAX + ' plugins.');
    return true;
  }

  // --- search ---------------------------------------------------------------

  var found = [];
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
      var state = element('span', 'clp-wp-plugin-add', auto ? AUTOMATIC_LABEL : added ? 'Added' : 'Add');
      if (auto) state.title = AUTOMATIC_TITLE;
      pick.appendChild(state);
      pick.disabled = added || auto;
      if (auto) pick.classList.add('is-automatic');
      pick.addEventListener('click', function () {
        if (has(plugin.slug) || full()) return;
        showError('');
        touched();
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
      paint();
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
    touched();
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

  // --- defaults --------------------------------------------------------------

  function fromDefault(plugins) {
    return plugins.map(function (plugin) { return { source: 'wordpress.org', slug: plugin.slug, name: plugin.name, activate: plugin.activate }; });
  }

  // The WordPress.org plugins on the form: what a default holds, since an uploaded zip is for one site.
  function directory() {
    return chosen.filter(function (item) { return !item.pending && item.source !== 'upload'; });
  }

  // What saving sends: automation installs the others, so a default cannot hold them.
  function savable() {
    return directory().filter(function (item) { return !isAutomatic(item); })
      .map(function (item) { return { slug: item.slug, name: item.name, activate: item.activate }; });
  }

  function same(plugins, other) {
    return plugins.length === other.length && plugins.every(function (plugin, index) {
      return plugin.slug === other[index].slug && plugin.activate === other[index].activate;
    });
  }

  function paintDefaults() {
    if (!defaultsLine) return;
    if (!defaults) { defaultsLine.hidden = true; return; }
    var mine = defaults.account;
    var current = mine || defaults.server;
    var matches = same(directory(), current);
    origin.textContent = note || (matches && (mine || current.length) ? (mine ? 'Your default' : 'Server default') : '');
    saveButton.hidden = matches;
    resetButton.hidden = !mine;
    defaultsLine.hidden = !origin.textContent && saveButton.hidden && resetButton.hidden;
  }

  function takeDefaults(data) {
    defaults = { server: data.server || [], account: data.account || null };
    automatic = data.automatic || automatic;
  }

  function saveDefault(body, done, failed) {
    saveButton.disabled = resetButton.disabled = true;
    showError('');
    call('/api/my-new-site-defaults', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (data) {
      takeDefaults(data);
      done();
    }, function (failure) {
      showError(failed + ': ' + failure.message.replace(/\.?$/, '.'));
    }).then(function () {
      saveButton.disabled = resetButton.disabled = false;
    });
  }

  if (saveButton) saveButton.addEventListener('click', function () {
    saveDefault({ plugins: savable() }, function () {
      // Left out of the saved default, and of the site, so off the form as well.
      chosen = chosen.filter(function (item) { return !isAutomatic(item); });
      note = 'Saved as your default';
      paint();
      paintResults();
    }, 'Your default could not be saved');
  });

  // The server's default replaces the WordPress.org plugins; an uploaded zip is this site's alone and stays.
  if (resetButton) resetButton.addEventListener('click', function () {
    saveDefault({ reset: true }, function () {
      touched();
      var uploads = chosen.filter(function (item) { return item.source === 'upload'; });
      var taken = uploads.map(function (item) { return item.slug.toLowerCase(); });
      var room = MAX - uploads.length;
      chosen = fromDefault(defaults.server).filter(function (item) {
        if (taken.indexOf(item.slug) !== -1) return false;
        if (isAutomatic(item)) return true;
        return room-- > 0;
      }).concat(uploads);
      paint();
      paintResults();
    }, 'Your default could not be reset');
  });

  call('/api/my-new-site-defaults').then(function (data) {
    takeDefaults(data);
    if (!settled) chosen = fromDefault(defaults.account || defaults.server).slice(0, MAX);
    paint();
    paintResults();
  }, function (failure) {
    // The form works without them; it only starts empty.
    showError('The default plugins could not be loaded: ' + failure.message.replace(/\.?$/, '.'));
  }).then(function () {
    loading = false;
    if (waiting) { waiting = false; send(); }
  });

  function send() {
    if (form.requestSubmit) form.requestSubmit(); else window.jQuery(form).trigger('submit');
  }

  // --- submitting -----------------------------------------------------------

  // Ahead of CloudPanel's own handler, which submits the form and starts its
  // progress counter: the choice is recorded first, then the form goes as it
  // would have. Recording it replaces any choice still waiting for the same
  // domain, so a form CloudPanel sent back and submitted again with every
  // plugin removed still clears the one recorded the first time.
  document.addEventListener('submit', function (event) {
    if (event.target !== form || saved) return;
    if (loading && !settled) {
      event.preventDefault();
      event.stopImmediatePropagation();
      waiting = true;
      return;
    }
    var domain = domainInput ? domainInput.value.trim().toLowerCase() : '';
    var pending = chosen.some(function (item) { return item.pending; });
    // A plugin automation installs is left to it.
    var ready = chosen.filter(function (item) { return !item.pending && !isAutomatic(item); });
    var earlier = null;
    try { earlier = JSON.parse(sessionStorage.getItem(JOB) || 'null'); } catch (e) {}
    var nothing = !ready.length && !pending;
    var clearing = nothing && earlier && earlier.domain === domain;
    // A form CloudPanel will send back anyway, or nothing chosen now or before.
    if (!domain || (nothing && !clearing)) {
      if (nothing) try { sessionStorage.removeItem(JOB); } catch (e) {}
      remember();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (pending) { showError('Wait for the upload to finish, then create the site.'); return; }
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
      remember();
      send();
    }, function (failure) {
      busy(false);
      showError(clearing
        ? 'The plugins chosen before could not be cleared: ' + failure.message.replace(/\.?$/, '.') + ' Try again.'
        : 'The plugins could not be saved: ' + failure.message.replace(/\.?$/, '.') + ' Remove them to create the site without them.');
    });
  }, true);

  paint();
})();
