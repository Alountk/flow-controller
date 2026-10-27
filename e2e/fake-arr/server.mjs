#!/usr/bin/env node
/**
 * fake-arr — zero-dependency Radarr/Sonarr stub for the e2e suite.
 *
 *   Start: node e2e/fake-arr/server.mjs        (PORT env overrides 4000)
 *
 * Node's built-in `http` only, no npm packages: the compose image is stock
 * node:22-alpine with this directory bind-mounted, so there is no install
 * step and nothing to rebuild when a fixture changes.
 *
 * Every fixtures/*.json is loaded once at startup — a missing or malformed
 * fixture fails loudly at boot, not as a mysterious 404 mid-test. Where each
 * payload's shape comes from is documented in fixtures/README.md: they are
 * copied from shapes captured in backend/tests_*.py (or from the fields
 * backend/clients.py actually reads), never invented.
 *
 * Endpoint contract (backend/clients.py is the authority for what the app
 * reads off the wire):
 *   GET  /api/v3/system/status   200 {appName, version}   clients.py:161-162
 *   GET  /api/v3/movie           200 bare array           clients.py:691, 983 (iterated)
 *   GET  /api/v3/movie/{id}      200 one movie            clients.py:451-462 (scan modal metadata)
 *   GET  /api/v3/wanted/missing  200 {records, totalRecords} clients.py:960-962
 *   GET  /api/v3/indexer         200 bare array           clients.py:771 (iterated)
 *   GET  /api/v3/release         200 bare array           clients.py:1342 (iterated)
 *   POST /api/v3/release         201, body discarded      clients.py:1394-1395 (200/201 = ok)
 *   GET  /api/v3/rootfolder      200 [{path}, ...]        clients.py:799
 *   GET  /api/v3/queue           200 {records: [...]}     clients.py:738 (reads .records)
 *   GET  /api/v3/history         200 {records: [...]}     clients.py:724 (reads .records)
 *   GET  /api/v3/downloadclient  200 []                   clients.py:750 returns the body as-is;
 *                                                          traces.py:60 iterates it as list[dict]
 *   GET  /api/v3/series          200 []                   clients.py:691 (iterated; not {records})
 *   GET  /torznab/api            200 Atom feed            torznab_client.py::_parse_rows — S1: the app's
 *                                                         calendar search fans out to ITS OWN Torznab
 *                                                         registry, seeded against this route in Phase 2
 *   POST /api/v2/auth/login      200 "Ok." + SID cookie   qbit_client.py login contract
 *   POST /api/v2/torrents/add    200 "Ok."                qbit_client.py add contract (200 + ""|"Ok.") — S2:
 *                                                         the grab dispatches the row's link here; the stub
 *                                                         records it and adds nothing (see e2e/README.md)
 *   GET  /__health               200 ok                   compose healthcheck
 *
 * queue/history/downloadclient/series exist so the app's 15 s /api/trace poll
 * (traces.py:109 build_traces) finds valid answers instead of erroring. Queue
 * and history carry ONE import-blocked grab — joined by downloadId they are
 * what gives /api/trace a row, and the long outputPath is the field the
 * kanban-fit spec measures card overflow against. Every answer has one
 * provenance file in fixtures/.
 *
 * Every request is logged to stdout as "METHOD path?query" — a CI failure is
 * diagnosable from the job log alone. Anything unmatched → 404 + JSON body.
 */
import { createServer } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT ?? 4000)
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const fixtures = Object.fromEntries(
  readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => [
      file.replace(/\.json$/, ''),
      JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')),
    ]),
)

function send(res, status, body, contentType) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const json = (res, status, body) =>
  send(res, status, body, 'application/json; charset=utf-8')

const xmlEscape = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const PUB_DATE = 'Thu, 01 Jan 2026 00:00:00 +0000'

