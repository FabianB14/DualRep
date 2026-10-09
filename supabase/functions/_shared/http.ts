/** Small HTTP helpers shared by both functions. Pure (Web APIs only). */

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** The bearer token of an Authorization header, or null. */
export function bearerToken(header: string | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1] : null;
}

/**
 * Compares two secrets in constant time: both are hashed first, so neither their contents nor their
 * lengths change how long the comparison takes. An empty expected secret never matches (an unset
 * secret must not open the door).
 */
export async function secretsMatch(given: string | null, expected: string | null | undefined): Promise<boolean> {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given ?? '')),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Runs `task` after the response is sent when the Edge Runtime allows it, else awaits it. */
export async function inBackground(task: Promise<unknown>): Promise<void> {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(task);
    return;
  }
  await task;
}
