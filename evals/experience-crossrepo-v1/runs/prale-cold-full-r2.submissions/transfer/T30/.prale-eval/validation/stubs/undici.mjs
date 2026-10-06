// Minimal stand-in for the `undici` runtime dependency (not installed in this workspace).
// http-dispatcher.ts only references undici inside functions the precedence demo never calls.
export class Dispatcher {}
export class Client extends Dispatcher {}
export class Pool extends Dispatcher {}
export class Agent extends Dispatcher {}
export class EnvHttpProxyAgent extends Dispatcher {}
export const setGlobalDispatcher = () => {};
export const getGlobalDispatcher = () => undefined;
export const install = () => {};
export const request = () => Promise.reject(new Error("undici stub: request not implemented"));
export const fetch = () => Promise.reject(new Error("undici stub: fetch not implemented"));
