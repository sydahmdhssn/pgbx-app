// Shared by the /api functions (files starting with "_" are not deployed as endpoints).
// Browsers may call these APIs only from the app itself: production, its preview deployments, and local development.
export const ALLOWED_ORIGIN = /^https:\/\/pgbx-app(?:-[a-z0-9-]+)?\.vercel\.app$|^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

// Adds CORS headers only for allowed origins. Same-origin requests need none. Note that CORS only limits other
// websites running in a browser; it does not stop scripts on a server, so it is not an access control.
export function allowOrigin(req, res, methods = 'GET') {
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', methods + ', OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  return origin;
}
