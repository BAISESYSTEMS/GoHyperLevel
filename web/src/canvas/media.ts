import { api, currentLocation } from '../api';
import { type CanvasElement, createElement } from '../../../server/services/canvas-model';
import { newId } from './store';

/** Images for the board: upload (same checks as the media library), sizes and the element for an image. */

export const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface BoardImage {
  src: string;
  w: number;
  h: number;
  name: string;
}

const readAsDataUrl = (file: Blob) =>
  new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error ?? new Error('Datei konnte nicht gelesen werden'));
    fr.readAsDataURL(file);
  });

/** Natural size of an image URL (falls back to 400 × 300 when it cannot be read). */
export const imageSize = (src: string) =>
  new Promise<{ w: number; h: number }>((res) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 });
    img.onerror = () => res({ w: 400, h: 300 });
    img.src = src;
  });

/** Uploads an image file to the board's sub-account; throws a readable error for unsuitable files. */
export async function uploadImage(boardId: string, file: File): Promise<BoardImage> {
  if (!IMAGE_TYPES.test(file.type)) throw new Error('Nur PNG, JPG, GIF oder WebP');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Datei größer als 8 MB');
  const data = await readAsDataUrl(file);
  const up = await api.post(`/api/canvas/${boardId}/media`, { name: file.name || 'Bild', data });
  const size = up.w && up.h ? { w: up.w as number, h: up.h as number } : await imageSize(up.src);
  return { src: up.src, w: size.w, h: size.h, name: file.name || 'Bild' };
}

/** An image element centred on (cx, cy), scaled down to at most `max` px on the long side. */
export function imageElement(img: BoardImage, cx: number, cy: number, max = 640): CanvasElement {
  const k = Math.min(1, max / Math.max(img.w, img.h, 1));
  const w = Math.max(8, Math.round(img.w * k));
  const h = Math.max(8, Math.round(img.h * k));
  return createElement({ type: 'image', src: img.src, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h, name: img.name.slice(0, 120) }, newId);
}

/** `?locationId=` for links the browser opens itself (downloads, <img>), which cannot send the header. */
export const withLocation = (url: string) => `${url}${url.includes('?') ? '&' : '?'}locationId=${encodeURIComponent(currentLocation())}`;
