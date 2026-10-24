/**
 * Minimal Discovery Server client for the simulator.
 *
 * It deliberately speaks only HTTP: the world drives the real server, not a
 * mocked one, so signatures, pricing, rate limits and PostgreSQL state are all
 * exercised for real.
 */

/** @typedef {{ status: number, payload: any, ms: number }} ApiResult */

export class Client {
  /**
   * @param {string} base
   * @param {{ token?: string, adminToken?: string, onResponse?: (path: string, result: ApiResult) => void }} [options]
   */
  constructor(base, options = {}) {
    this.base = base.replace(/\/+$/, '')
    this.token = options.token ?? ''
    this.adminToken = options.adminToken ?? ''
    this.onResponse = options.onResponse ?? (() => {})
  }

  /**
   * @param {string} path
   * @param {{ method?: string, body?: any, admin?: boolean, timeoutMs?: number }} [options]
   * @returns {Promise<ApiResult>}
   */
  async request(path, options = {}) {
    const { method = 'GET', body, admin = false, timeoutMs = 15000 } = options
    /** @type {Record<string, string>} */
    const headers = { 'content-type': 'application/json' }
    const token = admin ? this.adminToken : this.token
    if (token !== '') headers.authorization = `Bearer ${token}`

    const started = performance.now()
    try {
      const response = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      let payload = null
      try {
        payload = text === '' ? null : JSON.parse(text)
      } catch {
        payload = { raw: text }
      }
      const result = { status: response.status, payload, ms: performance.now() - started }
      this.onResponse(path, result)
      return result
    } catch (error) {
      const result = {
        status: 0,
        payload: { error: error instanceof Error ? error.message : String(error) },
        ms: performance.now() - started,
      }
      this.onResponse(path, result)
      return result
    }
  }

  /** @param {string} path @param {any} body */
  post(path, body) {
    return this.request(path, { method: 'POST', body })
  }

  /** @param {string} path @param {{ method?: string, body?: any }} [options] */
  admin(path, options = {}) {
    return this.request(path, { ...options, admin: true })
  }
}
