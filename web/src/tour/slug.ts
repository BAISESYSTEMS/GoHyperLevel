/** Anchor id of a heading, like GitHub makes them (`## Blog & Kurse` → `blog--kurse`), so links in docs/README work in the app too. */
export const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
