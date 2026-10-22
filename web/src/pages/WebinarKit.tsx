import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Select } from '../ui';

/** Shared pieces of the Webinare pages: re-exports of the pure helpers (webinar-format.ts), the video length reader, the workflow picker. */
export * from './webinar-format';

/** The length of a video file on this computer (read from its metadata), or 0. */
export function fileDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (n: number) => {
      URL.revokeObjectURL(url);
      resolve(n);
    };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? Math.round(v.duration) : 0);
    v.onerror = () => done(0);
    v.src = url;
  });
}

/** A webinar for the workflow editor's step and trigger forms (field type "webinar"). */
export function WebinarPicker({ value, onChange, placeholder = 'jedes Webinar' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [list, setList] = useState<{ id: string; title: string; status: string }[]>([]);
  useEffect(() => {
    let on = true;
    api.get('/api/webinars').then((r) => on && setList(Array.isArray(r) ? r : [])).catch(() => on && setList([]));
    return () => {
      on = false;
    };
  }, []);
  return <Select value={value} onChange={onChange} placeholder={placeholder} options={list.map((w) => [w.id, `${w.title}${w.status === 'draft' ? ' (Entwurf)' : ''}`] as [string, string])} />;
}

/** A section with a heading in the editor tabs. */
export function Section({ title, children, hint, tour }: { title: string; children: ReactNode; hint?: ReactNode; tour?: string }) {
  return (
    <section className="card wb-sec" data-tour={tour}>
      <h3>{title}</h3>
      {hint && <p className="muted small wb-hint">{hint}</p>}
      {children}
    </section>
  );
}
