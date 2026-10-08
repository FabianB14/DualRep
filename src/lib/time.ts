/**
 * An epoch-ms time as every timestamp column stores it: ISO 8601 in UTC with milliseconds
 * ("2026-10-08T09:30:00.000Z"). One format everywhere, so stored timestamps compare correctly as text
 * (DATA_MODEL.md). A value that is not a finite number throws a RangeError, so the repos refuse a bad
 * time before the write reaches the upload queue (the cycle store drops a RangeError instead of
 * retrying it forever).
 */
export function isoTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid timestamp: ${ms}`);
  return new Date(ms).toISOString();
}
