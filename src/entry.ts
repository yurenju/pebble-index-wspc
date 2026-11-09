export const DEFAULT_TIMEZONE = "Asia/Tokyo";

/**
 * Collapses every run of line breaks (together with the whitespace around it)
 * into one space, then trims. Returns "" for a transcript with no content.
 */
export function normalizeTranscript(transcript: string): string {
  return transcript.replace(/\s*[\r\n]\s*/g, " ").trim();
}

/**
 * Formats one Entry line: `- YYYY-MM-DD HH:mm <transcript>` in local time.
 * Throws RangeError when `timeZone` is not a valid IANA name.
 */
export function formatEntry(recordedAtMs: number, normalizedTranscript: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(recordedAtMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `- ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${normalizedTranscript}`;
}
