# Security

## Before public release

This repository previously tracked credentials in `.env`, application defaults, and documentation. Removing them from the latest tree does **not** remove them from old commits, other branches, pull requests, or existing clones.

1. Keep the repository private while cleaning up.
2. Revoke or replace every previously committed YouTube API key and OAuth client secret, including earlier secret versions. Revoke any committed OAuth refresh tokens or grants and authorize again. Replace the old setup password with a new, unique `ADMIN_PASSWORD` of at least 32 characters.
3. Store replacements only in local `.env` or private hosting environment variables. Remove the old `SETUP_SECRET`. Restrict the new Google API key to the YouTube Data API and, where your deployment permits, the server's fixed egress IP. OAuth client IDs and channel IDs are identifiers, not passwords, but should be configured through the environment.
4. Rewrite **all affected branches and tags**, removing `.env` and replacing historical embedded credentials. Both `master` and `main` existed during the audit. Scan the complete rewritten history before pushing. Coordinate force pushes with collaborators; they must clone again or carefully rebase, so old commits are not reintroduced.
5. Check pull requests, releases, Actions logs/artifacts, forks, and cached commit URLs. Contact GitHub Support if sensitive data remains accessible after revocation and history cleanup. Never rely on history rewriting as a substitute for revocation.
6. Verify the deployed app uses the new credentials and admin password. Run the tests and a full-history secret scanner, then enable GitHub secret scanning and push protection where available. Only then change repository visibility.

See [GitHub's sensitive-data removal procedure](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) and [Google's OAuth credential and token practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

## Deployment

- Use HTTPS; Basic authentication does not encrypt traffic. `APP_URL` must match the browser's deployment origin.
- All dashboard and control routes require admin authentication. `/healthz` exposes only a health flag. Authentication failures are throttled in memory by the direct peer IP; a shared proxy can share the limit across clients. Add host-level rate limiting for internet deployments.
- Secrets never belong in URLs. The old `?s=` setup parameter has been removed. Do not enable request logging that records Authorization headers, cookies, OAuth authorization codes, or tokens.
- Responses disable caching, suppress referrers, deny framing, and restrict script execution with a per-response CSP nonce. Upstream errors use generic client messages rather than returning credential-bearing provider responses.
- Keep runtime data, downloads, environment files, and credential files out of Git and any public web root. Do not serve the project directory as static files.
- OAuth refresh tokens are shown only to the authenticated administrator after state, browser, PKCE, and target-channel checks. Save the token in private environment settings. Clear sensitive browser tabs after use.
- Run a single instance. OAuth state and login throttling are in memory; multiple instances need shared state and storage before scaling.

## Reporting

Do not open a public issue containing credentials, tokens, environment files, or unredacted logs. Use GitHub's private vulnerability reporting if enabled, or contact the repository owner privately.
