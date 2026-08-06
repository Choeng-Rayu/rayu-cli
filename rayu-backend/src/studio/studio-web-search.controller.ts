import {
  BadRequestException,
  Body,
  Controller,
  GatewayTimeoutException,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common'
import { IsString, MaxLength } from 'class-validator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { requirePublicUrl } from '../common/studio-urls'

/**
 * Fetch and flatten a web page so the agent can read it.
 *
 * Ported from bolt.diy's api.web-search.ts, which already applied its own
 * `isAllowedUrl` SSRF check; here that is replaced by the backend's shared
 * requirePublicUrl so there is a single definition of "not a private address"
 * across the studio endpoints.
 *
 * Kept from upstream: the 10s timeout, the content-type restriction, and the 8000
 * character cap — the cap matters because the result is destined for a model
 * context window, and an unbounded page would silently consume the user's budget.
 */

const MAX_CONTENT_LENGTH = 8_000
const FETCH_TIMEOUT_MS = 10_000
/** Bound the download itself, not just the extract, so a huge page can't be read into memory. */
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
}

export class WebSearchDto {
  @IsString()
  @MaxLength(2048)
  url!: string
}

export interface WebSearchResult {
  success: true
  data: {
    title: string
    description: string
    content: string
    sourceUrl: string
  }
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html)
  return match ? match[1].trim() : ''
}

function extractMetaDescription(html: string): string {
  const match = /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i.exec(html)
  if (match) return match[1].trim()
  // Attributes can appear in either order.
  const alt = /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i.exec(html)
  return alt ? alt[1].trim() : ''
}

function extractTextContent(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
    .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

@Controller('studio/web-search')
@UseGuards(RayuAuthGuard)
export class StudioWebSearchController {
  private readonly logger = new Logger(StudioWebSearchController.name)

  @Post()
  async fetchPage(@Body() body: WebSearchDto): Promise<WebSearchResult> {
    const url = requirePublicUrl(body.url, 'url')

    let res: globalThis.Response
    try {
      res = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      })
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new GatewayTimeoutException('Request timed out after 10 seconds')
      }
      this.logger.debug(`web-search fetch failed: ${url.host} ${(e as Error).message}`)
      throw new BadRequestException('Could not fetch that URL')
    }

    if (!res.ok) {
      throw new BadRequestException(`Failed to fetch URL: ${res.status} ${res.statusText}`)
    }

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new BadRequestException('URL must point to an HTML or text page')
    }

    // A redirect could land on a private address even though the original URL was
    // public, so re-check the URL we actually ended up reading.
    if (res.redirected) {
      requirePublicUrl(res.url, 'redirect target')
    }

    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > MAX_DOWNLOAD_BYTES) {
      throw new BadRequestException('Page is too large to read')
    }

    const html = (await res.text()).slice(0, MAX_DOWNLOAD_BYTES)
    const content = extractTextContent(html)

    return {
      success: true,
      data: {
        title: extractTitle(html),
        description: extractMetaDescription(html),
        content:
          content.length > MAX_CONTENT_LENGTH
            ? `${content.slice(0, MAX_CONTENT_LENGTH)}...`
            : content,
        sourceUrl: url.toString(),
      },
    }
  }
}
