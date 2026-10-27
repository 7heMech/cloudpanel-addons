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
    alert.appendChild(document.createTextNode(' At the domain\u2019s registrar, replace its nameservers with these. The Let\u2019s Encrypt certificate is requested automatically once Cloudflare sees them.'));
    var list = document.createElement('div');
    list.className = 'clp-dns-nameservers';
    // One button each: a registrar usually has a field per nameserver.
    data.nameServers.forEach(function (server) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-white btn-sm';
      button.title = 'Copy';
      var code = document.createElement('code');
      code.textContent = server;
      var state = document.createElement('span');
      state.textContent = 'Copy';
      button.appendChild(code);
      button.appendChild(state);
      button.addEventListener('click', function () {
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(server).then(function () {
          var labels = list.querySelectorAll('button span');
          for (var i = 0; i < labels.length; i++) labels[i].textContent = 'Copy';
          state.textContent = 'Copied';
        });
      });
      list.appendChild(button);
    });
    alert.appendChild(list);
    box.appendChild(alert);
  }).catch(function () {});
})();
