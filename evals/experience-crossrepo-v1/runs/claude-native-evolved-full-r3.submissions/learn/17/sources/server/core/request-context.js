import { AsyncLocalStorage } from 'async_hooks'

const requestContext = new AsyncLocalStorage()

export function runWithRequestContext(context, fn) {
  return requestContext.run(context || {}, fn)
}

export function getRequestContext() {
  return requestContext.getStore() || null
}

export function getRequestUser() {
  return getRequestContext()?.user || null
}

export function getRequestTenant() {
  return getRequestContext()?.tenant || null
}
