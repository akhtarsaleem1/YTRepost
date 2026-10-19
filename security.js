'use strict';

const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
  ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const digest = value => createHash('sha256').update(String(value)).digest();
const equal = (a, b) => timingSafeEqual(digest(a), digest(b));

function securityHeaders(config) {
  return (req, res, next) => {
    const nonce = randomBytes(24).toString('base64');
    res.locals.cspNonce = nonce;
    res.set({
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; " +
        `script-src 'nonce-${nonce}'; style-src 'unsafe-inline' https://fonts.googleapis.com; ` +
        "font-src https://fonts.gstatic.com; connect-src 'self'; form-action 'self'",
    });
    if (config.secureCookies) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  };
}

function requireAdmin(config, now = Date.now) {
  const failures = new Map();
  const windowMs = 5 * 60 * 1000;
  return (req, res, next) => {
    const timestamp = now();
    for (const [key, value] of failures) if (value.expires <= timestamp) failures.delete(key);
    const address = req.socket.remoteAddress;
    const entry = failures.get(address);
    if (entry?.count >= 20) {
      res.set('Retry-After', String(Math.ceil((entry.expires - timestamp) / 1000)));
      return res.status(429).send('Too many failed login attempts. Try again later.');
    }
    const header = req.get('authorization') || '';
    const match = header.length <= 2048 && /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
    const decoded = match ? Buffer.from(match[1], 'base64').toString('utf8') : '';
    const separator = decoded.indexOf(':');
    const username = decoded.slice(0, separator);
    const password = separator < 0 ? '' : decoded.slice(separator + 1);
    if (!equal(password, config.adminPassword) || username !== 'admin') {
      // Unauthenticated requests without a password do not consume the login budget.
      if (header) {
        if (failures.size >= 10000) failures.delete(failures.keys().next().value);
        failures.set(address, { count: (entry?.count || 0) + 1, expires: entry?.expires || timestamp + windowMs });
      }
      res.set('WWW-Authenticate', 'Basic realm="YT Reposter", charset="UTF-8"');
      return res.status(401).send('Authentication required.');
    }
    failures.delete(address);
    next();
  };
}

function requireSameOrigin(config) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if ((origin && origin !== config.appUrl) || req.get('x-requested-with') !== 'YTReposter') {
      return res.status(403).json({ ok: false, error: 'Request verification failed.' });
    }
    next();
  };
}

function createOAuthState(config, now = Date.now) {
  const pending = new Map();
  const cookieName = config.secureCookies ? '__Host-ytr_oauth' : 'ytr_oauth';
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', path: '/' };
  return {
    issue(res) {
      for (const [key, value] of pending) if (value.expires <= now()) pending.delete(key);
      if (pending.size >= 100) pending.delete(pending.keys().next().value);
      const state = randomBytes(32).toString('hex');
      const binding = randomBytes(32).toString('hex');
      const verifier = randomBytes(32).toString('base64url');
      pending.set(state, { binding: digest(binding), verifier, expires: now() + 10 * 60 * 1000 });
      res.cookie(cookieName, binding, { ...cookieOptions, maxAge: 10 * 60 * 1000 });
      return { state, challenge: createHash('sha256').update(verifier).digest('base64url') };
    },
    consume(req, res) {
      const state = req.query.state;
      const entry = typeof state === 'string' ? pending.get(state) : null;
      const cookie = (req.get('cookie') || '').split(';').map(value => value.trim())
        .find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      res.clearCookie(cookieName, cookieOptions);
      if (!entry || entry.expires <= now() || !cookie || !timingSafeEqual(digest(cookie), entry.binding)) return null;
      pending.delete(state);
      return entry.verifier;
    },
  };
}

module.exports = { escapeHtml, securityHeaders, requireAdmin, requireSameOrigin, createOAuthState };
