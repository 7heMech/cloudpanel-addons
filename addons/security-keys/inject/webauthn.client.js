// Shared by the login button and the account card: base64url both ways, and
// whether this page can use a key at all.
function toB64(buffer) {
  var bytes = new Uint8Array(buffer);
  var text = "";
  for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(value) {
  var text = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  var bytes = new Uint8Array(text.length);
  for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

// Browsers refuse WebAuthn on an IP address and on a certificate error.
function keysUsable() {
  return Boolean(window.PublicKeyCredential && navigator.credentials && window.isSecureContext)
    && !/^[\d.]+$|^\[/.test(location.hostname);
}

function postJson(path, body, headers) {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: Object.assign({ "Content-Type": "application/json", Accept: "application/json" }, headers || {}),
    body: JSON.stringify(body || {}),
  }).then(readReply);
}

function readReply(res) {
  return res.json().catch(function () { return null; }).then(function (reply) {
    if (!res.ok || !reply || reply.ok === false) throw new Error((reply && reply.error) || "request failed with " + res.status);
    return reply;
  });
}

function keyError(error, fallback) {
  // What a browser reports for a cancelled prompt, a timeout, or no key here.
  if (error && error.name === "NotAllowedError") return "No security key was used.";
  if (error && error.name === "InvalidStateError") return "That key is already registered.";
  return (error && error.message) || fallback;
}
