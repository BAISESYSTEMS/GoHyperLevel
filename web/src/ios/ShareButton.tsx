import { Share } from 'lucide-react';
import { toastError } from '../ui';
import { canShareLink, shareLink } from './share';

/** "Teilen" through the system share sheet (Mail, Nachrichten, AirDrop …) – only where the device has one (iPhone, iPad, Android). */
export function ShareButton({ url, title, text, label = 'Teilen' }: { url: string; title: string; text?: string; label?: string }) {
  if (!canShareLink()) return null;
  return (
    <button className="btn secondary" type="button" data-tour="share-link" onClick={() => shareLink({ title, text, url }).catch(toastError)}>
      <Share size={15} /> {label}
    </button>
  );
}
