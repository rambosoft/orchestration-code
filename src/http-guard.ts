import { timingSafeEqual } from "node:crypto";

export const MAX_BODY_BYTES = 1_000_000;

export function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function readJsonBody(stream: AsyncIterable<Buffer | string>, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk); size += buffer.length;
    if (size > maxBytes) throw new Error(`request body too large (limit ${maxBytes} bytes)`);
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Test-injection flags exist for the scenario suite; the production bridge refuses them unless explicitly enabled. */
export function assertNoTestFlags(payload: { injectReviewFailure?: boolean; repeatReviewFailure?: boolean; injectActivityTimeout?: boolean }, environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.ORCHESTRATOR_ALLOW_TEST_FLAGS === "1") return;
  if (payload.injectReviewFailure || payload.repeatReviewFailure || payload.injectActivityTimeout) throw new Error("test-injection flags are disabled; set ORCHESTRATOR_ALLOW_TEST_FLAGS=1 on the bridge to use them");
}
