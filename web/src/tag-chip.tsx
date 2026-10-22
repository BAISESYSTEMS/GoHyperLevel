import { useEffect, useState, type CSSProperties } from 'react';
import { api, currentLocation } from './api';
import { TagInput } from './ui';
import './tag-chip.css';

/**
 * The shared tag chip: every place that shows a contact's tags renders them through `TagChip`/`TagChips` (or
 * `ContactTagInput` where they are edited), so the colours and categories from the settings (modules/tag-meta.ts)
 * show the same everywhere. The colours are loaded once per sub-account and page load; `refreshTagMeta()` after an edit.
 */

export interface TagMetaTag {
  id: string;
  name: string;
  color: string;
  category_id: string | null;
}
export interface TagCategory {
  id: string;
  name: string;
  color: string;
  position: number;
}
export interface TagMeta {
  tags: TagMetaTag[];
  categories: TagCategory[];
}

const EMPTY: TagMeta = { tags: [], categories: [] };
let cache: { loc: string; p: Promise<TagMeta>; v?: TagMeta } | null = null;
const listeners = new Set<() => void>();

export function loadTagMeta(): Promise<TagMeta> {
  const loc = currentLocation();
  if (!cache || cache.loc !== loc) {
    const entry: { loc: string; p: Promise<TagMeta>; v?: TagMeta } = { loc, p: Promise.resolve(EMPTY) };
    entry.p = api
      .get<TagMeta>('/api/tags/meta')
      .catch(() => EMPTY)
      .then((v) => (entry.v = v));
    cache = entry;
  }
  return cache.p;
}

/** Drops the cached colours (after a change in the settings) and re-renders every chip. */
export function refreshTagMeta() {
  cache = null;
  void loadTagMeta().then(() => listeners.forEach((f) => f()));
}

export function useTagMeta(): TagMeta {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    let live = true;
    if (!cache?.v) void loadTagMeta().then(() => live && f());
    return () => {
      live = false;
      listeners.delete(f);
    };
  }, []);
  return cache?.loc === currentLocation() && cache.v ? cache.v : EMPTY;
}

/** The colour a tag shows: its own, else its category's, else none (''). */
export function tagColor(meta: TagMeta, name: string): string {
  const t = meta.tags.find((x) => x.name === name);
  if (!t) return '';
  if (t.color) return t.color;
  return (t.category_id && meta.categories.find((c) => c.id === t.category_id)?.color) || '';
}

export const chipStyle = (color: string): CSSProperties | undefined => (color ? ({ '--tc': color } as CSSProperties) : undefined);

export function TagChip({ name, meta }: { name: string; meta?: TagMeta }) {
  const own = useTagMeta();
  const color = tagColor(meta ?? own, name);
  return (
    <span className={`tag${color ? ' tc' : ''}`} style={chipStyle(color)}>
      {name}
    </span>
  );
}

/** A row of chips; `max` shows that many and "+n" for the rest. */
export function TagChips({ tags, max }: { tags: string[] | null | undefined; max?: number }) {
  const meta = useTagMeta();
  const list = tags ?? [];
  const shown = max ? list.slice(0, max) : list;
  return (
    <>
      {shown.map((tag) => (
        <TagChip key={tag} name={tag} meta={meta} />
      ))}
      {max && list.length > max && <span className="muted small">+{list.length - max}</span>}
    </>
  );
}

/** The tag editor with coloured chips (contact page, new contact). */
export function ContactTagInput(props: { value: string[]; onChange: (v: string[]) => void; suggestions?: string[]; placeholder?: string }) {
  const meta = useTagMeta();
  return <TagInput {...props} chip={(tag) => chipProps(tagColor(meta, tag))} />;
}

const chipProps = (color: string) => (color ? { className: 'tag tc', style: chipStyle(color) } : undefined);
