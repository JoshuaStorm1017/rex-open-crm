const CALLING_CODE_COUNTRY: Record<string, string> = {
  '1': 'US',
  '33': 'FR',
  '44': 'GB',
  '49': 'DE',
  '61': 'AU',
};

export type ParsedPhone = {
  number: string;
  callingCode: string;
  countryCode: string;
};

export function parsePhone(value: string): ParsedPhone | undefined {
  const digits = value.replace(/[\s().-]/g, '');

  if (!digits.startsWith('+')) {
    return undefined;
  }

  const rest = digits.slice(1);

  for (const length of [3, 2, 1]) {
    const code = rest.slice(0, length);
    const countryCode = CALLING_CODE_COUNTRY[code];
    const number = rest.slice(length);

    if (countryCode && /^\d{6,14}$/.test(number)) {
      return {
        number,
        callingCode: `+${code}`,
        countryCode,
      };
    }
  }

  return undefined;
}
