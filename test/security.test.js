'use strict';

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { loadConfig } = require('../config');
const { createOAuthState } = require('../security');
const { inspect } = require('../scripts/secret-rules');

const temp = mkdtempSync(path.join(tmpdir(), 'ytr-security-'));
const fixture = {
  YOUTUBE_API_KEY: 'integration-api-value', YOUTUBE_CLIENT_ID: 'integration-client-id',
  YOUTUBE_CLIENT_SECRET: 'integration-client-secret', SOURCE_CHANNEL_ID: 'integration-source',
  TARGET_CHANNEL_ID: 'integration-target', ADMIN_PASSWORD: 'integration-admin-password-with-32-plus-characters',
  TARGET_REFRESH_TOKEN: '', APP_URL: 'http://localhost:3000', UPLOAD_PRIVACY: 'private',
  DB_PATH: path.join(temp, 'state.json'),
};
Object.assign(process.env, fixture);
const { app } = require('../server');
const { google } = require('googleapis');
const fs = require('fs-extra');
const authorization = `Basic ${Buffer.from(`admin:${fixture.ADMIN_PASSWORD}`).toString('base64')}`;
let server, base, exchanged, channelId = fixture.TARGET_CHANNEL_ID, exchangeError = false;

before(async () => {
  mock.method(google.auth.OAuth2.prototype, 'getToken', async options => {
    exchanged = options;
    if (exchangeError) throw new Error('provider-error-with-confidential-token');
    return { tokens: { refresh_token: 'integration-refresh-<script>injection</script>', access_token: 'integration-access-value' } };
  });
  mock.method(google, 'youtube', () => ({ channels: { list: async () => ({ data: { items: [{ id: channelId }] } }) } }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  mock.restoreAll();
  await new Promise(resolve => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
});

function request(route, options = {}) {
  return fetch(base + route, { redirect: 'manual', ...options, headers: { authorization, ...options.headers } });
}
async function start() {
  const response = await request('/auth/start');
  assert.equal(response.status, 302);
  return { url: new URL(response.headers.get('location')), cookie: response.headers.get('set-cookie').split(';')[0] };
}
function callback(flow, extra = {}) {
  return request(`/auth/callback?state=${flow.url.searchParams.get('state')}&code=integration-code`,
    { headers: { cookie: flow.cookie, ...extra } });
}

test('startup fails closed without credentials, with short passwords, or with insecure production URLs', () => {
  assert.throws(() => loadConfig({}), /required environment variables/);
  assert.throws(() => loadConfig({ ...fixture, ADMIN_PASSWORD: 'short' }), /32/);
  assert.throws(() => loadConfig({ ...fixture, APP_URL: 'http://example.com' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...fixture, APP_URL: 'https://' + 'admin:password@example.com' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...fixture, APP_URL: 'https://example.com/?secret=value' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...fixture, TARGET_REFRESH_TOKEN: 'PASTE_TOKEN_HERE' }), /empty/);
  const config = loadConfig({ ...fixture, UPLOAD_PRIVACY: '' });
  assert.equal(config.uploadPrivacy, 'private');
});

test('dashboard, setup, OAuth, status, and write endpoints reject anonymous users without leaking secrets', async () => {
  for (const [route, method] of [['/', 'GET'], ['/setup?s=wrong', 'GET'], ['/auth/start', 'GET'],
    ['/auth/callback?code=untrusted', 'GET'], ['/api/status', 'GET'], ['/api/poll', 'POST'], ['/api/queue/abcdefghijk', 'DELETE']]) {
    const response = await fetch(base + route, { method, redirect: 'manual' });
    assert.equal(response.status, 401, route);
    const body = await response.text();
    for (const key of ['ADMIN_PASSWORD', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_API_KEY']) assert.ok(!body.includes(fixture[key]));
  }
  const oldSetup = await fetch(base + '/setup?s=guess');
  assert.equal(await oldSetup.text(), 'Authentication required.');
  const health = await fetch(base + '/healthz');
  assert.deepEqual(await health.json(), { ok: true });
});

test('authenticated pages have no secret-bearing links or inline event handlers and a matching CSP nonce', async () => {
  const response = await request('/');
  const html = await response.text();
  assert.equal(response.status, 200);
  for (const key of ['ADMIN_PASSWORD', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_API_KEY']) assert.ok(!html.includes(fixture[key]));
  assert.ok(!html.includes('/setup?s='));
  assert.ok(!/onclick=/.test(html));
  const [, nonce, script] = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(response.headers.get('content-security-policy').includes(`'nonce-${nonce}'`));
  assert.ok(!response.headers.get('content-security-policy').includes("script-src 'unsafe-inline'"));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  new vm.Script(script);
  const status = await (await request('/api/status')).text();
  for (const key of ['ADMIN_PASSWORD', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_API_KEY']) assert.ok(!status.includes(fixture[key]));
});

test('cross-site and simple form writes are rejected, while authenticated same-origin controls work', async () => {
  assert.equal((await request('/api/poll', { method: 'POST' })).status, 403);
  assert.equal((await request('/api/poll', { method: 'POST', headers: { origin: 'https://hostile.example', 'X-Requested-With': 'YTReposter' } })).status, 403);
  const response = await request('/api/poll', { method: 'POST', headers: { origin: fixture.APP_URL, 'X-Requested-With': 'YTReposter' } });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /setup/);
  assert.equal((await request('/api/queue/abcdefghijk', { method: 'DELETE', headers: { 'X-Requested-With': 'YTReposter' } })).status, 200);
});

test('OAuth requests use narrow scopes, state, PKCE, and browser-bound cookies', async () => {
  const flow = await start();
  assert.equal(flow.url.origin, 'https://accounts.google.com');
  assert.equal(flow.url.searchParams.get('redirect_uri'), fixture.APP_URL + '/auth/callback');
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(flow.url.searchParams.get('state').length, 64);
  const scopes = flow.url.searchParams.get('scope').split(' ');
  assert.deepEqual(scopes, ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']);
  const noCookie = await callback(flow, { cookie: '' });
  assert.equal(noCookie.status, 400);
  assert.equal((await request('/auth/callback?state=forged&code=integration-code', { headers: { cookie: flow.cookie } })).status, 400);
  const response = await callback(flow);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes('integration-refresh-&lt;script&gt;'));
  assert.ok(!html.includes('integration-refresh-<script>'));
  assert.equal(exchanged.code, 'integration-code');
  assert.equal(createHash('sha256').update(exchanged.codeVerifier).digest('base64url'), flow.url.searchParams.get('code_challenge'));
  assert.equal((await callback(flow)).status, 400);
});

test('OAuth errors and wrong target accounts cannot disclose tokens or raw provider errors', async () => {
  channelId = 'another-channel';
  const mismatch = await callback(await start());
  assert.equal(mismatch.status, 500);
  assert.ok(!(await mismatch.text()).includes('integration-refresh'));
  channelId = fixture.TARGET_CHANNEL_ID;
  exchangeError = true;
  const failed = await callback(await start());
  assert.equal(failed.status, 500);
  assert.ok(!(await failed.text()).includes('confidential-token'));
  exchangeError = false;
});

test('expired OAuth state is rejected and production cookies carry Secure and HttpOnly flags', () => {
  let now = 1;
  const state = createOAuthState({ secureCookies: true }, () => now);
  let name, binding, options;
  const issued = state.issue({ cookie(n, value, settings) { name = n; binding = value; options = settings; } });
  assert.equal(name, '__Host-ytr_oauth');
  assert.equal(options.secure, true);
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, 'lax');
  now += 10 * 60 * 1000 + 1;
  assert.equal(state.consume({ query: { state: issued.state }, get: () => `${name}=${binding}` }, { clearCookie() {} }), null);
});

test('upstream titles, logs, errors, statuses, and IDs are escaped before dashboard HTML insertion', async () => {
  const html = await (await request('/')).text();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { style: {}, classList: { add() {}, remove() {} }, addEventListener() {} });
    return elements.get(id);
  } };
  const context = vm.createContext({ document, fetch: async () => ({ json: async () => ({}) }),
    setInterval() {}, setTimeout() {}, clearTimeout() {} });
  vm.runInContext(script, context);
  const payload = '<img src=x onerror="alert(1)">';
  context.payload = payload;
  vm.runInContext(`render({queue:[{title:payload,videoId:payload,status:payload,error:payload}],jobs:[{title:payload,videoId:payload,status:payload,error:payload,uploadedId:payload}],activeJobs:{}})`, context);
  for (const id of ['qList', 'jList']) {
    assert.ok(elements.get(id).innerHTML.includes('&lt;img'));
    assert.ok(!elements.get(id).innerHTML.includes('<img'));
  }
});

test('unexpected server errors return generic messages without confidential details', async () => {
  const stub = mock.method(fs, 'ensureFile', async () => { throw new Error('confidential-database-details'); });
  const response = await request('/api/status');
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes('confidential-database-details'));
  stub.mock.restore();
});

test('secret rules detect credential files and representative tokens without requiring real secrets', () => {
  assert.ok(inspect('.env', 'not a real credential').length);
  assert.ok(inspect('archive/.env.production', '').length);
  assert.ok(inspect('credentials-backup.json', '').length);
  assert.ok(inspect('server.js', 'AI' + 'za' + 'a'.repeat(35)).length);
  assert.ok(inspect('server.js', 'GOC' + 'SPX-' + 'a'.repeat(24)).length);
  assert.ok(inspect('notes.txt', '1/' + '/' + 'a'.repeat(40)).length);
  assert.deepEqual(inspect('.env.example', 'YOUTUBE_API_KEY='), []);
});

test('repeated failed authentication is throttled without disclosing passwords', async () => {
  const bad = `Basic ${Buffer.from('admin:incorrect').toString('base64')}`;
  for (let i = 0; i < 20; i++) assert.equal((await request('/api/status', { headers: { authorization: bad } })).status, 401);
  const response = await request('/api/status', { headers: { authorization: bad } });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
});
