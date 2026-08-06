import { Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

export interface VerifiedOAuthProfile {
  provider: string
  providerAccountId: string
  email: string | null
  displayName: string | null
  avatarUrl: string | null
  emailVerified: boolean
  /**
   * Google Workspace HOSTED DOMAIN (`hd`) of the signer, e.g. "company.com".
   * Absent/null for personal Google accounts (gmail.com and friends never carry
   * it) and for every non-Google provider.
   *
   * This single claim is the whole of Rayu's team SSO: it comes from inside the
   * Google-signed ID token, verified server-side below, so it cannot be spoofed
   * by the client — which is why an org can safely auto-adopt anyone who signs
   * in with its company domain, with no SAML, no OIDC client, and no IdP vendor.
   */
  hostedDomain?: string | null
}

interface GoogleTokenInfo {
  sub?: string
  email?: string
  email_verified?: string
  name?: string
  picture?: string
  aud?: string
  exp?: string
  /** Workspace hosted domain; present only for Google Workspace accounts. */
  hd?: string
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
      // Surfaced, not acted on: deciding what a hosted domain MEANS (which team
      // adopts the signer) is the auth/organizations layer's job, so this service
      // stays a pure token verifier with no database dependency.
      hostedDomain: data.hd ? data.hd.trim().toLowerCase() : null,
    }
  }
}
