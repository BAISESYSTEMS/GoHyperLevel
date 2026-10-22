import { Suspense, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './theme/theme.css';
import { api, currentLocation, name, setLocation } from './api';
import { BASE, ConfirmHost, Toasts, navigate, useFocusLayer, useRoute } from './ui';
// UI language (docs/translating.md): German texts are the message ids; the English catalogs are chunks of their own.
import { useLocale, useT, type TFn } from './i18n';
import { startSignedIn, startSignedOut } from './i18n/session';
// Shell, login and dashboard are in the first download; every other page is its own chunk (lazy.tsx).
import { Deferred, Later, PageSuspense, lazyPages, preload, whenIdle } from './lazy';
import { Dashboard } from './pages/Dashboard';
const { Contacts, ContactDetail } = lazyPages(() => import('./pages/Contacts'), 'Contacts', 'ContactDetail');
const { Opportunities } = lazyPages(() => import('./pages/Opportunities'), 'Opportunities');
const { Sales } = lazyPages(() => import('./pages/Sales'), 'Sales');
const { Calendars } = lazyPages(() => import('./pages/Calendars'), 'Calendars');
const { Conversations } = lazyPages(() => import('./pages/Conversations'), 'Conversations');
const { Calls } = lazyPages(() => import('./pages/Calls'), 'Calls');
const { Forms, FormEditor } = lazyPages(() => import('./pages/Forms'), 'Forms', 'FormEditor');
const { Funnels, FunnelEditor } = lazyPages(() => import('./pages/Funnels'), 'Funnels', 'FunnelEditor');
const { Courses, CourseEditor } = lazyPages(() => import('./pages/Courses'), 'Courses', 'CourseEditor');
const { Community, CommunityGroup } = lazyPages(() => import('./pages/Community'), 'Community', 'CommunityGroup');
const { Workflows, WorkflowEditor } = lazyPages(() => import('./pages/Workflows'), 'Workflows', 'WorkflowEditor');
const { Campaigns, CampaignEditor } = lazyPages(() => import('./pages/Campaigns'), 'Campaigns', 'CampaignEditor');
const { Invoices, InvoiceEditor, Products } = lazyPages(() => import('./pages/Payments'), 'Invoices', 'InvoiceEditor', 'Products');
const { ContractEditor, Contracts } = lazyPages(() => import('./pages/Contracts'), 'ContractEditor', 'Contracts');
const { Social } = lazyPages(() => import('./pages/Social'), 'Social');
const { VideoStudio } = lazyPages(() => import('./pages/VideoStudio'), 'VideoStudio');
const { KiStudio } = lazyPages(() => import('./pages/KiStudio'), 'KiStudio');
// AI Studio (docs/ai-studio.md): menu entry "AI Studio" (Beta) under Seiten.
const { AiStudio } = lazyPages(() => import('./pages/AiStudio'), 'AiStudio');
const { Project } = lazyPages(() => import('./pages/Project'), 'Project');
const { Reviews } = lazyPages(() => import('./pages/Reviews'), 'Reviews');
const { Tasks } = lazyPages(() => import('./pages/Tasks'), 'Tasks');
const { Pm } = lazyPages(() => import('./pages/Pm'), 'Pm');
const { PmTime } = lazyPages(() => import('./pages/PmTime'), 'PmTime');
const { PmProfit } = lazyPages(() => import('./pages/PmProfit'), 'PmProfit');
const { PmTopbar } = lazyPages(() => import('./pages/PmGlobal'), 'PmTopbar');
const { Settings } = lazyPages(() => import('./pages/Settings'), 'Settings');
const { Agency } = lazyPages(() => import('./pages/Agency'), 'Agency');
import { PlanLocked, SaasBanner, loadSaasAccount } from './pages/SaasBilling';
const { Attribution } = lazyPages(() => import('./pages/Attribution'), 'Attribution');
const { AdsManager } = lazyPages(() => import('./pages/AdsManager'), 'AdsManager');
const { Affiliates } = lazyPages(() => import('./pages/Affiliates'), 'Affiliates');
const { TicketDetail, Tickets } = lazyPages(() => import('./pages/Tickets'), 'TicketDetail', 'Tickets');
const { KnowledgeBase } = lazyPages(() => import('./pages/KnowledgeBase'), 'KnowledgeBase');
const { Surveys } = lazyPages(() => import('./pages/Surveys'), 'Surveys');
const { AppsHub } = lazyPages(() => import('./pages/Composio'), 'AppsHub');
const { Reports } = lazyPages(() => import('./pages/Reports'), 'Reports');
const { Accounting } = lazyPages(() => import('./pages/Accounting'), 'Accounting');
const { Inventory } = lazyPages(() => import('./pages/Inventory'), 'Inventory');
const { Hr } = lazyPages(() => import('./pages/Hr'), 'Hr');
const { Calc } = lazyPages(() => import('./pages/Calc'), 'Calc');
const { Boards } = lazyPages(() => import('./pages/Boards'), 'Boards');
// The Arbeitsfläche (pages side by side for ultrawide screens and headsets) – its own chunk, docs/xr.md.
const { Workspace } = lazyPages(() => import('./xr/Workspace'), 'Workspace');
const { SpatialSuggest } = lazyPages(() => import('./xr/SpatialSuggest'), 'SpatialSuggest');
// Fokus-Modus (route `focus`): ask instead of navigating – the page is its own chunk, the entry and the shell switch are tiny (docs/living-boards.md#fokus-modus).
const { FocusPage, FocusFab } = lazyPages(() => import('./focus/FocusPage'), 'FocusPage', 'FocusFab');
import { FocusEnter } from './focus/FocusEnter';
// …mit Companion: edge button, Alt+J, wake word and check-ins on every page – a chunk of its own, mounted a moment after the page.
const { CompanionLayer } = lazyPages(() => import('./companion/CompanionLayer'), 'CompanionLayer');
import { resumeFocus, useFocusMode } from './focus/store';
const { Webinars } = lazyPages(() => import('./pages/Webinars'), 'Webinars');
const { PaymentPlans } = lazyPages(() => import('./pages/PaymentPlans'), 'PaymentPlans');
const { Dunning } = lazyPages(() => import('./pages/Dunning'), 'Dunning');
const { Sepa } = lazyPages(() => import('./pages/Sepa'), 'Sepa');
// Online-Shop and Gutscheine (docs/store.md) – chunks of their own.
const { Shop } = lazyPages(() => import('./pages/Shop'), 'Shop');
const { GiftCards } = lazyPages(() => import('./pages/GiftCards'), 'GiftCards');
const { Quizzes } = lazyPages(() => import('./pages/Quizzes'), 'Quizzes');
const { CommentDm } = lazyPages(() => import('./pages/CommentDm'), 'CommentDm');
// Rückgängig: toast, Strg+Z, Verlauf (UndoLayer, HistoryButton) and the Papierkorb page – one small chunk each.
const { UndoLayer, HistoryButton } = lazyPages(() => import('./undo/Undo'), 'UndoLayer', 'HistoryButton');
const { Trash } = lazyPages(() => import('./pages/Trash'), 'Trash');
const { UmzugAssistent } = lazyPages(() => import('./pages/UmzugAssistent'), 'UmzugAssistent');
import { DEFAULT_BRANDING, SessionCtx, applyBranding, can, takeLocParam, type Branding, type Session } from './session';
import { Menu, Search as SearchIcon } from 'lucide-react';
import { Icon, type IconName } from './icons';
import { CommandPalette } from './nav';
import { InstallHint, registerPwa } from './pwa';
// iPhone, iPad and foldables (docs/ios-web-app.md): bottom bar, number on the app icon, viewport/keyboard handling; the rest is a lazy chunk.
import './ios/ios.css';
import { useAppBadge } from './ios/badge';
import { MasterDetail } from './ios/MasterDetail';
import { modKey } from './ios/shortcuts';
import { TabBar } from './ios/TabBar';
import { initViewport } from './ios/viewport';
const { IosLayer } = lazyPages(() => import('./ios/IosLayer'), 'IosLayer');
import { MountFlag, RootBoundary, StartSpinner } from './boot';
import { Sidebar } from './theme/Sidebar';
import { DEPT_OF_ROUTE } from './theme/depts';
import { loadAppearance, loadPublicAppearance, useLook, useModules } from './theme/store';
// Einfach-Modus: goal setup for new logins, a banner once for existing ones; the area registry and menu use (web/src/areas).
const { GoalSetup, GoalBanner } = lazyPages(() => import('./areas/GoalSetup'), 'GoalSetup', 'GoalBanner');
import { registerNav } from './areas/registry';
import { startNavSession, trackVisit } from './areas/adaptive';
const { BrowserPhone } = lazyPages(() => import('./pages/Phone'), 'BrowserPhone');
const { Academy } = lazyPages(() => import('./pages/Academy'), 'Academy');
const { TourLayer } = lazyPages(() => import('./tour/engine'), 'TourLayer');
const { HelpButton, SandboxBanner } = lazyPages(() => import('./tour/help'), 'HelpButton', 'SandboxBanner');
const { Companies, CompanyDetail } = lazyPages(() => import('./pages/Companies'), 'Companies', 'CompanyDetail');
const { ObjectNav, ObjectsPage } = lazyPages(() => import('./pages/Objects'), 'ObjectNav', 'ObjectsPage');
const { Properties } = lazyPages(() => import('./pages/Properties'), 'Properties');
const { LeadScoring } = lazyPages(() => import('./pages/LeadScoring'), 'LeadScoring');
import { LoginPage, SecurityGate } from './pages/Login';
const { OAuthConsent } = lazyPages(() => import('./pages/OAuthConsent'), 'OAuthConsent');
const { AgentButton, AgentPanel } = lazyPages(() => import('./agent/Panel'), 'AgentButton', 'AgentPanel');
const { AgentsPage } = lazyPages(() => import('./agent/AgentsPage'), 'AgentsPage');
const { FeedbackButton, FeedbackPage } = lazyPages(() => import('./pages/Feedback'), 'FeedbackButton', 'FeedbackPage');
const { WishesPage } = lazyPages(() => import('./pages/Wishes'), 'WishesPage');
const { Wiki } = lazyPages(() => import('./pages/Wiki'), 'Wiki');
// Office (documents, spreadsheets, presentations, PDF): list, file view and the editor bridge – a chunk of its own (docs/office.md).
const { Office } = lazyPages(() => import('./pages/Office'), 'Office');
const { TeamChat } = lazyPages(() => import('./pages/TeamChat'), 'TeamChat');
// Live-Zusammenarbeit überall: who is on which page, "saved here", cursors – a chunk of its own (docs/collaboration.md).
const { PresenceBar, PresenceLayer } = lazyPages(() => import('./presence/Presence'), 'PresenceBar', 'PresenceLayer');
import { DemoBanner } from './demo';
import { Slot } from './slots';
// Werkstatt and Marktplatz: the pages and the build dialog are chunks of their own; the menu parts are small.
import { WerkstattNav } from './werkstatt/Nav';
import { BoardsNav } from './boards/Nav';
import { goHome } from './boards/home';
import { PluginNav, PluginPage } from './werkstatt/PluginFrame';
const { BuildLayer } = lazyPages(() => import('./werkstatt/Build'), 'BuildLayer');
const { MarktplatzPage } = lazyPages(() => import('./werkstatt/Marktplatz'), 'MarktplatzPage');
const { WerkstattPage } = lazyPages(() => import('./werkstatt/Werkstatt'), 'WerkstattPage');

// The Canvas (editor + renderer, its own CSS) is a chunk of its own, loaded only when someone opens it.
const { CanvasPage } = lazyPages(() => import('./canvas/CanvasPage').then((m) => ({ CanvasPage: m.default })), 'CanvasPage');

/** [route, icon, label, permission] or a group heading. The German labels are the message ids of the menu (shell catalog). */
type NavItem = [string, IconName, string, string];
const NAV: (['group', string] | NavItem)[] = [
  ['dashboard', 'dashboard', 'Dashboard', 'dashboard'],
  ['boards', 'boards', 'Boards', 'dashboard'],
  ['workspace', 'workspace', 'Arbeitsfläche', 'dashboard'],
  ['reports', 'reports', 'Berichte', 'dashboard'],
  ['project', 'project', 'Projekt', 'dashboard'],
  ['conversations', 'conversations', 'Konversationen', 'conversations'],
  ['calls', 'phone', 'Anrufe', 'conversations'],
  ['calendars', 'calendars', 'Kalender', 'calendars'],
  ['contacts', 'contacts', 'Kontakte', 'contacts'],
  ['companies', 'company', 'Firmen', 'contacts'],
  ['objects', 'objects', 'Objekte', 'contacts'],
  ['opportunities', 'opportunities', 'Opportunities', 'opportunities'],
  ['sales', 'trophy', 'Vertrieb', 'opportunities'],
  ['tasks', 'tasks', 'Aufgaben', 'contacts'],
  ['pm', 'gantt', 'Projektplanung', 'contacts'],
  ['time', 'schedule', 'Zeiterfassung', 'contacts'],
  ['canvas', 'canvas', 'Canvas', 'canvas'],
  ['wiki', 'wiki', 'Wiki', 'wiki'],
  ['office', 'office', 'Office', 'office'],
  ['team-chat', 'teamchat', 'Team-Chat', 'teamchat'],
  ['group', 'Service'],
  ['tickets', 'ticket', 'Tickets', 'helpdesk'],
  ['help-center', 'kb', 'Wissensdatenbank', 'helpdesk'],
  ['surveys', 'survey', 'Umfragen', 'helpdesk'],
  ['group', 'Marketing'],
  ['campaigns', 'campaigns', 'Kampagnen', 'campaigns'],
  ['workflows', 'workflows', 'Automationen', 'workflows'],
  ['social', 'social', 'Social Planner', 'social'],
  ['video-studio', 'studio', 'Video-Studio', 'social'],
  ['ki-studio', 'sparkles', 'KI-Studio', 'social'],
  ['attribution', 'attribution', 'Attribution', 'dashboard'],
  ['ads', 'ads', 'Anzeigen', 'campaigns'],
  ['lead-scoring', 'gauge', 'Lead-Scoring', 'contacts'],
  ['webinars', 'webinar', 'Webinare', 'funnels'],
  ['comment-dm', 'instagram', 'Kommentar-zu-DM', 'social'],
  ['group', 'Seiten'],
  ['funnels', 'funnels', 'Funnels & Websites', 'funnels'],
  // Beta pill: areas/info.ts AREA_BADGE. Einfach-Modus: under "Mehr" until used (areas-model.ts promotes it).
  ['ai-studio', 'sparkles', 'AI Studio', 'funnels'],
  ['forms', 'forms', 'Formulare & Umfragen', 'forms'],
  ['courses', 'courses', 'Kurse', 'courses'],
  ['quizzes', 'award', 'Quiz & Zertifikate', 'courses'],
  ['community', 'community', 'Community', 'courses'],
  ['group', 'Umsatz'],
  ['invoices', 'invoices', 'Rechnungen & Angebote', 'payments'],
  ['contracts', 'contracts', 'Verträge', 'payments'],
  ['products', 'products', 'Produkte', 'payments'],
  ['shop', 'cart', 'Online-Shop', 'payments'],
  ['gift-cards', 'gift', 'Gutscheine', 'payments'],
  ['payment-plans', 'repeat', 'Ratenzahlung', 'payments'],
  ['dunning', 'push', 'Mahnwesen', 'payments'],
  ['sepa', 'bank', 'SEPA', 'payments'],
  ['affiliates', 'affiliates', 'Affiliates', 'payments'],
  ['calc', 'calculator', 'Gewinnrechner', 'payments'],
  ['profit', 'trendUp', 'Rentabilität', 'payments'],
  ['reviews', 'reviews', 'Bewertungen', 'reviews'],
  ['group', 'Back-Office'],
  ['accounting', 'ledger', 'Buchhaltung', 'accounting'],
  ['inventory', 'warehouse', 'Lager & Einkauf', 'inventory'],
  // 'hr' = Personal for HR staff (area granted explicitly) and "Mein Bereich" for every employee/manager (see can()).
  ['personal', 'hr', 'Personal', 'hr'],
  ['group', ''],
  ['agents', 'bot', 'KI-Agenten', '*'],
  // The labels are literals (the menu tests parse this list); tests/werkstatt.test.ts keeps them equal to NAMES.
  ['werkstatt', 'hammer', 'Werkstatt', '*'],
  ['marktplatz', 'store', 'Marktplatz', '*'],
  ['apps', 'apps', 'Apps', 'settings'],
  ['umzug', 'umzug', 'Umzug', 'settings'],
  ['academy', 'academy', 'Akademie', '*'],
  ['trash', 'trash', 'Papierkorb', '*'],
  ['settings', 'settings', 'Einstellungen', 'settings'],
];
const NAV_ITEMS = NAV.filter((n): n is NavItem => n[0] !== 'group');
registerNav(NAV);
/** Entries shown below a menu item (e.g. the custom objects under "Objekte"). */
const NAV_CHILDREN: Record<string, ComponentType<{ cur: string[] }>> = { objects: ObjectNav, marktplatz: PluginNav, werkstatt: WerkstattNav, boards: BoardsNav };

/** Route → its page, to load the chunk ahead of the click (hover, idle). Page() below renders them. */
const ROUTE_PAGES: Record<string, unknown[]> = {
  agency: [Agency], dashboard: [Dashboard], boards: [Boards], workspace: [Workspace], reports: [Reports], project: [Project], conversations: [Conversations], calls: [Calls], calendars: [Calendars],
  contacts: [Contacts, ContactDetail], companies: [Companies], objects: [ObjectsPage], opportunities: [Opportunities], sales: [Sales], tasks: [Tasks], pm: [Pm], time: [PmTime], profit: [PmProfit], tickets: [Tickets],
  'help-center': [KnowledgeBase], surveys: [Surveys], campaigns: [Campaigns], workflows: [Workflows], social: [Social], 'video-studio': [VideoStudio],
  'ki-studio': [KiStudio], 'ai-studio': [AiStudio], attribution: [Attribution], ads: [AdsManager], 'lead-scoring': [LeadScoring], funnels: [Funnels], forms: [Forms], courses: [Courses],
  community: [Community], invoices: [Invoices], contracts: [Contracts], products: [Products], affiliates: [Affiliates], calc: [Calc], webinars: [Webinars], reviews: [Reviews], 'payment-plans': [PaymentPlans], dunning: [Dunning], sepa: [Sepa], shop: [Shop], 'gift-cards': [GiftCards], quizzes: [Quizzes], 'comment-dm': [CommentDm],
  accounting: [Accounting], inventory: [Inventory], personal: [Hr], focus: [FocusPage],
  agents: [AgentsPage], trash: [Trash], canvas: [CanvasPage], werkstatt: [WerkstattPage], marktplatz: [MarktplatzPage], wiki: [Wiki], office: [Office], 'team-chat': [TeamChat], apps: [AppsHub], umzug: [UmzugAssistent], academy: [Academy], settings: [Settings], feedback: [FeedbackPage], wishes: [WishesPage], properties: [Properties],
};
const preloadRoute = (route: string) => preload(...(ROUTE_PAGES[route] ?? []));

/** The visible menu for this user: entries they may use, headings only above a visible entry. */
function navFor(session: Pick<Session, 'user' | 'saas' | 'hr'>) {
  const items = NAV.filter((n) => n[0] === 'group' || can(session, n[3]!));
  return items.filter((n, i) => n[0] !== 'group' || (items[i + 1] && items[i + 1][0] !== 'group'));
}

/** The menu in the UI language: labels and headings through the shell catalog. */
function translateNav<T extends (['group', string] | NavItem)[]>(t: TFn, entries: T): T {
  return entries.map((n) => (n[0] === 'group' ? ['group', n[1] ? t(n[1]) : ''] : [n[0], n[1], t(n[2] as string), n[3]])) as T;
}

/** Whether the login is HR staff, an employee or a manager in this sub-account – decides if "Personal" shows in the menu. */
const loadHrAccess = () => api.get('/api/me/hr').then((m) => ({ is_hr: !!m.is_hr, employee: !!m.employee, is_manager: !!m.is_manager })).catch(() => null);

function Search() {
  const t = useT('shell');
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any>();
  // Hidden areas (Darstellung → Sichtbare Bereiche) do not show up in the search either.
  const { visible } = useModules();
  const contactsOn = visible('contacts');
  const dealsOn = visible('opportunities');
  useEffect(() => {
    if (q.length < 2) return setRes(undefined);
    const timer = setTimeout(() => api.get(`/api/search?q=${encodeURIComponent(q)}`).then(setRes).catch(() => {}), 200);
    return () => clearTimeout(timer);
  }, [q]);
  if (!contactsOn && !dealsOn) return <div className="search" />;
  const contacts: any[] = contactsOn ? (res?.contacts ?? []) : [];
  const deals: any[] = dealsOn ? (res?.opportunities ?? []) : [];
  return (
    <div className="search" data-tour="search">
      <input placeholder={contactsOn && dealsOn ? t('Suchen: Kontakte, Deals…') : contactsOn ? t('Suchen: Kontakte…') : t('Suchen: Deals…')} aria-label={t('Suchen')} value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setTimeout(() => setRes(undefined), 200)} />
      {res && contacts.length + deals.length > 0 && (
        <div className="results">
          {contacts.map((c: any) => (
            <a key={c.id} href={`${BASE}/contacts/${c.id}`} onClick={(e) => (e.preventDefault(), setQ(''), navigate(`contacts/${c.id}`))}>
              <Icon name="contact" /> {name(c)} <span className="muted small">{c.email}</span>
            </a>
          ))}
          {deals.map((o: any) => (
            <a key={o.id} href={`${BASE}/opportunities`} onClick={(e) => (e.preventDefault(), setQ(''), navigate(`opportunities?pipeline=${o.pipeline_id}`))}>
              <Icon name="deal" /> {o.name}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Page({ route, session }: { route: string[]; session: Session }) {
  const t = useT('shell');
  const [p, id] = route;
  const visible = navFor(session).filter((n) => n[0] !== 'group');
  // The agency lands on the overview of all projects; everyone else in their project.
  const page = p ?? (session.user.role === 'admin' ? 'agency' : can(session, 'dashboard') ? 'dashboard' : visible[0]?.[0] ?? 'settings');
  const entry = NAV.find((n) => n[0] === page && n[0] !== 'group');
  if (entry && !can(session, entry[3]!)) return session.saas?.blocked?.includes(entry[3]!) ? <PlanLocked /> : <p>{t('Kein Zugriff auf diesen Bereich.')}</p>;
  switch (page) {
    case 'agency':
      return session.user.role === 'admin' ? <Agency tab={id} /> : <p>{t('Nur für die Agentur.')}</p>;
    case 'dashboard':
      return <Dashboard />;
    case 'reports':
      return <Reports path={route.slice(1)} />;
    case 'project':
      return <Project />;
    case 'contacts':
      // iPad / unfolded foldable: list and contact side by side (web/src/ios/MasterDetail.tsx).
      // Nothing open: the full table with every chosen column; side by side only while a contact is open (pages/smart-lists.css).
      return <MasterDetail open={!!id} className={id ? undefined : 'md-full-list'} list={<Contacts />} detail={id ? <ContactDetail id={id} /> : null} empty={t('Wähle links einen Kontakt.')} />;
    case 'companies':
      return id ? <CompanyDetail id={id} /> : <Companies />;
    case 'objects':
      return <ObjectsPage route={route.slice(1)} />;
    case 'properties':
      return <Properties object={id} />;
    case 'lead-scoring':
      return <LeadScoring />;
    case 'opportunities':
      return <Opportunities />;
    case 'sales':
      return <Sales tab={id} />;
    case 'calls':
      return <Calls tab={id} item={route[2]} />;
    case 'calendars':
      return <Calendars />;
    case 'conversations':
      return <Conversations initial={id ?? new URLSearchParams(location.search).get('c') ?? undefined} />;
    case 'forms':
      return id ? <FormEditor id={id} /> : <Forms />;
    case 'funnels':
      return id ? <FunnelEditor id={id} /> : <Funnels />;
    case 'workflows':
      return id ? <WorkflowEditor id={id} /> : <Workflows />;
    case 'courses':
      return id ? <CourseEditor id={id} /> : <Courses />;
    case 'community':
      return id && id !== 'reports' && id !== 'settings' ? <CommunityGroup id={id} /> : <Community tab={id} />;
    case 'campaigns':
      return id && !['segments', 'gallery', 'templates', 'deliverability', 'links'].includes(id) ? <CampaignEditor id={id} /> : <Campaigns tab={id} />;
    case 'invoices':
      return id ? <InvoiceEditor id={id} /> : <Invoices />;
    case 'social':
      return <Social tab={id} />;
    case 'video-studio':
      return <VideoStudio path={route.slice(1)} />;
    case 'ki-studio':
      return <KiStudio tab={id} />;
    case 'ai-studio':
      return <AiStudio id={id} />;
    case 'contracts':
      return id ? <ContractEditor id={id} /> : <Contracts />;
    case 'products':
      return <Products />;
    case 'reviews':
      return <Reviews />;
    case 'accounting':
      return <Accounting tab={id} />;
    case 'inventory':
      return <Inventory tab={id} />;
    case 'personal':
      return <Hr tab={id} />;
    case 'attribution':
      return <Attribution tab={id} />;
    case 'ads':
      return <AdsManager path={route.slice(1)} />;
    case 'affiliates':
      return <Affiliates tab={id} />;
    case 'calc':
      return <Calc id={id} />;
    case 'boards':
      return <Boards id={id} />;
    case 'workspace':
      return <Workspace renderPage={(r) => <Page route={r} session={session} />} />;
    case 'focus':
      return <FocusPage />;
    case 'webinars':
      return <Webinars id={id} tab={route[2]} />;
    case 'payment-plans':
      return <PaymentPlans tab={id} />;
    case 'dunning':
      return <Dunning tab={id} />;
    case 'sepa':
      return <Sepa tab={id} />;
    case 'shop':
      return <Shop tab={id} />;
    case 'gift-cards':
      return <GiftCards />;
    case 'quizzes':
      return <Quizzes tab={id} />;
    case 'comment-dm':
      return <CommentDm />;
    case 'tickets':
      return id && id !== 'uebersicht' && id !== 'auslastung' ? <TicketDetail id={id} /> : <Tickets tab={id} />;
    case 'help-center':
      return <KnowledgeBase />;
    case 'surveys':
      return <Surveys tab={id} />;
    case 'tasks':
      return <Tasks />;
    case 'pm':
      return <Pm path={route.slice(1)} />;
    case 'time':
      return <PmTime tab={id} />;
    case 'profit':
      return <PmProfit tab={id} />;
    case 'canvas':
      return <CanvasPage id={id} />;
    case 'wiki':
      return <Wiki id={id} />;
    case 'office':
      return <Office id={id} />;
    case 'team-chat':
      return <TeamChat id={id} />;
    case 'apps':
      return <AppsHub tab={id} />;
    case 'umzug':
      return <UmzugAssistent />;
    case 'agents':
      return <AgentsPage tab={id} />;
    case 'settings':
      return <Settings tab={id} />;
    case 'academy':
      return <Academy path={route.slice(1)} />;
    case 'trash':
      return <Trash />;
    case 'feedback':
      return <FeedbackPage />;
    case 'wishes':
      return <WishesPage />;
    case 'werkstatt':
      return <WerkstattPage />;
    case 'marktplatz':
      return <MarktplatzPage />;
    case 'plugin':
      return <PluginPage />;
    default:
      return <p>{t('Seite nicht gefunden.')}</p>;
  }
}

function Shell({ session, children }: { session: Session; children: ReactNode }) {
  const t = useT('shell');
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const look = useLook();
  const modules = useModules();
  // After an undo the page loads what it shows again (everything it held may be out of date).
  const [undone, setUndone] = useState(0);
  // …and after a pull-to-refresh in the installed app (web/src/ios/IosLayer.tsx).
  useEffect(() => {
    const on = () => setUndone((n) => n + 1);
    window.addEventListener('pghl:undone', on);
    window.addEventListener('pghl:refresh', on);
    return () => {
      window.removeEventListener('pghl:undone', on);
      window.removeEventListener('pghl:refresh', on);
    };
  }, []);
  useEffect(() => setOpen(false), [route.join('/')]);
  // The phone drawer is a layer like every dialog: the focus moves into it, Tab stays inside, Esc (hardware keyboard)
  // closes it and the focus goes back to the menu button.
  const side = useMemo(() => ({ get current() { return document.querySelector<HTMLElement>('aside.side'); } }), []);
  useFocusLayer(side, () => setOpen(false), { active: open, first: true });
  useAppBadge();
  const focus = useFocusMode(route);
  // A board that was made the start page opens right after signing in (only on the bare landing page).
  useEffect(() => void goHome(session, route), []); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = route[0] ?? (session.user.role === 'admin' ? 'agency' : navFor(session).find((n) => n[0] !== 'group')?.[0] ?? 'dashboard');
  // Once the page is up and the browser is idle: the most used pages, so the first click needs no download.
  useEffect(() => whenIdle(() => ['dashboard', 'contacts', 'conversations', 'opportunities', 'calendars', 'tasks'].filter((r) => r !== cur && navFor(session).some((n) => n[0] === r)).forEach(preloadRoute), { delay: 6000 }), []);
  const nav = translateNav(t, navFor(session));
  useEffect(() => void startNavSession(), []);
  useEffect(() => trackVisit(cur), [cur]);
  return (
    <div className={`shell${focus ? ' focus-mode' : ''}`}>
      {open && <div className="side-scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      {focus && (
        <Later>
          <FocusFab open={open} onMenu={() => setOpen(true)} />
        </Later>
      )}
      <Sidebar session={session} cur={cur} route={route} open={open} entries={nav} childrenOf={NAV_CHILDREN} preload={preloadRoute} />
      <div className="main" data-dept={DEPT_OF_ROUTE[cur]}>
        <div className="topbar">
          <button className="btn secondary small menu-btn" data-tour="menu" onClick={() => setOpen(!open)} aria-label={t('Menü')} aria-expanded={open} aria-controls="side-nav">
            <Menu size={18} />
          </button>
          <Later>
            <FocusEnter place="top" />
          </Later>
          <Search />
          <button className="btn secondary small jump-btn" data-tour="jump" onClick={() => window.dispatchEvent(new Event('pghl:palette'))} title={t('Projekt, Seite oder Claude-Sitzung (Strg+K)')}>
            <SearchIcon size={14} /> {t('Springen')} <kbd>{t(modKey(navigator.platform ?? '', navigator.userAgent))} K</kbd>
          </button>
          <Deferred>
            <PresenceBar nav={nav} />
            {can(session, 'contacts') && <PmTopbar />}
            <HistoryButton />
            <AgentButton />
            <FeedbackButton />
            <HelpButton />
          </Deferred>
        </div>
        <div className="content" key={session.locationId}>
          <SaasBanner account={session.saas as any} onChange={session.reload} />
          <Deferred>
            <SandboxBanner />
            <Slot name="shell.banner" />
          </Deferred>
          <DemoBanner />
          {look.offerGoals && !look.offerProfiles && <GoalBanner />}
          <Deferred>
            <PresenceLayer />
          </Deferred>
          <PageSuspense key={`${route[0] ?? ''}:${undone}`}>{children}</PageSuspense>
        </div>
        <TabBar entries={nav} visible={modules.visible} cur={cur} onMore={() => setOpen(true)} />
        <Later>
          <UndoLayer key={`undo-${session.locationId}`} />
        </Later>
        <CommandPalette nav={translateNav(t, NAV_ITEMS.filter((n) => modules.visible(n[0]) || n[0] === cur))} />
        {look.offerProfiles && <GoalSetup />}
        <Deferred>
          <TourLayer />
          <IosLayer userId={session.user.id} />
          <SpatialSuggest />
          <BuildLayer />
          <AgentPanel key={`agent-${session.locationId}`} />
          <CompanionLayer key={`companion-${session.locationId}`} />
          {can(session, 'conversations') && <BrowserPhone key={session.locationId} />}
        </Deferred>
      </div>
    </div>
  );
}

function App() {
  // A language switch re-renders the whole app at once (i18n/index.ts loads the texts first).
  useLocale();
  const t = useT('shell');
  const [state, setState] = useState<{ loading: boolean; needsSetup?: boolean; gate?: boolean; session?: Omit<Session, 'reload' | 'switchLocation' | 'branding'> }>({ loading: true });
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const route = useRoute();

  const loadBranding = async (signedIn = false) => {
    const b = await api.get<Branding>(signedIn ? '/api/branding/me' : '/api/branding').catch(() => DEFAULT_BRANDING);
    setBranding(b);
    applyBranding(b);
  };
  const load = async () => {
    try {
      const me = await api.get('/api/me');
      let loc = takeLocParam(me.locations) ?? currentLocation();
      if (!me.locations.some((l: any) => l.id === loc)) loc = me.locations[0]?.id ?? '';
      setLocation(loc);
      void loadBranding(true);
      void loadAppearance();
      // Signed in: fetch the landing page's chunk while the next requests run.
      preloadRoute(location.pathname.replace(/^\/app\/?/, '').split('/')[0] || (me.user.role === 'admin' ? 'agency' : 'dashboard'));
      // Login policy: admins must set up a second factor before anything else (login-policy module).
      // The person's language (user.lang, else the browser's) – its shell texts load alongside.
      const [gate, saas, hr] = await Promise.all([api.get('/api/auth/gate').catch(() => null), loc ? loadSaasAccount() : null, loc ? loadHrAccess() : null, startSignedIn(me.user, ['shell', 'dashboard'])]);
      if (gate?.require_2fa) return setState({ loading: false, gate: true, session: { user: me.user, locations: me.locations, locationId: loc, saas: null } });
      setState({ loading: false, session: { user: me.user, locations: me.locations, locationId: loc, saas, hr } });
    } catch {
      void loadBranding();
      void loadPublicAppearance();
      // Signed out: this device's choice or the browser's language (Accept-Language) for the login page.
      const [st] = await Promise.all([api.get('/api/auth/status').catch(() => ({ needsSetup: false })), startSignedOut(['login'])]);
      setState({ loading: false, needsSetup: st.needsSetup });
    }
  };
  useEffect(() => {
    if (!location.pathname.startsWith(BASE)) history.replaceState(null, '', BASE);
    void load();
    const out = () => setState({ loading: false, needsSetup: false });
    window.addEventListener('pghl:logout', out);
    return () => window.removeEventListener('pghl:logout', out);
  }, []);

  if (state.loading) return <StartSpinner />;
  // The MCP OAuth consent screen (ChatGPT, Claude.ai, Codex …) lives outside the app shell.
  const consent = route[0] === 'oauth-consent';
  if (!state.session) return <LoginPage needsSetup={!!state.needsSetup} onDone={load} branding={branding} hint={consent ? t('Melde dich an, um eine KI-App mit deinem Konto zu verbinden.') : undefined} />;
  if (state.gate) return <SecurityGate branding={branding} onDone={load} onLogout={async () => (await api.post('/api/auth/logout').catch(() => null), (location.href = BASE))} />;
  const session: Session = {
    ...state.session,
    branding,
    reload: load,
    switchLocation: (id, page) => {
      setLocation(id);
      if (state.session!.user.role !== 'admin') void loadBranding(true);
      setState((s) => ({ ...s, session: { ...s.session!, locationId: id, saas: null, hr: null } }));
      void loadSaasAccount().then((saas) => setState((s) => (s.session?.locationId === id ? { ...s, session: { ...s.session, saas } } : s)));
      void loadHrAccess().then((hr) => setState((s) => (s.session?.locationId === id ? { ...s, session: { ...s.session, hr } } : s)));
      navigate(page ?? (can({ user: state.session!.user }, 'dashboard') ? 'dashboard' : '/app'));
    },
  };
  if (consent)
    return (
      <SessionCtx.Provider value={session}>
        <PageSuspense>
          <OAuthConsent />
        </PageSuspense>
      </SessionCtx.Provider>
    );
  return (
    <SessionCtx.Provider value={session}>
      <Shell session={session}>
        <Page route={route} session={session} />
      </Shell>
    </SessionCtx.Provider>
  );
}

initViewport();
registerPwa();
resumeFocus();
createRoot(document.getElementById('root')!).render(
  <RootBoundary>
    {/* Texts of a language that are still loading (e.g. the login page after signing out in English): the start spinner. */}
    <Suspense fallback={<StartSpinner />}>
      <App />
    </Suspense>
    <Toasts />
    <ConfirmHost />
    <InstallHint />
    <MountFlag />
  </RootBoundary>,
);
