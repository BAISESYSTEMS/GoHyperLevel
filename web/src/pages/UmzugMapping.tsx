import { useState } from 'react';
import { Field, Input, Modal, Select } from '../ui';
import { FIELD_TYPE_LABELS, STD_FIELDS, targetLabel } from './umzug-format';

/** Feldzuordnung des Umzugs: jedes Feld der Quelle → Kontaktfeld, eigenes Feld (vorhanden oder neu), Tag, Notiz oder überspringen. */

export interface SourceField {
  ref: string;
  label: string;
  type: string;
  std?: string;
  sample?: string[];
  options?: string[];
  group?: 'standard' | 'custom';
}
export interface CustomField {
  key: string;
  label: string;
  type: string;
}

const NEW = '__new__';

function NewFieldModal({ field, initial, onSave, onClose }: { field: SourceField; initial: { label: string; type: string }; onSave: (v: { label: string; type: string }) => void; onClose: () => void }) {
  const [label, setLabel] = useState(initial.label);
  const [type, setType] = useState(initial.type);
  const ok = label.trim().length > 0;
  return (
    <Modal
      title="Neues eigenes Feld anlegen"
      onClose={onClose}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" disabled={!ok} onClick={() => onSave({ label: label.trim().replace(/:/g, ' ').slice(0, 100), type })} data-tour="um-newfield-save">
            Übernehmen
          </button>
        </>
      }
    >
      <p className="muted small">
        Das Feld „{field.label}“ aus der Quelle bekommt ein neues Kontaktfeld. Es wird beim Import angelegt – schon vorhandene Felder mit gleichem Namen werden wiederverwendet.
      </p>
      <Field label="Bezeichnung in HyperLevel">
        <Input value={label} onChange={setLabel} maxLength={100} autoFocus />
      </Field>
      <Field label="Art des Feldes">
        <Select value={type} onChange={setType} options={FIELD_TYPE_LABELS} />
      </Field>
    </Modal>
  );
}

export function UmzugMapping({ fields, mapping, custom, onChange, disabled }: { fields: SourceField[]; mapping: Record<string, string>; custom: CustomField[]; onChange: (m: Record<string, string>) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState<SourceField | null>(null);
  const set = (ref: string, v: string) => onChange({ ...mapping, [ref]: v });
  const newCount = Object.values(mapping).filter((t) => t.startsWith('new:')).length;
  const skipped = fields.filter((f) => !mapping[f.ref]).length;
  const samples = fields.some((f) => f.sample?.length);
  return (
    <div data-tour="um-mapping">
      <p className="muted small">
        {fields.length} Felder in der Quelle · {newCount} werden als neue eigene Felder angelegt · {skipped} werden übersprungen. Ändere die Zuordnung, wo es nicht passt.
      </p>
      <div className="table-wrap">
        <table className="t um-map">
          <thead>
            <tr>
              <th>Feld in der Quelle</th>
              {samples && <th>Beispiele</th>}
              <th>Wird zu</th>
            </tr>
          </thead>
          <tbody>
            {fields.slice(0, 300).map((f) => {
              const cur = mapping[f.ref] ?? '';
              const isNew = cur.startsWith('new:');
              return (
                <tr key={f.ref}>
                  <td>
                    <strong>{f.label}</strong>
                    {f.group === 'standard' && <span className="muted small"> · Standardfeld</span>}
                  </td>
                  {samples && <td className="muted small um-sample">{(f.sample ?? []).slice(0, 3).join(' · ') || '–'}</td>}
                  <td className="um-target-cell">
                    <select
                      aria-label={`Zuordnung für ${f.label}`}
                      value={isNew ? cur : cur.startsWith('tag:') ? 'tag' : cur}
                      disabled={disabled}
                      onChange={(e) => {
                        if (e.target.value === NEW) setEditing(f);
                        else set(f.ref, e.target.value);
                      }}
                    >
                      <option value="">Überspringen</option>
                      <optgroup label="Standardfelder">
                        {STD_FIELDS.map(([k, l]) => (
                          <option key={k} value={k}>
                            {l}
                          </option>
                        ))}
                      </optgroup>
                      {custom.length > 0 && (
                        <optgroup label="Vorhandene eigene Felder">
                          {custom.map((c) => (
                            <option key={c.key} value={`custom:${c.key}`}>
                              {c.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label="Weitere">
                        <option value="tag">Als Tag übernehmen</option>
                        <option value="note">Als Notiz am Kontakt</option>
                        {isNew && <option value={cur}>{targetLabel(cur, custom)}</option>}
                        <option value={NEW}>Neues eigenes Feld anlegen …</option>
                      </optgroup>
                    </select>
                    {isNew && !disabled && (
                      <button className="btn small ghost" onClick={() => setEditing(f)}>
                        Bearbeiten
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {fields.length > 300 && <p className="muted small">Es werden die ersten 300 Felder angezeigt, die übrigen werden nicht übernommen.</p>}
      {editing && (
        <NewFieldModal
          field={editing}
          initial={(() => {
            const cur = mapping[editing.ref] ?? '';
            if (cur.startsWith('new:')) {
              const [, type, ...label] = cur.split(':');
              return { label: label.join(':'), type };
            }
            return { label: editing.label, type: editing.type };
          })()}
          onClose={() => setEditing(null)}
          onSave={(v) => {
            set(editing.ref, `new:${v.type}:${v.label}`);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
