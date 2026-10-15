import type { AppModule } from '@/lib/config'

/**
 * `sdk.js`: the script a website embeds to report to the ingest surface.
 *
 * The Rust apps get no SDK by decision — each integrates the handful of endpoints it needs from its
 * `openapi.json`. A website is different: it is the same few lines every time, and the person adding
 * them is editing a template, not writing an integration. So each app gets its own pre-generated
 * script with its id, its public key and its modules baked in, and nothing to configure.
 *
 * The output is **deterministic** for a given app configuration — no timestamps, no build ids — so
 * its SHA-384 is stable and a page can pin it with Subresource Integrity. Changing the app's modules,
 * interval or key changes the bytes, and therefore the hash the panel quotes.
 *
 * What it does, in order: keeps a device id and the installation's tokens in `localStorage` (the
 * plan's decision for the web), enrolls on first load, sends a heartbeat every interval carrying the
 * seconds the tab was visible, refreshes or re-enrolls on a 401, and — with the `events` module —
 * sends `session_start` / `screen` / `session_end` plus whatever the page reports through
 * `FSCustomApps.track()`. The final flush uses `fetch(…, { keepalive: true })` rather than
 * `sendBeacon`, because a beacon cannot carry the `Authorization` header.
 */

type SdkConfig = {
  appId: string
  appKey: string
  baseUrl: string
  intervalSeconds: number
  modules: AppModule[]
}

const RUNTIME = String.raw`
  if (window.FSCustomApps) return;
  var STORE = 'fsca:' + CONFIG.appId;
  var hasEvents = CONFIG.modules.indexOf('events') !== -1;
  var interval = CONFIG.intervalSeconds;
  var state = null;
  var listeners = [];
  var queue = [];
  var visibleSince = document.visibilityState === 'visible' ? Date.now() : null;
  var visibleMs = 0;
  var sessionId = uuid();
  var timer = null;

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; }
  }
  function save(value) {
    try { localStorage.setItem(STORE, JSON.stringify(value)); } catch (e) {}
  }
  var stored = load();
  if (!stored.device_id) { stored.device_id = uuid(); save(stored); }

  function call(path, body, auth, keepalive) {
    var headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = 'Bearer ' + stored.access_token;
    return fetch(CONFIG.baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive: !!keepalive,
      credentials: 'omit'
    });
  }
  function keep(tokens) {
    stored.installation_id = tokens.installation_id || stored.installation_id;
    stored.access_token = tokens.access_token;
    stored.refresh_token = tokens.refresh_token;
    save(stored);
  }
  function enroll() {
    var ua = navigator.userAgentData;
    return call('/enroll', {
      app_key: CONFIG.appKey,
      device_id: stored.device_id,
      platform: 'web',
      os_name: ua && ua.platform ? ua.platform : null,
      hostname: location.hostname,
      app_version: window.FSCustomAppsVersion || null
    }).then(function (response) {
      if (!response.ok) throw new Error('enroll ' + response.status);
      return response.json();
    }).then(function (json) { keep(json.data); applyPresence(json.data.presence); setState(json.data.state); });
  }
  function refresh() {
    if (!stored.refresh_token) return enroll();
    return call('/token/refresh', { refresh_token: stored.refresh_token }).then(function (response) {
      if (!response.ok) return enroll();
      return response.json().then(function (json) { keep(json.data); });
    });
  }
  function authed(path, body, keepalive) {
    var ready = stored.access_token ? Promise.resolve() : enroll();
    return ready.then(function () {
      return call(path, body, true, keepalive).then(function (response) {
        if (response.status !== 401 || keepalive) return response;
        return refresh().then(function () { return call(path, body, true); });
      });
    });
  }
  function setState(next) {
    if (!next) return;
    var changed = !state || state.state !== next.state || state.message !== next.message;
    state = next;
    if (changed) {
      for (var i = 0; i < listeners.length; i++) { try { listeners[i](state); } catch (e) {} }
      try { window.dispatchEvent(new CustomEvent('fscustomapps:state', { detail: state })); } catch (e) {}
    }
  }
  function applyPresence(presence) {
    if (presence && presence.interval_seconds && presence.interval_seconds !== interval) {
      interval = presence.interval_seconds;
      schedule();
    }
  }
  function takeVisibleSeconds() {
    var now = Date.now();
    if (visibleSince !== null) { visibleMs += now - visibleSince; visibleSince = now; }
    var seconds = Math.floor(visibleMs / 1000);
    visibleMs -= seconds * 1000;
    return seconds;
  }
  function heartbeat() {
    return authed('/heartbeat', { active_seconds: takeVisibleSeconds(), app_version: window.FSCustomAppsVersion || null })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (json) {
        if (!json) return;
        setState(json.data.state);
        applyPresence(json.data.presence);
      })
      .catch(function () {});
  }
  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () { heartbeat(); flush(false); }, interval * 1000);
  }
  function event(type, name, properties) {
    if (!hasEvents) return;
    queue.push({
      id: uuid(),
      type: type,
      name: name || null,
      session_id: sessionId,
      occurred_at: new Date().toISOString(),
      properties: properties || null
    });
    if (queue.length >= 20) flush(false);
  }
  function flush(final) {
    if (!queue.length) return;
    var batch = queue.splice(0, 100);
    authed('/events', { events: batch }, final).catch(function () { if (!final) queue = batch.concat(queue); });
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      visibleSince = Date.now();
    } else {
      if (visibleSince !== null) { visibleMs += Date.now() - visibleSince; visibleSince = null; }
      flush(true);
    }
  });
  window.addEventListener('pagehide', function () {
    event('session_end', null, null);
    flush(true);
  });

  window.FSCustomApps = {
    installationId: function () { return stored.installation_id || null; },
    state: function () { return state; },
    onState: function (listener) { listeners.push(listener); if (state) listener(state); },
    track: function (name, properties) { event('action', name, properties); },
    screen: function (name, properties) { event('screen', name || location.pathname, properties); },
    custom: function (name, properties) { event('custom', name, properties); }
  };

  event('session_start', null, null);
  event('screen', location.pathname, null);
  heartbeat().then(function () { flush(false); });
  schedule();
`

/** The script for one app. Pure: the same configuration always produces the same bytes. */
const renderSdk = (config: SdkConfig): string => {
  const serialized = JSON.stringify({
    appId: config.appId,
    appKey: config.appKey,
    baseUrl: config.baseUrl,
    intervalSeconds: config.intervalSeconds,
    modules: [...config.modules].sort(),
  })
  return `/*! franciscosolis.cl custom-apps SDK for app ${config.appId}. Generated; do not edit. */
(function () {
  'use strict';
  var CONFIG = ${serialized};
${RUNTIME}})();
`
}

export { renderSdk }
export type { SdkConfig }
