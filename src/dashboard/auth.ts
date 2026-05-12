import { timingSafeEqual } from 'node:crypto'
import type { RequestHandler } from 'express'
import { config } from '../config'

/**
 * Basic-Auth middleware for the dashboard. Disabled (allow-all) only when
 * both DASHBOARD_USER and DASHBOARD_PASSWORD are unset — useful for local
 * dev. In any other case credentials are required and compared in
 * constant time.
 */
export function basicAuth(): RequestHandler {
  return (req, res, next) => {
    if (!config.DASHBOARD_USER && !config.DASHBOARD_PASSWORD) {
      return next()
    }
    if (!config.DASHBOARD_USER || !config.DASHBOARD_PASSWORD) {
      res.status(500).json({
        error: 'Dashboard auth is half-configured. Set BOTH DASHBOARD_USER and DASHBOARD_PASSWORD, or neither.',
      })
      return
    }

    const header = req.header('authorization') ?? ''
    if (!header.toLowerCase().startsWith('basic ')) {
      return reject(res)
    }
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8')
    const sep = decoded.indexOf(':')
    if (sep === -1) return reject(res)
    const user = decoded.slice(0, sep)
    const pass = decoded.slice(sep + 1)

    if (!safeEqual(user, config.DASHBOARD_USER) || !safeEqual(pass, config.DASHBOARD_PASSWORD)) {
      return reject(res)
    }
    next()
  }
}

function reject(res: Parameters<RequestHandler>[1]): void {
  res.setHeader('WWW-Authenticate', 'Basic realm="Novo AI dashboard"')
  res.status(401).send('Authentication required')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
