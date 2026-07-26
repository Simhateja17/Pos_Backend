import type { Request, Response } from 'express'

export const ACCESS_COOKIE = 'couture_access_token'
export const REFRESH_COOKIE = 'couture_refresh_token'

function sameSite(): 'lax' | 'strict' | 'none' {
  const value = (process.env.AUTH_COOKIE_SAME_SITE ?? 'lax').toLowerCase()
  return value === 'strict' || value === 'none' ? value : 'lax'
}

function cookieOptions(maxAge: number) {
  const site = sameSite()
  return [
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${site[0].toUpperCase()}${site.slice(1)}`,
    ...(process.env.NODE_ENV === 'production' || site === 'none' ? ['Secure'] : []),
  ].join('; ')
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.append('Set-Cookie', `${ACCESS_COOKIE}=${encodeURIComponent(accessToken)}; ${cookieOptions(60 * 60)}`)
  res.append('Set-Cookie', `${REFRESH_COOKIE}=${encodeURIComponent(refreshToken)}; ${cookieOptions(60 * 60 * 24 * 30)}`)
}

export function clearAuthCookies(res: Response) {
  res.append('Set-Cookie', `${ACCESS_COOKIE}=; ${cookieOptions(0)}`)
  res.append('Set-Cookie', `${REFRESH_COOKIE}=; ${cookieOptions(0)}`)
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  return Object.fromEntries(
    header.split(';').flatMap((part) => {
      const index = part.indexOf('=')
      if (index < 0) return []
      return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]]
    }),
  )
}

export function getAuthCookies(req: Request) {
  const cookies = parseCookies(req.headers.cookie)
  return { accessToken: cookies[ACCESS_COOKIE], refreshToken: cookies[REFRESH_COOKIE] }
}
