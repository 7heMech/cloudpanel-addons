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
      location.href = reply.redirect;
    }).catch(function (error) {
      button.disabled = false;
      show(keyError(error, "Sign-in failed."));
    });
  });
}
