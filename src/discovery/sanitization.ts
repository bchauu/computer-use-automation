/** Bounded redaction for persisted text in the synthetic assessment. */
export function sanitizePersistedText(
  value: string | null,
  sensitiveValues: readonly string[] = [],
) {
  if (value === null) return null;
  let sanitized = value;
  for (const secret of [
    ...sensitiveValues,
    process.env.OPENAI_API_KEY,
    process.env.OPERATOR_ACCESS_TOKEN,
  ]) {
    if (secret?.trim()) sanitized = sanitized.replaceAll(secret.trim(), '[redacted]');
  }
  return (
    sanitized
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted-key]')
      .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[redacted-database-uri]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
      .replace(/\b\d{4,}\b/g, '[redacted-number]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300) || null
  );
}
