import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export interface VerifiedOAuthProfile {
  provider: string
  providerAccountId: string
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  emailVerified: boolean
}

interface GoogleTokenInfo {
  sub?: string
  email?: string
  email_verified?: string
  name?: string
  picture?: string
  aud?: string
  exp?: string
}

/**
 * Verifies OAuth provider tokens server-side without heavy SDKs.
 * Currently supports Google ID tokens via the public tokeninfo endpoint.
 */
@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name)
  private readonly googleClientId: string | undefined

  constructor(private readonly config: ConfigService) {
    this.googleClientId = this.config.get<string>('app.googleClientId')
  }

  async verifyGoogleIdToken(idToken: string): Promise<VerifiedOAuthProfile> {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
    let data: GoogleTokenInfo
    try {
      const res = await fetch(url, { method: 'GET' })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new UnauthorizedException(`Google token verification failed: ${res.status} ${body}`)
      }
      data = (await res.json()) as GoogleTokenInfo
    } catch (err) {
      this.logger.warn(`Google tokeninfo request failed: ${String(err)}`)
      throw new UnauthorizedException('Invalid Google ID token')
    }

    if (!data.sub) {
      throw new UnauthorizedException('Google token missing subject')
    }

    if (this.googleClientId && data.aud !== this.googleClientId) {
      throw new UnauthorizedException('Google token audience mismatch')
    }

    const now = Math.floor(Date.now() / 1000)
    if (data.exp && parseInt(data.exp, 10) < now) {
      throw new UnauthorizedException('Google token expired')
    }

    return {
      provider: 'google',
      providerAccountId: data.sub,
      email: data.email ?? null,
      displayName: data.name ?? null,
      avatarUrl: data.picture ?? null,
      emailVerified: data.email_verified === 'true',
    }
  }
}
