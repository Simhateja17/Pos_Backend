import { createHash, randomBytes } from 'node:crypto'
import type { Request, Response } from 'express'

export const COUNTER_DEVICE_COOKIE = 'couture_counter_device'

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

export function getCounterDeviceToken(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[COUNTER_DEVICE_COOKIE]
}

export function hashCounterDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createCounterDeviceToken(): string {
  return randomBytes(32).toString('hex')
}

export function setCounterDeviceCookie(res: Response, token: string) {
  const sameSite = (process.env.AUTH_COOKIE_SAME_SITE ?? 'lax').toLowerCase()
  const normalizedSameSite = sameSite === 'strict' || sameSite === 'none' ? sameSite : 'lax'
  const secure = process.env.NODE_ENV === 'production' || normalizedSameSite === 'none'
  const attributes = [
    'Path=/',
    'HttpOnly',
    `SameSite=${normalizedSameSite[0].toUpperCase()}${normalizedSameSite.slice(1)}`,
    'Max-Age=31536000',
    ...(secure ? ['Secure'] : []),
  ].join('; ')

  res.append('Set-Cookie', `${COUNTER_DEVICE_COOKIE}=${encodeURIComponent(token)}; ${attributes}`)
}

export function clearCounterDeviceCookie(res: Response) {
  res.append('Set-Cookie', `${COUNTER_DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

export async function findPairedTerminal(client: any, req: Request) {
  const token = getCounterDeviceToken(req)
  if (!token) return null

  const terminal = await client.terminals.findFirst({
    where: { device_token_hash: hashCounterDeviceToken(token), is_active: true },
  })
  if (terminal) {
    await client.terminals.update({
      where: { id: terminal.id },
      data: { device_last_seen_at: new Date() },
    })
    terminal.device_last_seen_at = new Date()
  }
  return terminal
}
