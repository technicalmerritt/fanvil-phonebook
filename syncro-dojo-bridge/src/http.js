/**
 * Thin fetch wrapper: timeouts, JSON handling, and errors that say which API
 * failed and why - the difference between a five-minute and a five-hour
 * debugging session when a card machine misbehaves mid-sale.
 */

export class ApiError extends Error {
  constructor(api, status, body, requestId) {
    const detail =
      typeof body === 'string' ? body : JSON.stringify(body ?? {});
    super(`${api} returned HTTP ${status}: ${detail.slice(0, 600)}`);
    this.name = 'ApiError';
    this.api = api;
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

export async function requestJson(api, url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new ApiError(api, 0, `No response within ${timeoutMs}ms (${method} ${url})`);
    }
    throw new ApiError(api, 0, `Network error calling ${method} ${url}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    throw new ApiError(api, response.status, parsed, response.headers.get('x-request-id'));
  }
  return parsed;
}
