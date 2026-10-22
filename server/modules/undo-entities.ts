import type { Module } from '../core/app.js';
import { registerUndoEntities } from '../services/undo-entities.js';

/** The records the undo journal knows (contacts, tasks, deals …) and the routes that change them – see services/undo-entities.ts. */
export const undoEntitiesModule: Module = {
  name: 'undo-entities',
  register(app) {
    registerUndoEntities(app);
  },
};
