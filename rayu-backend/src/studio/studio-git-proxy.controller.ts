import {
  All,
  Controller,
  Logger,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { Readable } from 'stream'
import { requireGitProxyUrl, requireGitRedirectTarget } from '../common/studio-urls'
import { StudioProxyTokenGuard } from './studio-proxy-token.guard'

/**
 * Git smart-HTTP CORS proxy for Studio's in-browser `isomorphic-git`.
 *
 * WHY A PROXY IS NEEDED AT ALL
 * GitHub and GitLab do not send CORS headers on their git endpoints, so a browser
 * cannot clone directly. isomorphic-git's answer is a same-origin proxy that
 * relays the request; this is that relay, ported from bolt.diy's
 * api.git-proxy.$.ts.
 *
 * WHAT CHANGED FROM UPSTREAM (and why it had to)
 * The original forwarded to `https://${anyDomain}/${anyPath}` with the caller's
 * Authorization header attached, and answered `Access-Control-Allow-Origin: *`.
 * On a shared host that is:
 *   • an SSRF pivot — any internal HTTP service becomes reachable through us;
 *   • a credential relay — we would forward a bearer token to a host of the
 *     caller's choosing;
 *   • an open proxy — `*` let any website on the internet use it.
 *
 * So: the destination host must be on the git allow-list (requireGitProxyUrl),
 * the caller must be an authenticated Rayu user, and no CORS headers are emitted
 * because the studio is same-origin with this API's consumer already.
 *
 * Bodies are STREAMED in both directions. Git packfiles are large and
 * buffering them would put a clone's whole working set in the backend's heap.
 */

/** Request headers safe to forward. Anything not listed is dropped. */
const FORWARD_REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'authorization',
  'cache-control',
  'content-type',
  'git-protocol',
  'pragma',
  'range',
  'user-agent',
] as const

/*
 * Headers that must NEVER reach the git host. X-Rayu-Token is our session token;
 * forwarding it to github.com would hand a Rayu credential to a third party.
 */
const STRIP_REQUEST_HEADERS = ['x-rayu-token'] as const

/**
 * How many redirects to follow. GitHub uses them for renamed repos and for
 * codeload hand-offs, so they cannot be refused outright; the bound stops a
 * redirect loop from tying up a worker.
 */
const MAX_REDIRECTS = 5

/** Response headers copied back to the browser. */
const FORWARD_RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-encoding',
  'content-language',
  'content-type',
  'etag',
  'expires',
  'last-modified',
  'pragma',
  'vary',
  'www-authenticate',
  'x-redirected-url',
] as const

@Controller('studio/git-proxy')
@UseGuards(StudioProxyTokenGuard)
export class StudioGitProxyController {
  private readonly logger = new Logger(StudioGitProxyController.name)

  /**
   * `GET|POST /api/studio/git-proxy/github.com/owner/repo.git/info/refs?...`
   *
   * The first path segment is the git host and is checked against the
   * allow-list; the remainder is forwarded verbatim.
   *
   * The route is `'*'` rather than a named wildcard because this backend runs
   * Express 4 (path-to-regexp 3), where `'*path'` does not match at all — it is
   * Express 5 syntax. The captured value therefore arrives as `req.params[0]`.
   */
  @All('*')
  async proxy(@Req() req: Request, @Res() res: Response): Promise<void> {
    const captured = (req.params as Record<string, string>)['0'] ?? ''
    const suffix = captured.replace(/^\/+/, '')
    const queryIndex = req.originalUrl.indexOf('?')
    const search = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex)

    // Throws Forbidden for an off-list host and BadRequest for a malformed one.
    const firstTarget = requireGitProxyUrl(suffix, search)

    const headers = new Headers()
    for (const name of FORWARD_REQUEST_HEADERS) {
      const v = req.headers[name]
      if (typeof v === 'string' && v) headers.set(name, v)
    }
    // Belt-and-braces: our session token is not in the forward list, but assert
    // it explicitly so adding a header to that list can never leak it upstream.
    for (const name of STRIP_REQUEST_HEADERS) {
      headers.delete(name)
    }
    headers.set('host', firstTarget.host)
    // isomorphic-git's proxy contract: identify as a git client so the smart-HTTP
    // endpoints negotiate the v2 protocol instead of serving the dumb fallback.
    if (!headers.get('user-agent')?.startsWith('git/')) {
      headers.set('user-agent', 'git/@isomorphic-git/cors-proxy')
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'

    let upstream: globalThis.Response
    let target = firstTarget
    let hops = 0

    for (;;) {
      try {
        upstream = await fetch(target, {
          method: req.method,
          headers,
          // Stream the request body through rather than buffering the packfile.
          body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
          // Required by undici whenever a stream body is used.
          duplex: 'half',
          /*
           * 'manual', NOT 'follow'. Following automatically would apply the host
           * allow-list only to the FIRST hop, so an open redirect on any
           * allow-listed host would turn this into a read-SSRF that streams an
           * arbitrary URL's body back to the caller. Each hop is re-validated
           * below instead.
           */
          redirect: 'manual',
        } as RequestInit & { duplex: 'half' })
      } catch (e) {
        this.logger.warn(`git proxy failed: ${target.host} ${(e as Error).message}`)
        res.status(502).json({ error: 'git proxy could not reach the upstream host' })

        return
      }

      const location =
        upstream.status >= 300 && upstream.status < 400 ? upstream.headers.get('location') : null

      if (!location) {
        break
      }

      /*
       * A redirect on a body-bearing request cannot be replayed: the body is a
       * stream that has already been consumed. Rather than buffer a packfile to
       * make this possible, report it — git's smart-HTTP POSTs do not legitimately
       * redirect, so this is a signal, not a limitation to work around.
       */
      if (hasBody) {
        this.logger.warn(`git proxy: unexpected redirect on ${req.method} ${target.host}`)
        res.status(502).json({ error: 'git host redirected a request that cannot be replayed' })

        return
      }

      if (++hops > MAX_REDIRECTS) {
        res.status(502).json({ error: 'git host redirected too many times' })

        return
      }

      // Throws Forbidden if the hop leaves the allow-list.
      target = requireGitRedirectTarget(location, target)
      headers.set('host', target.host)
    }

    res.status(upstream.status)

    for (const name of FORWARD_RESPONSE_HEADERS) {
      const v = upstream.headers.get(name)

      if (v) res.setHeader(name, v)
    }

    // isomorphic-git observes the final URL through this header; it is set when we
    // actually followed something, since redirect:'manual' leaves `redirected` false.
    if (hops > 0) {
      res.setHeader('x-redirected-url', target.toString())
    }

    if (!upstream.body) {
      res.end()
      return
    }
    // Pipe upstream → client. Readable.fromWeb keeps backpressure intact, so a
    // slow browser does not force the whole packfile into memory.
    Readable.fromWeb(upstream.body as never).pipe(res)
  }
}
