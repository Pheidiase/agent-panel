import { messageError } from "./i18n";

// Private, caller-owned memory only. HTTP responses remain Cache-Control: no-store.
export type JsonValidator<T = unknown> = { etag?: string; data?: T };

export async function fetchJson(url: string, init: RequestInit, validator?: JsonValidator) {
  const headers = new Headers(init.headers);
  if (validator?.etag && validator.data !== undefined) headers.set("If-None-Match", validator.etag);
  // Explicit revalidation lets the server return 304 even though its private
  // response is never put in the browser's disk/HTTP cache.
  const response = await fetch(url, { ...init, headers, ...(validator ? { cache: "no-cache" as const } : {}) });
  if (response.status === 304) {
    if (!validator || validator.data === undefined) throw messageError("revalidation.previousResponseMissing");
    return { response, data: validator.data };
  }
  const data = await response.json();
  if (validator && response.ok) {
    validator.etag = response.headers.get("ETag") || undefined;
    validator.data = data;
  }
  return { response, data };
}
