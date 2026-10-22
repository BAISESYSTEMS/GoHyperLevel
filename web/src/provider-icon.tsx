import { Apple, FingerprintPattern, KeyRound, Mail } from 'lucide-react';

/** Monochrome provider marks (no brand colours), sized like the other icons. */
export function ProviderIcon({ icon, size = 18 }: { icon: string; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true as const };
  switch (icon) {
    case 'google':
      return (
        <svg {...p} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
          <path d="M20.5 12H12.5" />
          <path d="M20.5 12A8.5 8.5 0 1 1 18 6" />
        </svg>
      );
    case 'microsoft':
      return (
        <svg {...p} fill="currentColor">
          <rect x="3" y="3" width="8.4" height="8.4" rx="0.6" />
          <rect x="12.6" y="3" width="8.4" height="8.4" rx="0.6" opacity=".75" />
          <rect x="3" y="12.6" width="8.4" height="8.4" rx="0.6" opacity=".75" />
          <rect x="12.6" y="12.6" width="8.4" height="8.4" rx="0.6" opacity=".55" />
        </svg>
      );
    case 'github':
      return (
        <svg {...p} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
          <path d="M9 18c-4.51 2-5-2-7-2" />
        </svg>
      );
    case 'apple':
      return <Apple size={size} aria-hidden />;
    case 'passkey':
      return <FingerprintPattern size={size} aria-hidden />;
    case 'mail':
      return <Mail size={size} aria-hidden />;
    default:
      return <KeyRound size={size} aria-hidden />;
  }
}
