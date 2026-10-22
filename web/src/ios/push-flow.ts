import { type NavLike, IOS_PUSH_MIN, atLeast, iosVersion, isIosDevice } from './platform';

/**
 * Where a person is on the way to push messages on this device – pure, so the iPhone/iPad rules are tested
 * (tests/ios-logic.test.ts). On iOS push exists only in the app installed on the home screen (iOS/iPadOS 16.4+), and the
 * permission may only be asked from a tap – so the settings page shows an explicit button for the step that is next.
 */

export type PushStep = 'needs-install' | 'ios-too-old' | 'unsupported' | 'blocked' | 'ready' | 'reconnect' | 'on';

export interface PushEnv {
  nav: NavLike;
  standalone: boolean;
  /** serviceWorker + PushManager + Notification exist. */
  hasPushApi: boolean;
  permission: NotificationPermission | 'unsupported';
  /** This device has a subscription the server knows. */
  subscribed: boolean;
}

export function pushStep(e: PushEnv): PushStep {
  const ios = isIosDevice(e.nav);
  // iOS Safari in a tab has no PushManager at all: that is "install first", not "unsupported".
  if (ios && !e.standalone) return 'needs-install';
  if (ios && !atLeast(iosVersion(e.nav), IOS_PUSH_MIN[0], IOS_PUSH_MIN[1])) return 'ios-too-old';
  if (!e.hasPushApi) return 'unsupported';
  if (e.permission === 'denied') return 'blocked';
  if (e.subscribed) return 'on';
  return e.permission === 'granted' ? 'reconnect' : 'ready';
}

export interface PushCopy {
  title: string;
  text: string;
  /** Label of the button for this step ('' = no button). */
  button: string;
}

export function pushCopy(step: PushStep, ios: boolean): PushCopy {
  switch (step) {
    case 'needs-install':
      return { title: 'Erst zum Home-Bildschirm hinzufügen', text: 'iPhone und iPad schicken Mitteilungen nur an Apps vom Home-Bildschirm: Teilen → „Zum Home-Bildschirm“, die App von dort öffnen und hier „Mitteilungen aktivieren“ tippen.', button: '' };
    case 'ios-too-old':
      return { title: 'Dafür braucht es iOS 16.4 oder neuer', text: 'Mitteilungen von Web-Apps gibt es auf iPhone und iPad ab iOS/iPadOS 16.4. Die App läuft auch ohne – Nachrichten siehst du dann beim Öffnen.', button: '' };
    case 'unsupported':
      return { title: 'Dieser Browser kann das nicht', text: 'Dieser Browser unterstützt keine Push-Mitteilungen. Chrome, Edge, Firefox und Safari (installiert) können es.', button: '' };
    case 'blocked':
      return {
        title: 'Mitteilungen sind blockiert',
        text: ios ? 'Öffne die iOS-Einstellungen → Mitteilungen → diese App und erlaube Mitteilungen. Danach hier erneut öffnen.' : 'Erlaube Mitteilungen in den Website-Einstellungen des Browsers (Schloss-Symbol neben der Adresse).',
        button: '',
      };
    case 'ready':
      return { title: 'Mitteilungen aktivieren', text: 'Neue Nachrichten, Aufgaben und Zahlungen melden sich auf diesem Gerät – auch bei geschlossener App. Auf dem App-Symbol zeigt eine Zahl, was ungelesen ist.', button: 'Mitteilungen aktivieren' };
    case 'reconnect':
      return { title: 'Gerät neu verbinden', text: 'Mitteilungen sind erlaubt, aber dieses Gerät ist bei HyperLevel nicht (mehr) angemeldet – das passiert nach einem Update von iOS oder wenn du dich mit einem anderen Konto angemeldet hast.', button: 'Gerät verbinden' };
    case 'on':
      return { title: 'Mitteilungen sind an', text: 'Dieses Gerät bekommt Mitteilungen. Mit „Test senden“ siehst du, wie sie aussehen.', button: '' };
  }
}
