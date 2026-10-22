/** xn--mller-kva.de → müller.de (RFC 3492), for display only. */
export function displayHost(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  return host
    .split('.')
    .map((label) => {
      if (!label.startsWith('xn--')) return label;
      const input = label.slice(4);
      const out: number[] = [];
      let i = 0;
      let n = 128;
      let bias = 72;
      const dash = input.lastIndexOf('-');
      for (let j = 0; j < Math.max(dash, 0); j++) out.push(input.charCodeAt(j));
      for (let pos = dash > 0 ? dash + 1 : 0; pos < input.length; ) {
        const old = i;
        for (let w = 1, k = 36; ; k += 36) {
          const c = input.charCodeAt(pos++);
          const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : 36;
          i += digit * w;
          const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
          if (digit < t) break;
          w *= 36 - t;
        }
        let delta = i - old;
        delta = old === 0 ? Math.floor(delta / 700) : delta >> 1;
        delta += Math.floor(delta / (out.length + 1));
        let k = 0;
        while (delta > 455) {
          delta = Math.floor(delta / 35);
          k += 36;
        }
        bias = k + Math.floor((36 * delta) / (delta + 38));
        n += Math.floor(i / (out.length + 1));
        i %= out.length + 1;
        out.splice(i++, 0, n);
      }
      return String.fromCodePoint(...out);
    })
    .join('.');
}

/**
 * Sums per currency – amounts in different currencies are never added up (there are no exchange rates). Largest sum first,
 * zero sums left out; a missing currency counts as EUR (the server's default).
 */
export function sumByCurrency<T extends { currency?: string | null }>(rows: T[], amount: (r: T) => number): [string, number][] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const c = r.currency && /^[A-Z]{3}$/.test(r.currency) ? r.currency : 'EUR';
    sums.set(c, (sums.get(c) ?? 0) + (Number(amount(r)) || 0));
  }
  return [...sums].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}
