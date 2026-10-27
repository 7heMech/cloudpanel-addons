// A site's SSL/TLS page, for anyone who can open it: while DNS waits for the
// site's Cloudflare zone to be activated, say so and which nameservers to set,
// since that is what the certificate is waiting for. Says nothing otherwise.
(function () {
  var box = document.currentScript.previousElementSibling;
  if (!box || !box.hasAttribute('data-clp-dns-site')) return;
  fetch(box.getAttribute('data-status-url'), { credentials: 'same-origin' }).then(function (response) {
    return response.ok ? response.json() : null;
  }).then(function (reply) {
    var data = reply && reply.ok ? reply.data : null;
    if (!data || !data.zone || data.status === 'active' || !data.nameServers.length) return;
    var alert = document.createElement('div');
    alert.className = 'alert alert-warning';
    alert.setAttribute('role', 'status');
    var title = document.createElement('strong');
    title.textContent = data.zone + ' is waiting for its nameservers.';
    alert.appendChild(title);
    alert.appendChild(document.createTextNode(' At the domain’s registrar, replace its nameservers with these. The Let’s Encrypt certificate is requested automatically once Cloudflare sees them.'));
    var list = document.createElement('div');
    list.className = 'clp-dns-nameservers';
    data.nameServers.forEach(function (server) {
      var code = document.createElement('code');
      code.textContent = server;
      list.appendChild(code);
    });
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-white btn-sm';
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(data.nameServers.join('\n')).then(function () { copy.textContent = 'Copied'; });
    });
    list.appendChild(copy);
    alert.appendChild(list);
    box.appendChild(alert);
  }).catch(function () {});
})();
