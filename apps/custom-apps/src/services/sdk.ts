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
 *
 * With the remote-operation modules it also: reports uncaught errors and unhandled rejections as
 * crashes (`crashes`); sends `FSCustomApps.log()` entries at or above the level the server asks for
 * (`logs`); keeps the flags and config, refetched when the heartbeat's tag changes (`config`); keeps
 * the running messages for the page to show, and confirms the ones it marks seen (`messages`); and
 * answers commands (`commands`) — `reload_config` and `restart_app` (a page reload) it runs itself,
 * anything else goes to the page's `onCommand` handler, and fails as unsupported when there is none.
 * With `support`, `FSCustomApps.openTicket({ subject, message, name, email })` opens a support
 * ticket, and `tickets()`, `ticket(id)` and `replyTicket(id, message)` read and continue them.
 * A website always reports by ping: browsers cannot set the header a socket would need.
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
  function has(module) { return CONFIG.modules.indexOf(module) !== -1; }
  var LEVELS = ['debug', 'info', 'warning', 'error', 'fatal'];
  var interval = CONFIG.intervalSeconds;
  var state = null;
  var listeners = { state: [], config: [], messages: [], command: [] };
  var queue = [];
  var logs = [];
  var logLevel = 'info';
  var remote = { flags: {}, config: {}, config_version: 0 };
  var configTag = null;
  var messageList = [];
  var messagesTag = null;
  var handled = {};
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
  if (stored.remote) { remote = stored.remote; configTag = stored.config_tag || null; }

  function emit(kind, detail) {
    var list = listeners[kind];
    for (var i = 0; i < list.length; i++) { try { list[i](detail); } catch (e) {} }
    try { window.dispatchEvent(new CustomEvent('fscustomapps:' + kind, { detail: detail })); } catch (e) {}
  }
  function call(path, body, auth, keepalive, headers) {
    var all = { 'Content-Type': 'application/json' };
    if (headers) for (var key in headers) all[key] = headers[key];
    if (auth) all.Authorization = 'Bearer ' + stored.access_token;
    return fetch(CONFIG.baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: all,
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
  function authed(path, body, keepalive, headers) {
    var ready = stored.access_token ? Promise.resolve() : enroll();
    return ready.then(function () {
      return call(path, body, true, keepalive, headers).then(function (response) {
        if (response.status !== 401 || keepalive) return response;
        return refresh().then(function () { return call(path, body, true, false, headers); });
      });
    });
  }
  function supportCall(path, body) {
    if (!has('support')) return Promise.reject(new Error('the support module is not enabled for this app'));
    return authed(path, body).then(function (response) {
      return response.json().then(function (json) {
        if (!response.ok) throw new Error(json && json.error ? json.error : 'support request failed');
        return json.data;
      });
    });
  }
  function setState(next) {
    if (!next) return;
    var changed = !state || state.state !== next.state || state.message !== next.message;
    state = next;
    if (changed) emit('state', state);
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
  function fetchConfig() {
    if (!has('config')) return Promise.resolve();
    return authed('/config', undefined, false, configTag ? { 'If-None-Match': configTag } : null).then(function (response) {
      if (response.status === 304 || !response.ok) return;
      configTag = response.headers.get('ETag');
      return response.json().then(function (json) {
        remote = json.data;
        stored.remote = remote;
        stored.config_tag = configTag;
        save(stored);
        emit('config', remote);
      });
    }).catch(function () {});
  }
  function fetchMessages() {
    if (!has('messages')) return Promise.resolve();
    return authed('/messages', undefined, false, messagesTag ? { 'If-None-Match': messagesTag } : null).then(function (response) {
      if (response.status === 304 || !response.ok) return;
      messagesTag = response.headers.get('ETag');
      return response.json().then(function (json) { messageList = json.data; emit('messages', messageList); });
    }).catch(function () {});
  }
  function ack(id, status, result) {
    return authed('/commands/' + id + '/ack', { status: status, result: result || null }).catch(function () {});
  }
  function runCommand(command) {
    if (handled[command.id]) return;
    handled[command.id] = true;
    if (command.type === 'reload_config') {
      configTag = null;
      fetchConfig().then(function () { ack(command.id, 'succeeded'); });
      return;
    }
    if (command.type === 'restart_app') {
      ack(command.id, 'succeeded').then(function () { location.reload(); });
      return;
    }
    if (!listeners.command.length) {
      ack(command.id, 'failed', { error: 'unsupported on the web' });
      return;
    }
    var done = false;
    function reply(status, result) { if (!done) { done = true; ack(command.id, status, result); } }
    emit('command', { id: command.id, type: command.type, payload: command.payload, succeed: function (result) { reply('succeeded', result); }, fail: function (result) { reply('failed', result); } });
  }
  function apply(data) {
    setState(data.state);
    applyPresence(data.presence);
    var sync = data.sync || {};
    if (sync.log_level) logLevel = sync.log_level;
    if (has('config') && sync.config_etag && sync.config_etag !== configTag) fetchConfig();
    if (has('messages') && sync.messages_etag && sync.messages_etag !== messagesTag) fetchMessages();
    if (has('commands') && data.commands) for (var i = 0; i < data.commands.length; i++) runCommand(data.commands[i]);
  }
  function heartbeat() {
    return authed('/heartbeat', { active_seconds: takeVisibleSeconds(), app_version: window.FSCustomAppsVersion || null })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (json) { if (json) apply(json.data); })
      .catch(function () {});
  }
  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () { heartbeat(); flush(false); }, interval * 1000);
  }
  function event(type, name, properties) {
    if (!has('events')) return;
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
  function log(level, message, context) {
    if (!has('logs') || LEVELS.indexOf(level) < LEVELS.indexOf(logLevel)) return;
    logs.push({ id: uuid(), level: level, message: String(message), target: 'web', occurred_at: new Date().toISOString(), context: context || null });
    if (logs.length >= 20) flush(false);
  }
  function flush(final) {
    if (queue.length) {
      var batch = queue.splice(0, 100);
      authed('/events', { events: batch }, final).catch(function () { if (!final) queue = batch.concat(queue); });
    }
    if (logs.length) {
      var entries = logs.splice(0, 100);
      authed('/logs', { entries: entries }, final).catch(function () { if (!final) logs = entries.concat(logs); });
    }
  }
  function crash(kind, message, stack) {
    if (!has('crashes')) return;
    authed('/crashes', { crashes: [{
      id: uuid(),
      occurred_at: new Date().toISOString(),
      app_version: window.FSCustomAppsVersion || null,
      kind: kind,
      message: message ? String(message).slice(0, 2000) : null,
      stack: stack ? String(stack) : null,
      context: { url: location.href }
    }] }).catch(function () {});
  }

  window.addEventListener('error', function (e) {
    var error = e.error;
    crash(error && error.name ? error.name : 'Error', e.message || (error && error.message), error && error.stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    crash('UnhandledRejection', reason && reason.message ? reason.message : String(reason), reason && reason.stack);
  });
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

  function on(kind, listener, current) {
    listeners[kind].push(listener);
    if (current) listener(current);
  }

  window.FSCustomApps = {
    installationId: function () { return stored.installation_id || null; },
    state: function () { return state; },
    onState: function (listener) { on('state', listener, state); },
    track: function (name, properties) { event('action', name, properties); },
    screen: function (name, properties) { event('screen', name || location.pathname, properties); },
    custom: function (name, properties) { event('custom', name, properties); },
    log: function (level, message, context) { log(level, message, context); },
    flag: function (key, fallback) { return Object.prototype.hasOwnProperty.call(remote.flags, key) ? remote.flags[key] : fallback; },
    config: function () { return remote.config; },
    onConfig: function (listener) { on('config', listener, configTag ? remote : null); },
    messages: function () { return messageList; },
    onMessages: function (listener) { on('messages', listener, messagesTag ? messageList : null); },
    markSeen: function (id) {
      return authed('/messages/' + id + '/seen', {}).then(function () {
        for (var i = 0; i < messageList.length; i++) if (messageList[i].id === id) messageList[i].seen = true;
      }).catch(function () {});
    },
    onCommand: function (listener) { listeners.command.push(listener); },
    openTicket: function (request) { return supportCall('/tickets', request || {}); },
    tickets: function () { return supportCall('/tickets'); },
    ticket: function (id) { return supportCall('/tickets/' + id); },
    replyTicket: function (id, message, name) { return supportCall('/tickets/' + id + '/messages', { message: message, name: name || null }); }
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
