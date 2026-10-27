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
    alert.setAttribute('role', 'status');
    clpNameserverNotice(alert, data.zone, data.nameServers, {
      automatic: 'The Let’s Encrypt certificate is requested automatically once Cloudflare sees them.',
      manual: 'Once Cloudflare sees them, request a Let’s Encrypt certificate under Actions.',
    }[data.certificate] || '');
    box.appendChild(alert);
  }).catch(function () {});
})();
