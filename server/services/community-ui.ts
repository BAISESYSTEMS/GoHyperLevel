import type { App } from '../core/app.js';
import type { Ctx, RawResult } from '../core/http.js';
import type { Contact } from './contacts.js';

/**
 * Where the community extensions plug into the member pages. community-portal.ts renders the feed, posts, members and profiles;
 * the other community-*.ts modules add their parts through these lists (app.services.communityUi), so no feature has to edit
 * another one's file. Every hook runs per request, receives plain data and returns HTML (already escaped) or nothing.
 */

export interface PortalCtx {
  locationId: string;
  base: string;
  loc: any;
  [k: string]: any;
}
export interface PortalMember {
  contact: Contact;
  sessionHash: string;
}
export type Group = Record<string, any>;

/** What the composer (or the team API) sent in addition to title and text: poll, video, GIF … – checked before the post exists. */
export interface PostExtrasHook {
  /** Extra inputs inside the compose form. */
  fields?(p: PortalCtx, m: PortalMember, g: Group, draft: Record<string, any>): string;
  /** Reads and validates the form (throws HttpError with a German message). */
  fromForm?(ctx: Ctx, g: Group, m: PortalMember): unknown;
  /** Same for the team API. */
  fromApi?(body: Record<string, any>, g: Group): unknown;
  /** Stores the extras once the post has been created. */
  attach?(post: any, g: Group, prepared: unknown, by: 'member' | 'team'): void;
  /** Under the excerpt in the feed. */
  card?(p: PortalCtx, m: PortalMember, g: Group, post: any): string;
  /** In the full post view. */
  full?(p: PortalCtx, m: PortalMember, g: Group, post: any): string;
  /** Extra fields in the admin API's post. */
  api?(post: any): Record<string, any>;
  /** Cleans up when a post goes. */
  remove?(post: any): void;
}

export interface Tab {
  key: string;
  href: string;
  label: string;
}

export interface CommunityUi {
  /** CSS (a <style> block) added to every community page. */
  head: ((p: PortalCtx) => string)[];
  /** Script URLs ('self') added to every community page. */
  scripts: string[];
  postExtras: PostExtrasHook[];
  /** More tabs of the group page. */
  tabs: ((p: PortalCtx, m: PortalMember, g: Group) => Tab[])[];
  /** Above the feed (start here, checklist, challenges). */
  feedTop: ((p: PortalCtx, m: PortalMember, g: Group, q: URLSearchParams) => string)[];
  /** The side column of the group page. */
  side: ((p: PortalCtx, m: PortalMember, g: Group) => string)[];
  /** Filter chips above the feed ("Alle", "Umfragen", "Videos" …): return [key, label] pairs; `where` narrows the posts. */
  feedFilters: ((p: PortalCtx, m: PortalMember, g: Group) => { key: string; label: string; where?: string }[])[];
  /** Actions next to a post / comment for people with a role. */
  postActions: ((p: PortalCtx, m: PortalMember, g: Group, post: any, csrf: string) => string)[];
  commentActions: ((p: PortalCtx, m: PortalMember, g: Group, post: any, c: any, csrf: string) => string)[];
  /** Sections on a member's profile page (view) and fields in the edit form. */
  profileView: ((p: PortalCtx, m: PortalMember, g: Group[], them: Contact, profile: any) => string)[];
  profileEdit: ((p: PortalCtx, m: PortalMember) => string)[];
  profileSave: ((p: PortalCtx, m: PortalMember, body: Record<string, any>, forms: (name: string) => string[]) => void)[];
  /** Where a notification of a kind leads (return undefined for "not mine"). */
  notificationTarget: ((p: PortalCtx, n: any) => string | undefined)[];
  /** Icons for notification kinds (inline SVG). */
  notificationIcon: ((kind: string) => string | undefined)[];
  /** A member opened a group page – presence and daily activity. */
  visit: ((app: App, g: Group, contactId: string) => void)[];
  /** A notification was written for these members (web push). */
  /** `quiet`: the sender pushes to the devices itself (a broadcast with the push channel), so the hooks must not push again. */
  notified: ((g: Group, contactIds: string[], n: { kind: string; text: string; postId?: string; commentId?: string; actor?: string; quiet?: boolean }) => void)[];
  /** Channels this member may not open (tier, level …): channel id → the reason shown to them. */
  closedChannels: ((g: Group, contactId: string, role: string | null) => Map<string, string>)[];
}

