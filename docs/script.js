// Ani-sync OAuth callback page.
//
// Implicit Grant (AniList OAuth).
//
//   1. Plugin opens this URL in the system browser.
//   2. We redirect to AniList's authorize endpoint with response_type=token.
//   3. User clicks Authorize. AniList redirects back here with
//      #access_token=<JWT> in the URL fragment.
//   4. We redirect to obsidian://ani-sync?token=TOKEN so Obsidian catches it.

const ANISYNC_CLIENT_ID = "44093";
const ANILIST_AUTHORIZE_URL = "https://anilist.co/api/v2/oauth/authorize";

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function parseAccessTokenFromHash() {
  const hash = window.location.hash || "";
  const stripped = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(stripped);
  return params.get("access_token");
}

function show(id) {
  for (const el of document.querySelectorAll("main.card")) {
    el.classList.add("hidden");
  }
  document.getElementById(id).classList.remove("hidden");
}

function showError(msg) {
  show("state-error");
  document.getElementById("msg-error").textContent = msg;
}

(function init() {
  const errorParam = getQueryParam("error");
  if (errorParam) {
    const desc = getQueryParam("error_description") || "(no description)";
    showError(`AniList OAuth error: ${errorParam} — ${decodeURIComponent(desc)}`);
    return;
  }

  const token = parseAccessTokenFromHash();
  if (token) {
    show("state-success");
    // Redirect to Obsidian via deep link — this is the reliable path
    window.location.href = "obsidian://ani-sync?token=" + encodeURIComponent(token);
    // Attempt to auto-close the tab after a brief delay
    // (window.close() only works for script-opened tabs)
    setTimeout(() => {
      window.close();
    }, 1500);
    return;
  }

  // Initial visit: bounce to AniList
  show("state-redirect");
  const url =
    `${ANILIST_AUTHORIZE_URL}` +
    `?client_id=${encodeURIComponent(ANISYNC_CLIENT_ID)}` +
    `&response_type=token`;
  window.location.replace(url);
})();
