const LINKEDIN_HOST = /^(?:[a-z0-9-]+\.)*linkedin\.com$/i;

// Store https only. A pasted linkedin.com/in/… URL is upgraded; other hosts are refused.
export function canonicalLinkedinUrl(value: string): string | undefined {
  const trimmed = value.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;

  try {
    parsed = new URL(withScheme);
  } catch {
    return undefined;
  }

  if (parsed.username || parsed.password || !LINKEDIN_HOST.test(parsed.hostname)) {
    return undefined;
  }

  const path = `${parsed.pathname}${parsed.search}`;

  if (path.length < 2 || path.length > 160 || path.includes('..')) {
    return undefined;
  }

  return `https://${parsed.hostname.toLowerCase()}${path}`;
}
