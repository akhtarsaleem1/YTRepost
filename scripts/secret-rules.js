'use strict';

function inspect(file, content) {
  const reasons = [];
  if (/(^|\/)\.env(?:\..*)?$/.test(file) && !file.endsWith('/.env.example') && file !== '.env.example') reasons.push('environment file');
  if (/(?:\.(?:pem|key|p12|pfx)|(?:^|\/)(?:credentials|client_secret|service-account|tokens?)[^/]*\.json|(?:^|\/)cookies[^/]*\.txt)$/i.test(file)) reasons.push('credential file');
  const patterns = [
    ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
    ['Google OAuth client secret', /GOCSPX-[0-9A-Za-z_-]{20,}/],
    ['Google refresh token', /1\/\/[0-9A-Za-z_-]{30,}/],
    ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
    ['AWS access key', /(?:AKIA|ASIA)[A-Z0-9]{16}/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['credential-bearing URL', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ];
  for (const [label, pattern] of patterns) if (pattern.test(content)) reasons.push(label);
  return reasons;
}

module.exports = { inspect };
