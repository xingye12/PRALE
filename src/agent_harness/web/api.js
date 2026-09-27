// HTTP client for the adapter in ``api/web.py``.
//
// The event stream is read with ``fetch`` + ``ReadableStream`` rather than
// ``EventSource``: EventSource cannot send an ``Authorization`` header, and a
// credentialed deployment must not be forced to put its token in the URL where
// it ends up in access logs.  Reading the body directly also keeps reconnect
// policy — and the ``Last-Event-ID`` the server acknowledges — under our
// control.

const TOKEN_KEY = "prale.token";

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /** A store the deployment did not configure, as opposed to a real failure. */
  get unavailable() {
    return this.status === 503;
  }

  get unauthenticated() {
    return this.status === 401;
  }
}

export class Api {
  constructor(base = "/api") {
    this.base = base;
  }

  get token() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }

  set token(value) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage disabled: requests simply go out unauthenticated */
    }
  }

  _headers(extra) {
    const headers = { ...(extra || {}) };
    const token = this.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  _url(path, query) {
    const url = new URL(this.base + path, window.location.origin);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    }
    return url;
  }

  async request(path, { method = "GET", body, query } = {}) {
    const response = await fetch(this._url(path, query), {
      method,
      headers: this._headers(body === undefined ? {} : { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return parseResponse(response);
  }

  /**
   * Read an SSE response until it ends or ``signal`` aborts.
   *
   * ``onEvent(name, data)`` sees each frame; ``onState(state, detail)`` reports
   * connecting / open / retry / closed so the UI can tell "no events" from "the
   * stream is down".  Resolves when the caller aborts or the stream closes for
   * good; it never throws for a mid-stream disconnect — reconnection is the
   * caller's business and a broken stream must not look like failed work.
   */
  async stream(path, { query, onEvent, onState, signal } = {}) {
    const url = this._url(path, query);
    let lastEventId = null;
    let delay = 2000;
    const notify = onState || (() => {});
    for (;;) {
      if (signal?.aborted) return;
      notify("connecting");
      let response;
      try {
        response = await fetch(url, {
          headers: this._headers(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) return;
        notify("error", String(error));
        if (!(await sleep(delay, signal))) return;
        continue;
      }
      if (!response.ok) {
        const body = await parseResponse(response).catch((error) => error.body ?? null);
        const message = (body && body.error) || `${response.status} ${response.statusText}`;
        notify("error", message);
        // Retrying a stream the server refuses on purpose would spin: a wrong
        // credential, a session that does not exist, a store that is not
        // configured.  Anything else is worth another attempt.
        if (response.status === 401 || response.status === 404 || response.status === 503) return undefined;
        if (!(await retry(delay, signal, notify))) return;
        continue;
      }
      if (!response.body) {
        notify("error", "响应没有可读的响应体");
        return undefined;
      }
      notify("open");
      try {
        lastEventId = await readFrames(response.body, (name, data, id) => {
          if (id) lastEventId = id;
          if (name === "retry") {
            const hinted = Number(data);
            if (Number.isFinite(hinted) && hinted > 0) delay = Math.max(250, hinted);
            return;
          }
          onEvent?.(name, data, id);
        }, signal);
      } catch (error) {
        if (signal?.aborted) return;
        notify("error", String(error));
      }
      if (signal?.aborted) return;
      notify("retry");
      if (!(await sleep(delay, signal))) return;
    }
  }
}

/** The reconnect promise: resolves true when the caller may try again. */
function retry(delay, signal, notify) {
  notify("retry");
  return sleep(delay, signal);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Parse the SSE grammar out of a byte stream.
 *
 * Returns the last event id seen so a reconnect can acknowledge with it.  The
 * server treats ``Last-Event-ID`` as acknowledged, not replayed: the fresh
 * snapshot after reconnecting carries ``resumed_from`` so the UI can say what
 * it missed instead of pretending the gap did not exist.
 */
async function readFrames(stream, handle, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let name = "";
  let id = null;
  let data = [];
  let lastId = null;

  const dispatch = () => {
    if (!data.length) {
      name = "";
      id = null;
      return;
    }
    const payload = data.join("\n");
    if (id) lastId = id;
    handle(name || "message", parseData(payload), id);
    name = "";
    id = null;
    data = [];
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line === "") {
          dispatch();
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let rest = colon === -1 ? "" : line.slice(colon + 1);
          if (rest.startsWith(" ")) rest = rest.slice(1);
          if (field === "event") name = rest;
          else if (field === "data") data.push(rest);
          else if (field === "id") id = rest;
          else if (field === "retry") handle("retry", rest, null);
        }
        index = buffer.indexOf("\n");
      }
    }
    dispatch();
  } finally {
    reader.cancel().catch(() => {});
  }
  return lastId;
}

/** SSE payloads are JSON; a frame that is not JSON is kept as text. */
function parseData(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

async function parseResponse(response) {
  const type = response.headers.get("content-type") || "";
  let payload = null;
  if (type.includes("json")) {
    payload = await response.json().catch(() => null);
  } else {
    await response.text().catch(() => "");
  }
  if (!response.ok) {
    const message = (payload && payload.error) || `${response.status} ${response.statusText}`;
    throw new ApiError(response.status, message, payload);
  }
  return payload;
}

export function isAbort(error) {
  return error && (error.name === "AbortError" || error.code === 20);
}
