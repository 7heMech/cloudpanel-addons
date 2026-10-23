var card = document.getElementById("clp-security-keys");
if (card) {
  var list = card.querySelector(".clp-sk-list");
  var form = card.querySelector(".clp-sk-add");
  var nameInput = form.querySelector("input");
  var errorBox = card.querySelector(".clp-sk-error");
  var usable = keysUsable();
  var syncedPasskeys = true;

  var csrfHeader = function () {
    var match = document.cookie.match(/(?:^|;\s*)clp_addons_csrf=([^;]+)/);
    return { "X-CLP-Addons-CSRF": match ? match[1] : "" };
  };
  var showError = function (message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  };
  var day = function (iso) {
    return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
  };

  // What root says this account may do, painted with every reply.
  var applyPolicy = function (data) {
    if (data.canAdd === undefined) return;
    syncedPasskeys = data.syncedPasskeys;
    card.querySelector(".clp-sk-unsupported").hidden = usable || !data.canAdd;
    card.querySelector(".clp-sk-off").hidden = data.canAdd;
    card.querySelector(".clp-sk-hardware").hidden = !usable || !data.canAdd || data.syncedPasskeys;
    form.hidden = !usable || !data.canAdd;
  };

  var render = function (data) {
    applyPolicy(data);
    var keys = data.keys;
    list.textContent = "";
    if (!keys.length) {
      var none = document.createElement("p");
      none.className = "clp-sk-none";
      none.textContent = "No security keys yet.";
      list.appendChild(none);
      return;
    }
    var items = document.createElement("ul");
    items.className = "clp-sk-keys";
    keys.forEach(function (key) {
      var item = document.createElement("li");
      var about = document.createElement("div");
      var name = document.createElement("strong");
      name.textContent = key.name;
      var meta = document.createElement("span");
      meta.className = "clp-sk-meta";
      meta.textContent = "Added " + day(key.createdAt) + " \u00b7 " + (key.lastUsedAt ? "Last used " + day(key.lastUsedAt) : "Never used");
      meta.title = "Added " + new Date(key.createdAt).toLocaleString() +
        (key.lastUsedAt ? "\nLast used " + new Date(key.lastUsedAt).toLocaleString() : "");
      about.appendChild(name);
      about.appendChild(meta);
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-white";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", "Remove " + key.name);
      remove.addEventListener("click", function () {
        if (!confirm('Remove "' + key.name + '"? You will no longer be able to sign in with it.')) return;
        showError("");
        remove.disabled = true;
        postJson("ADDON_URL/api/remove", { id: key.id }, csrfHeader()).then(function (reply) {
          render(reply.data);
        }).catch(function (error) {
          remove.disabled = false;
          showError(error.message);
        });
      });
      item.appendChild(about);
      item.appendChild(remove);
      items.appendChild(item);
    });
    list.appendChild(items);
  };

  fetch("ADDON_URL/api/keys", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(readReply)
    .then(function (reply) { render(reply.data); })
    .catch(function (error) { showError(error.message); });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var button = form.querySelector("button");
    button.disabled = true;
    showError("");
    var started;
    postJson("ADDON_URL/api/register-options", {}, csrfHeader()).then(function (reply) {
      started = reply.data;
      return navigator.credentials.create({
        publicKey: {
          challenge: fromB64(started.challenge),
          rp: { name: "CloudPanel" },
          user: { id: fromB64(started.user.id), name: started.user.name, displayName: started.user.name },
          pubKeyCredParams: [
            { type: "public-key", alg: -8 },
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          excludeCredentials: started.exclude.map(function (id) { return { type: "public-key", id: fromB64(id) }; }),
          authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
          attestation: "none",
          // Asks the browser to offer a plugged-in key before a password manager.
          hints: syncedPasskeys ? [] : ["security-key"],
          timeout: 120000,
        },
      });
    }).then(function (credential) {
      return postJson("ADDON_URL/api/register", {
        challengeId: started.challengeId,
        name: nameInput.value,
        response: {
          clientDataJSON: toB64(credential.response.clientDataJSON),
          attestationObject: toB64(credential.response.attestationObject),
        },
      }, csrfHeader());
    }).then(function (reply) {
      nameInput.value = "";
      render(reply.data);
    }).catch(function (error) {
      showError(keyError(error, "The key could not be added."));
    }).then(function () {
      button.disabled = false;
    });
  });
}
