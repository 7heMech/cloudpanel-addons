// Fills `alert` for a site whose Cloudflare zone waits for its nameservers:
// what happens to the certificate, then the one thing to do. Each nameserver
// is a button that copies it alone, since a registrar has a field per nameserver.
function clpNameserverNotice(alert, zone, nameServers, next) {
  if (!document.getElementById('clp-ns-style')) {
    var style = document.createElement('style');
    style.id = 'clp-ns-style';
    style.textContent = clpNameserverAssets.style;
    document.head.appendChild(style);
  }
  alert.className = 'alert alert-warning';
  alert.textContent = '';
  var title = document.createElement('strong');
  title.textContent = zone + ' is waiting for its nameservers.';
  alert.appendChild(title);
  alert.appendChild(document.createTextNode((next ? ' ' + next : '') + ' At the domain’s registrar, set its nameservers to '));
  nameServers.forEach(function (server, i) {
    if (i) alert.appendChild(document.createTextNode(i === nameServers.length - 1 ? ' and ' : ', '));
    var code = document.createElement('code');
    code.textContent = server;
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'clp-ns-copy';
    copy.title = 'Copy';
    copy.setAttribute('aria-label', 'Copy ' + server);
    copy.innerHTML = clpNameserverAssets.clipboard;
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
        var copied = alert.querySelectorAll('.copied');
        for (var j = 0; j < copied.length; j++) copied[j].classList.remove('copied');
        copy.classList.add('copied');
        copy.title = 'Copied';
      }, select);
    });
    alert.appendChild(copy);
  });
  alert.appendChild(document.createTextNode('.'));
}