const server = createServer((req, res) => {
  // "METHOD path?query" — one line per request, always flushed to stdout so a
  // failed CI run shows exactly what the app asked the stub for.
  console.log(`${req.method} ${req.url}`)

  const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  if (req.method === 'GET') {
    switch (pathname) {
      case '/__health':
        return send(res, 200, 'ok', 'text/plain; charset=utf-8')
      case '/torznab/api': {
        // S1: the answer to the app's own Torznab registry (the Phase 2 seed
        // registers this route). `t`/`q`/`apikey` are logged by the request
        // line above and then intentionally ignored — the fixture feed is
        // already scoped to the movie under test and the app's `_is_relevant`
        // does the token filtering. Shape: torznab_client.py::_parse_rows.
        const items = fixtures.releases
          .map((release) => {
            const seeders =
              typeof release.seeders === 'number'
                ? `\n      <torznab:attr name="seeders" value="${release.seeders}" />`
                : ''
            return `    <item>
      <title>${xmlEscape(release.title)}</title>
      <guid>${xmlEscape(release.guid)}</guid>
      <pubDate>${PUB_DATE}</pubDate>
      <enclosure url="http://127.0.0.1:${PORT}/download/${xmlEscape(release.guid)}.torrent" length="${release.size}" type="application/x-bittorrent" />${seeders}
    </item>`
          })
          .join('\n')
        const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>fake-torznab</title>
${items}
  </channel>
</rss>`
        return send(res, 200, feed, 'application/rss+xml; charset=utf-8')
      }
      case '/api/v3/system/status':
        return json(res, 200, fixtures['system-status'])
      case '/api/v3/movie':
        return json(res, 200, fixtures.movies)
      case '/api/v3/wanted/missing':
        return json(res, 200, fixtures['wanted-missing'])
      case '/api/v3/indexer':
        return json(res, 200, fixtures.indexers)
      case '/api/v3/release':
        // Real Radarr filters by ?movieId= — the fixture is already scoped to
        // the movie under test, so the query is ignored on purpose.
        return json(res, 200, fixtures.releases)
      case '/api/v3/rootfolder':
        return json(res, 200, fixtures.rootfolders)
      case '/api/v3/queue':
        return json(res, 200, fixtures['queue-one-import-blocked'])
      case '/api/v3/history':
        return json(res, 200, fixtures['history-one-grab'])
      case '/api/v3/downloadclient':
        return json(res, 200, fixtures['downloadclients-empty'])
      case '/api/v3/series':
        return json(res, 200, fixtures['series-empty'])
    }

    const movie = pathname.match(/^\/api\/v3\/movie\/(\d+)$/)
    if (movie) {
      // Only the movie the fixtures were captured for: a wrong id is a real
      // 404, so a spec asking for the wrong movie fails instead of silently
      // receiving somebody else's metadata.
      if (movie[1] === String(fixtures['movie-813'].id)) {
        return json(res, 200, fixtures['movie-813'])
      }
      return json(res, 404, { error: `movie ${movie[1]} is not in the fixtures`, path: pathname })
    }

    return json(res, 404, { error: 'not found', path: pathname })
  }

  if (req.method === 'POST' && pathname === '/api/v3/release') {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        // Malformed JSON still gets the 201 the grab path expects to practise;
        // the log line above already recorded the raw request.
      }
      const release = fixtures.releases.find((r) => r.guid === body.guid) ?? {
        guid: body.guid ?? '',
      }
      // clients.py:1394 reads the body only to log failures and accepts 200/201
      // (clients.py:1395); Radarr answers with the grabbed release resource, so
      // echo it (or an acknowledged guid) back.
      json(res, 201, release)
    })
    return
  }

  if (req.method === 'POST' && (pathname === '/api/v2/auth/login' || pathname === '/api/v2/torrents/add')) {
    // qBittorrent Web API (S2: the grab dispatches the row's link here —
    // no arr on that path anymore). Contracts from qbit_client.py:
    //   login → 200 + body "Ok." (real qB answers "Fails." on bad credentials)
    //   add   → 200 + body "" or "Ok." — form fields `urls` + `category`
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const form = new URLSearchParams(raw)
      if (pathname === '/api/v2/auth/login') {
        if (form.get('username') === 'test' && form.get('password') === 'test') {
          res.setHeader('set-cookie', 'SID=e2e-sid; Path=/')
          return send(res, 200, 'Ok.', 'text/plain; charset=utf-8')
        }
        return send(res, 403, 'Fails.', 'text/plain; charset=utf-8')
      }
      // Captured for the job log: what the app asked us to add, and where.
      console.log(`qbit add urls=${form.get('urls')} category=${form.get('category')}`)
      return send(res, 200, 'Ok.', 'text/plain; charset=utf-8')
    })
    return
  }

  return json(res, 404, { error: 'not found', method: req.method, path: pathname })
})

server.listen(PORT, () => {
  console.log(
    `fake-arr listening on :${PORT} — ${Object.keys(fixtures).length} fixtures: ${Object.keys(fixtures).join(', ')}`,
  )
})
