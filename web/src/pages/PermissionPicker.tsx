import { api } from '../api';
import { Check, Spinner, useLoad } from '../ui';

/**
 * Which areas a login may use ("Alle Bereiche" or a list) – Settings → Team, Agentur → Kunden/Anmeldung. Its own module, so
 * Einstellungen does not pull the whole Agentur page into its chunk.
 */

export const DEFAULT_CLIENT_PERMS = ['dashboard', 'conversations', 'calendars', 'contacts', 'funnels', 'forms'];

export function PermissionPicker({ value, onChange }: { value: string[] | null; onChange: (v: string[] | null) => void }) {
  const perms = useLoad(() => api.get<Record<string, string>>('/api/permissions'), []);
  if (!perms.data) return <Spinner />;
  const all = value === null;
  return (
    <>
      <Check checked={all} onChange={(v) => onChange(v ? null : DEFAULT_CLIENT_PERMS)} label="Alle Bereiche" />
      {!all && (
        <div className="grid2">
          {Object.entries(perms.data).map(([k, label]) => (
            <Check key={k} checked={value!.includes(k)} onChange={(on) => onChange(on ? [...value!, k] : value!.filter((x) => x !== k))} label={label} />
          ))}
        </div>
      )}
    </>
  );
}
