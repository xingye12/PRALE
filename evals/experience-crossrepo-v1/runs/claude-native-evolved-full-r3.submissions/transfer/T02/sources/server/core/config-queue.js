// ConfigQueue — unified queue for all Gateway config modifications.
// Depends on gatewayAdminRpc from gateway-client.js.

import { gatewayAdminRpc } from './gateway-client.js'

class ConfigQueue {
  constructor () {
    this._queue = []
    this._running = false
    this._patchTimestamps = []
    this._MAX_PATCHES = 3
    this._WINDOW_MS = 60_000
  }

  enqueue (transformFn, label, method = 'config.patch') {
    return new Promise((resolve, reject) => {
      this._queue.push({ transformFn, label, method, resolve, reject })
      this._process()
    })
  }

  get length () { return this._queue.length }

  async _process () {
    if (this._running) return
    this._running = true
    while (this._queue.length > 0) {
      const item = this._queue.shift()
      const result = await this._execute(item)
      if (result.ok) {
        item.resolve(result.data)
      } else {
        item.reject(result.error)
      }
    }
    this._running = false
  }

  _cleanWindow () {
    const cutoff = Date.now() - this._WINDOW_MS
    while (this._patchTimestamps.length > 0 && this._patchTimestamps[0] <= cutoff) {
      this._patchTimestamps.shift()
    }
  }

  async _waitForSlot () {
    this._cleanWindow()
    if (this._patchTimestamps.length < this._MAX_PATCHES) return
    const waitMs = this._patchTimestamps[0] + this._WINDOW_MS - Date.now() + 200
    if (waitMs > 0) {
      console.log(`[ConfigQueue] rate limit approaching, waiting ${Math.round(waitMs / 1000)}s...`)
      await new Promise(r => setTimeout(r, waitMs))
    }
  }

  _recordPatch () {
    this._patchTimestamps.push(Date.now())
  }

  async _execute ({ transformFn, label, method = 'config.patch' }) {
    const maxRetries = 3
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const _r1 = await gatewayAdminRpc('config.get', {})
        if (!_r1.ok) throw new Error(_r1.error)
        const payload = _r1.payload
        const sourceConfig = payload.sourceConfig || payload.config || payload.parsed || {}
        const updated = transformFn(sourceConfig)
        if (!updated) return { ok: true, data: null }

        await this._waitForSlot()
        const _r2 = await gatewayAdminRpc(method, { raw: JSON.stringify(updated), baseHash: payload.hash })
        if (!_r2.ok) throw new Error(_r2.error)
        this._recordPatch()

        const _r3 = await gatewayAdminRpc('config.get', {})
        if (!_r3.ok) throw new Error(_r3.error)
        const payload2 = _r3.payload
        const sourceConfig2 = payload2.sourceConfig || payload2.config || payload2.parsed || {}
        const _r4 = await gatewayAdminRpc('config.apply', { raw: JSON.stringify(sourceConfig2), baseHash: payload2.hash })
        if (!_r4.ok) throw new Error(_r4.error)

        return { ok: true, data: undefined }
      } catch (err) {
        const isOcc = err.message?.includes('config changed since last load')
        const isRateLimit = err.message?.includes('rate limit')
        if ((isOcc || isRateLimit) && attempt < maxRetries - 1) {
          const delay = isRateLimit
            ? Math.min(err.retryAfterMs || 60000, 65000)
            : (attempt + 1) * 2000
          console.warn(`[ConfigQueue] ${label} attempt ${attempt + 1} failed: ${err.message}, retrying in ${Math.round(delay / 1000)}s...`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        console.error(`[ConfigQueue] ${label} failed: ${err.message}`)
        return { ok: false, error: err }
      }
    }
  }
}

const configQueue = new ConfigQueue()

export function configQueueExecute (transformFn, label, method) {
  return configQueue.enqueue(transformFn, label, method)
}
