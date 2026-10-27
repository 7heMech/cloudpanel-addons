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
    var next = {
      automatic: ' The Let\u2019s Encrypt certificate is requested automatically once Cloudflare sees them.',
      manual: ' Once Cloudflare sees them, request a Let\u2019s Encrypt certificate under Actions.',
    }[data.certificate] || '';
    alert.appendChild(document.createTextNode(' At the domain\u2019s registrar, replace its nameservers with these.' + next));
    var list = document.createElement('div');
    list.className = 'clp-dns-nameservers';
    // Each name and its icon copy one value: registrars have a field per nameserver.
    data.nameServers.forEach(function (server) {
      var code = document.createElement('code');
      code.textContent = server;
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.title = 'Copy';
      copy.setAttribute('aria-label', 'Copy ' + server);
      copy.innerHTML = box.getAttribute('data-clipboard');
      copy.insertBefore(code, copy.firstChild);
      // Without the clipboard, the nameserver is selected so Ctrl+C finishes the job.
      function select() {
        var range = document.createRange();
        range.selectNodeContents(code);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        copy.title = 'Selected; press Ctrl+C to copy';
      }
      copy.addEventListener('click', function () {
        if (!navigator.clipboard || !navigator.clipboard.writeText) return select();
        navigator.clipboard.writeText(server).then(function () {
          var copied = list.querySelectorAll('.copied');
          for (var i = 0; i < copied.length; i++) copied[i].classList.remove('copied');
          copy.classList.add('copied');
          copy.title = 'Copied';
        }, select);
      });
      list.appendChild(copy);
    });
    alert.appendChild(list);
    box.appendChild(alert);
  }).catch(function () {});
})();
