/** Local app only: reject DNS rebinding hosts and cross-origin browser writes. */
export function allowLocalRequest(req, port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(String(req.headers.host || '').toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin && ![...hosts].some(host => origin === `http://${host}`)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}
