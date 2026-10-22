/**
 * Share sheet instead of a download where the device has one (Web Share API: iPhone, iPad, Android): invoices (link), exports (file).
 * An installed iOS app has no download manager, so a file goes to Share → Sichern in Dateien / Mail / AirDrop. Tests: tests/ios-logic.test.ts.
 */

export interface ShareNav {
  share?: (data: { title?: string; text?: string; url?: string; files?: File[] }) => Promise<void>;
  canShare?: (data: { files?: File[] }) => boolean;
}

export const canShareLink = (nav: ShareNav = navigator as unknown as ShareNav) => typeof nav.share === 'function';

/** The person closed the share sheet – not an error. */
const cancelled = (e: unknown) => (e as { name?: string })?.name === 'AbortError';

/** Opens the share sheet for a link. false when the device has none (the caller shows its copy button) or the person cancelled. */
export async function shareLink(data: { title: string; text?: string; url: string }, nav: ShareNav = navigator as unknown as ShareNav): Promise<boolean> {
  if (!canShareLink(nav)) return false;
  try {
    await nav.share!(data);
    return true;
  } catch (e) {
    if (cancelled(e)) return false;
    throw e;
  }
}

/** Whether a file of this kind can go through the share sheet. */
export function canShareFile(file: File, nav: ShareNav = navigator as unknown as ShareNav): boolean {
  return typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] });
}

/**
 * Saves a generated file: share sheet in the installed app on a touch device (where "download" has nowhere to go), a normal
 * download everywhere else.
 */
export async function saveBlob(blob: Blob, filename: string, opts: { standalone?: boolean; nav?: ShareNav; doc?: Document } = {}): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const nav = opts.nav ?? (navigator as unknown as ShareNav);
  const doc = opts.doc ?? document;
  const standalone = opts.standalone ?? doc.documentElement.dataset.standalone === '1';
  const file = typeof File === 'function' ? new File([blob], filename, { type: blob.type }) : null;
  if (standalone && file && canShareFile(file, nav)) {
    try {
      await nav.share!({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (cancelled(e)) return 'cancelled';
      /* fall through to the download */
    }
  }
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}
