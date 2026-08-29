// stdin: the daemon's /status JSON. argv[2]: the app URL. stdout: the matching sessionId, or nothing.
// Matching on URL prefix, not "any session": a daemon commonly has other tabs on it, and reporting
// setup complete against somebody else's session is the false green this whole gate exists to stop.
let b = '';
process.stdin
  .on('data', (d) => (b += d))
  .on('end', () => {
    try {
      const m = (JSON.parse(b).sessions || []).find((s) =>
        (s.url || '').startsWith(process.argv[2]),
      );
      if (m) process.stdout.write(m.sessionId);
    } catch {}
  });
