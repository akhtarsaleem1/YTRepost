'use strict';

function loadConfig(env = process.env) {
  const required = ['YOUTUBE_API_KEY', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET',
    'SOURCE_CHANNEL_ID', 'TARGET_CHANNEL_ID', 'ADMIN_PASSWORD'];
  const missing = required.filter(key => !env[key]?.trim() || /^(?:YOUR_|PASTE_|CHANGE_ME|REPLACE_ME)/i.test(env[key]));
  if (missing.length) throw new Error(`Set required environment variables: ${missing.join(', ')}`);
  if (env.ADMIN_PASSWORD.length < 32) throw new Error('ADMIN_PASSWORD must contain at least 32 characters.');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  let url;
  try { url = new URL(env.APP_URL || `http://localhost:${port}`); }
  catch { throw new Error('APP_URL must be a valid absolute URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('APP_URL must be an HTTPS origin (HTTP is allowed only on localhost).');
  }
  const uploadPrivacy = env.UPLOAD_PRIVACY || 'private';
  if (!['private', 'unlisted', 'public'].includes(uploadPrivacy)) throw new Error('Invalid UPLOAD_PRIVACY.');
  const refreshToken = env.TARGET_REFRESH_TOKEN?.trim() || '';
  if (/^(?:YOUR_|PASTE_|CHANGE_ME|REPLACE_ME)/i.test(refreshToken)) throw new Error('Leave TARGET_REFRESH_TOKEN empty until OAuth setup is complete.');
  return { port, appUrl: url.origin, secureCookies: url.protocol === 'https:',
    adminPassword: env.ADMIN_PASSWORD, apiKey: env.YOUTUBE_API_KEY,
    clientId: env.YOUTUBE_CLIENT_ID, clientSecret: env.YOUTUBE_CLIENT_SECRET,
    sourceChannel: env.SOURCE_CHANNEL_ID, targetChannel: env.TARGET_CHANNEL_ID,
    refreshToken, uploadPrivacy };
}

module.exports = { loadConfig };