export function communityUi(app: App): CommunityUi {
  const s = app.services;
  s.communityUi ??= {
    head: [],
    scripts: [],
    postExtras: [],
    tabs: [],
    feedTop: [],
    side: [],
    feedFilters: [],
    postActions: [],
    commentActions: [],
    profileView: [],
    profileEdit: [],
    profileSave: [],
    notificationTarget: [],
    notificationIcon: [],
    visit: [],
    notified: [],
    closedChannels: [],
  } satisfies CommunityUi;
  return s.communityUi as CommunityUi;
}

/** The pieces of the member pages other modules reuse (set by community-portal.ts). */
export interface CommunityKit {
  portal: { resolve(key: string): any; memberOf(ctx: Ctx, p: any): PortalMember | undefined };
  cbase(p: PortalCtx): string;
  gHref(p: PortalCtx, g: Group): string;
  postHref(p: PortalCtx, g: Group, postId: string): string;
  csrf(m: PortalMember): string;
  tokenInput(m: PortalMember): string;
  when(p: PortalCtx, iso: string): string;
  fileUrl(p: PortalCtx, fileId: string): string;
  avatar(p: PortalCtx, name: string, pr?: any, size?: string, level?: number): string;
  profile(p: PortalCtx, contactId: string): any;
  levelOf(g: Group, contactId: string | null): number;
  renderText(p: PortalCtx, src: string, byMember: boolean): string;
  frame(p: PortalCtx, m: PortalMember, title: string, body: string, status?: number, opts?: { scripts?: string[]; head?: string; frameSrc?: string[]; permissions?: string }): RawResult;
  errorPage(p: PortalCtx, m: PortalMember, msg: string, status: number): RawResult;
  withMember(ctx: Ctx, fn: (p: PortalCtx, m: PortalMember) => RawResult | Promise<RawResult>): RawResult | Promise<RawResult>;
  withGroup(ctx: Ctx, fn: (p: PortalCtx, m: PortalMember, g: Group) => RawResult | Promise<RawResult>): RawResult | Promise<RawResult>;
  withPost(ctx: Ctx, fn: (p: PortalCtx, m: PortalMember, g: Group, post: any) => RawResult | Promise<RawResult>): RawResult | Promise<RawResult>;
  withComment(ctx: Ctx, fn: (p: PortalCtx, m: PortalMember, g: Group, c: any, post: any) => RawResult | Promise<RawResult>): RawResult | Promise<RawResult>;
  back(p: PortalCtx, v: unknown, fallback: string): string;
  fail(e: unknown): { status: number; msg: string };
  formAll(ctx: Ctx, name: string): string[];
  tz(p: PortalCtx): string;
  icons: Record<string, string>;
  /** The group's cover and name, and the row of tabs (on = the key of the open one) – for pages that look like a part of the group. */
  groupHead(p: PortalCtx, g: Group): string;
  groupTabs(p: PortalCtx, m: PortalMember, g: Group, on: string): string;
  groupsOf(p: PortalCtx, m: PortalMember): Group[];
  /** The member's role in the group (admin, moderator) or null. */
  roleOf(g: Group, contactId: string): 'admin' | 'moderator' | null;
}

export const kitOf = (app: App): CommunityKit => {
  const k = app.services.communityKit as CommunityKit | undefined;
  if (!k) throw new Error('Community-Mitgliederbereich nicht verfügbar');
  return k;
};
