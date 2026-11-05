export function readActor(header: string | undefined): string {
  const cleaned = (header ?? '').replace(/[^\p{L}\p{N} @._+-]/gu, '').trim().slice(0, 80);

  return cleaned.length > 0 ? cleaned : 'anonymous';
}
