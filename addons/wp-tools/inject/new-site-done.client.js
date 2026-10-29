// The page a new WordPress site lands on: how its chosen plugins are getting on.
//
// The form's script left the job's id in this tab's session storage. The job
// runs whether or not anyone watches, and WordPress Tools' own page lists what
// it did, so this only follows it and says how it ended. Plain ES5, as on every
// page of the panel's, and everything it shows goes in as text.
(function () {
  var box = document.getElementById('clp-wp-plugins-status');
  if (!box) return;
  var url = box.getAttribute('data-url');
  var domain = box.getAttribute('data-domain');
  var alert = box.querySelector('.alert');
  var job = null;
  try {
    job = JSON.parse(sessionStorage.getItem('clp-addons-new-site-job') || 'null');
    // The site exists, so the choice on the form is spent.
    sessionStorage.removeItem('clp-addons-new-site-plugins');
  } catch (e) {}
  if (!job || !job.id || (domain && job.domain !== domain)) return;
  domain = job.domain;
  box.hidden = false;

  var STATUS = { activated: 'active', installed: 'installed, not activated', present: 'already installed' };

  function show(kind, text, details) {
    alert.className = 'alert alert-' + kind;
    alert.textContent = text;
    if (details && details.length) {
      var list = document.createElement('ul');
      list.className = 'clp-wp-plugins-outcome';
      details.forEach(function (line) {
        var item = document.createElement('li');
        item.textContent = line;
        list.appendChild(item);
      });
      alert.appendChild(list);
    }
    if (kind === 'warning' || kind === 'danger') {
      var link = document.createElement('a');
      link.className = 'alert-link';
      link.href = url + '/';
      link.textContent = 'Open WordPress Tools';
      alert.appendChild(link);
    }
  }

  function finished(view) {
    var result = view.result || { outcome: 'done', plugins: [] };
    if (view.state === 'failed') {
      show('danger', 'The plugins chosen for ' + domain + ' were not installed: ' + (view.error || view.step).replace(/\.?$/, '.'));
      return;
    }
    if (result.outcome !== 'done') {
      show('warning', 'No plugins were installed on ' + domain + ': WordPress Tools did not see the site being created.');
      return;
    }
    var failed = result.plugins.filter(function (plugin) { return plugin.status === 'failed'; });
    var lines = result.plugins.map(function (plugin) {
      return plugin.name + ': ' + (plugin.status === 'failed' ? 'failed, ' + plugin.error : STATUS[plugin.status]);
    });
    if (!failed.length) show('success', 'Plugins installed on ' + domain + ':', lines);
    else show(failed.length === result.plugins.length ? 'danger' : 'warning',
      failed.length + ' of ' + result.plugins.length + ' plugins could not be installed on ' + domain + ':', lines);
  }

  var misses = 0;
  function poll() {
    fetch(url + '/api/jobs/' + encodeURIComponent(job.id), { credentials: 'same-origin' }).then(function (response) {
      return response.json();
    }).then(function (reply) {
      if (!reply.ok) throw new Error(reply.error);
      misses = 0;
      var view = reply.data.job;
      if (view.state === 'done' || view.state === 'failed') { finished(view); return; }
      var count = view.total ? ' (' + Math.min(view.completed + 1, view.total) + ' of ' + view.total + ': ' + view.site + ')' : '';
      show('info', 'Installing the plugins chosen for ' + domain + count + '…');
      setTimeout(poll, 2000);
    }).catch(function () {
      if (++misses < 5) { setTimeout(poll, 3000); return; }
      show('warning', 'WordPress Tools stopped answering while installing the plugins for ' + domain + '. It carries on in the background.');
    });
  }
  show('info', 'Installing the plugins chosen for ' + domain + '…');
  poll();
})();
