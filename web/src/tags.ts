import { api } from './api';
import { useLoad } from './ui';

/**
 * The sub-account's tag names, for pickers and filters. Lives apart from pages/Contacts.tsx on purpose:
 * several pages need it, and importing it from the contact page would load that whole page (and
 * everything it uses) whenever one of them is opened.
 */
export function useTags() {
  const { data } = useLoad(() => api.get<any[]>('/api/tags'), []);
  return (data ?? []).map((t) => t.name as string);
}
