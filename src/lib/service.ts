import { getCookie } from "@tanstack/react-start/server";

/**
 * Client for the Python service's authenticated endpoints, used by the server
 * functions in auth.functions.ts and library.functions.ts.
 *
 * The catalogue calls in streaming.functions.ts stay separate on purpose: those
 * fall back to sample data when the service is unreachable, and nothing on the
 * auth path may ever do that — a lookup that silently "succeeds" would un-gate
 * the app.
 */

export const SESSION_COOKIE = "streamapp_session";

/** Mirrors the service's SC_SESSION_DAYS default, so the cookie and the session die together. */
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

/** FastAPI answers `detail` as a string, except on /auth/login where it is an object. */
type Detail = string | { message?: string; retryAfter?: number; attemptsLeft?: number };

export class ServiceError extends Error {
  readonly status: number;
  readonly retryAfter: number | undefined;
  readonly attemptsLeft: number | undefined;

  constructor(status: number, detail?: Detail) {
    super(
      typeof detail === "string"
        ? detail
        : (detail?.message ?? "The streaming service refused the request"),
    );
    this.name = "ServiceError";
    this.status = status;
    this.retryAfter = typeof detail === "object" ? detail?.retryAfter : undefined;
    this.attemptsLeft = typeof detail === "object" ? detail?.attemptsLeft : undefined;
  }
}

export function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

export async function serviceFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const port = process.env["SC_PORT"] || "8000";
  const base = process.env["STREAMING_API_URL"] || `http://localhost:${port}`;

  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  const token = getCookie(SESSION_COOKIE);
  if (token) headers.set("authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(10000),
    });
  } catch {
    throw new ServiceError(0, "Cannot reach the streaming service");
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: Detail } | null;
    throw new ServiceError(response.status, body?.detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
