var box = document.getElementById("clp-passkey");
if (box && keysUsable()) {
  box.hidden = false;
  var button = box.querySelector("button");
  var alertBox = document.getElementById("clp-passkey-error");
  var show = function (message) {
    alertBox.textContent = message;
    alertBox.hidden = !message;
  };
  button.addEventListener("click", function () {
    button.disabled = true;
    show("");
    postJson("ADDON_URL/login/options").then(function (options) {
      return navigator.credentials.get({
        publicKey: { challenge: fromB64(options.challenge), userVerification: "required", timeout: 120000 },
      });
    }).then(function (credential) {
      var response = credential.response;
      return postJson("ADDON_URL/login/verify", {
        id: credential.id,
        response: {
          clientDataJSON: toB64(response.clientDataJSON),
          authenticatorData: toB64(response.authenticatorData),
          signature: toB64(response.signature),
          userHandle: response.userHandle ? toB64(response.userHandle) : null,
        },
      });
    }).then(function (reply) {
      // The token is single-use, so /autologin must never be the page's own
      // address: a reload, or Chrome's "Desktop site" toggle, which reloads
      // the URL before redirects, would spend it again.
      return fetch(reply.redirect, { credentials: "same-origin" }).then(function (res) {
        if (res.ok) return location.replace(res.url);
        // CloudPanel's refusal is {"message": …} rather than our {"error": …}.
        return res.json().catch(function () { return null; }).then(function (refusal) {
          throw new Error((refusal && refusal.message) || "Sign-in failed.");
        });
      });
    }).catch(function (error) {
      button.disabled = false;
      show(keyError(error, "Sign-in failed."));
    });
  });
}
