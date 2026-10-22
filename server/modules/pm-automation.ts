import type { Module } from '../core/app.js';
import { render } from '../core/template.js';
import { TRIGGERS, runAutomations, scanDueToday, scanOverdue, taskFromTemplate } from '../services/pm-automation.js';
import { team, tzOf, type Actor } from '../services/pm-core.js';
import { createTask, resolveStatus, updateTask, taskRow } from '../services/pm-tasks.js';
import { statusesOf } from '../services/pm-core.js';

/**
 * Wires the planner's rules and scans into the app: task events run the project automations, a scan announces
 * overdue and due-today tasks, and the main workflow engine gets the task triggers plus three actions
 * (create task, move status, assign) for flows that start from a contact.
 */

const WORKFLOW_ACTOR: Actor = { id: null, name: 'Workflow', via: 'workflow' };

export const pmAutomationModule: Module = {
  name: 'pm-automation',
  register(app) {
    for (const trigger of Object.keys(TRIGGERS)) {
      app.events.on(trigger, (e) => {
        runAutomations(app, e.locationId, trigger, e.data);
      });
    }

    let last = 0;
    app.onTick(() => {
      if (Date.now() - last < 4 * 60_000) return;
      last = Date.now();
      scanOverdue(app);
      scanDueToday(app);
    });
    app.services.pmScan = { overdue: (at?: Date) => scanOverdue(app, at), dueToday: (at?: Date) => scanDueToday(app, at) };

    // --- the main workflow engine ------------------------------------------------------------------
    const have = new Set<string>(app.services.workflowTriggers ?? []);
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), ...['task.created', 'task.status_changed', 'task.overdue', 'task.assigned'].filter((t) => !have.has(t))];
    type Filter = (c: Record<string, any>, d: Record<string, any>) => boolean;
    const sameProject: Filter = (c, d) => !c.project_id || c.project_id === d.projectId;
    const filters: Record<string, Filter> = {
      'task.created': sameProject,
      'task.overdue': sameProject,
      'task.assigned': (c, d) => sameProject(c, d) && (!c.user_id || (d.userIds ?? []).includes(c.user_id)),
      'task.status_changed': (c, d) => sameProject(c, d) && (!c.status_id || c.status_id === d.to?.id) && (!c.category || c.category === d.to?.category),
      'task.completed': sameProject,
    };
    app.services.workflowTriggerFilters = { ...(app.services.workflowTriggerFilters ?? {}), ...filters };

    /** The task a flow acts on: the one in the trigger's event, or one named in the step. */
    const target = (run: any, step: any, vars: any) => {
      const id = String(render(String(step.task_id ?? ''), vars) || run.event?.task?.id || '');
      if (!id) throw new Error('Keine Aufgabe im Auslöser – bitte einen Aufgaben-Auslöser verwenden');
      return taskRow(app, run.location_id, id);
    };
    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      pm_create_task: async (run: any, step: any, vars: any) => {
        const tz = tzOf(app, run.location_id);
        const base = taskFromTemplate(app, run.location_id, { title: render(String(step.title ?? ''), vars) || 'Aufgabe', description: render(String(step.description ?? ''), vars), priority: step.priority, due_in_days: step.due_in_days === '' || step.due_in_days === undefined ? undefined : Number(step.due_in_days), subtasks: Array.isArray(step.subtasks) ? step.subtasks.map((s: string) => render(String(s), vars)) : undefined }, tz, { project_id: step.project_id || undefined, contact_id: run.contact_id });
        const assignee = step.assignee && team(app, run.location_id).some((p) => p.id === step.assignee) ? [step.assignee] : undefined;
        const t = createTask(app, run.location_id, { ...base, assignees: assignee }, WORKFLOW_ACTOR);
        return `Aufgabe „${t.title}“ im Projekt ${t.project?.name ?? ''} angelegt`;
      },
      pm_move_task: async (run: any, step: any, vars: any) => {
        const t = target(run, step, vars);
        const to = resolveStatus(statusesOf(app, t.project_id!), step);
        if (!to) throw new Error('Status wählen');
        updateTask(app, run.location_id, t.id, { status_id: to.id }, WORKFLOW_ACTOR);
        return `Status „${to.name}“`;
      },
      pm_assign_task: async (run: any, step: any, vars: any) => {
        const t = target(run, step, vars);
        const u = String(step.user_id ?? '');
        if (!team(app, run.location_id).some((p) => p.id === u)) throw new Error('Person nicht gefunden');
        updateTask(app, run.location_id, t.id, step.mode === 'set' ? { assignees: [u] } : { add_assignees: [u] }, WORKFLOW_ACTOR);
        return 'Zugewiesen';
      },
    };
  },
};
