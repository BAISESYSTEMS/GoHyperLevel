# AI workflow builder (KI-Workflow-Builder)

In **Automationen** the buttons **Mit KI erstellen** (list) and **Mit KI ändern** (editor) turn a plain-language description – "when somebody fills in the contact form, tag them *lead*, send a welcome mail and follow up after two days if no appointment was booked" – into a workflow. The AI works with the **real building blocks** of HyperLevel (the live workflow catalogue) and the ids that exist in your sub-account, its answer is **checked against that catalogue**, and you see a **preview with a list of what is new or changed** before anything is saved.

**The AI never publishes.** A new workflow is created as a **draft** (inactive); a change to an existing workflow is stored as that workflow's **draft** ("Als Entwurf speichern"), which you review and publish yourself in the editor (with versions and the test run).

- [Using it](#using-it)
- [How the answer is checked](#how-the-answer-is-checked)
- [Your own AI provider (BYOK)](#your-own-ai-provider-byok)
- [What is sent](#what-is-sent)
- [API and MCP](#api-and-mcp)
- [Limits and good to know](#limits-and-good-to-know)

## Using it

1. **Automationen → Mit KI erstellen** (or, inside a workflow, **Mit KI ändern**). The dialog tells you if no AI is set up and where to do that.
2. Describe what should happen (up to 4000 characters). The examples in the dialog fill the field with one click. When changing a workflow, describe the change only – "wait three days instead of two and send an SMS first".
3. **Entwurf erstellen.** It takes up to a minute. If the draft does not fit the catalogue the AI is told what is wrong and tries again – up to **three attempts** in total.
4. The **preview** shows the AI's summary, **notes** about what you must set up first (a calendar, a WhatsApp template, a pipeline that does not exist yet) and **warnings**; then the trigger and every step, marked *neu*, *geändert* (with before and after), *verschoben* or *entfernt*.
5. **Als Entwurf anlegen / speichern.** A new workflow opens in the editor, inactive. A change goes to the workflow's draft; the editor jumps to *Versionen*, where the draft can be compared and published. If the workflow already had a draft the AI builds on it and the dialog says that it will be replaced.

Unsaved changes in the editor are not part of the request – the AI starts from the saved workflow or its draft.

## How the answer is checked

The AI must answer with one JSON object (`name`, `summary`, `trigger`, `steps`, `settings`, `notes`). HyperLevel then checks it before it is shown or saved:

- the **trigger and every step type** must exist in the catalogue (`/api/workflow-catalog`) – including every action other modules add (payment plans, dunning, quizzes, certificates, buttons …); built-in steps whose settings are not described anywhere (for example *KI-Agent ausführen*, Composio, plugins) are not offered to the AI;
- **required settings** must be present, **choices** must be one of the offered options, numbers must be numbers, times `HH:MM`, dates valid, conditions must use known comparisons;
- **ids** (pipeline, stage, calendar, form, workflow, product, course, link, group) must exist in *your* sub-account and a stage must belong to its pipeline. An invented id is an error and is sent back. If the sub-account has none of something the step needs, the field stays empty and the preview says so ("muss im Editor noch ausgewählt werden") instead of failing;
- unknown settings are removed (with a warning); nesting is limited to 6 levels and a workflow to 80 steps; jumps (*Springe zu*) must point at a step that exists;
- finally the steps go through the same check as saving a workflow by hand (module-specific cleaners included).

Only an answer that passes all of this is shown. After three failed attempts you get the list of problems and nothing is saved. Every attempt is a logged AI call (purpose *KI-Workflow-Builder*, listed in the usage log of the KI-Assistent and counted against its monthly limit).

## Your own AI provider (BYOK)

The builder uses the **KI-Assistent** of the sub-account (*Einstellungen → KI-Assistent*: Claude with your key, or OpenAI) – and, if you use the **KI-Anbieter registry** (*Einstellungen → KI-Anbieter (BYOK)*, or *Agentur → KI-Anbieter* for all sub-accounts), a connection you route to the **use "Workflows"** ("KI-Workflow-Builder"). Resolution order:

1. the routing for the use **Workflows** (sub-account first, then the agency's);
2. otherwise the routing for **quick texts** (use *Text*);
3. otherwise the KI-Assistent's own provider and key.

So you can run the builder on a strong model (say, a flagship reasoning model) while quick replies use a cheaper one. Any text connection works – Anthropic, OpenAI and everything OpenAI-compatible (OpenRouter, Together, Groq, Mistral, Gemini's compatible endpoint, Azure, local models through Ollama or LM Studio). The dialog shows which provider and model is used. The **Denkstufe** (reasoning effort) of *quick texts* applies; a higher level gives better workflows and costs more tokens.

The AI is asked for JSON in the prompt and the object is cut out of the reply (code fences and chatter are fine); no provider-specific schema mode is needed, which keeps every provider usable.

## What is sent

To the AI provider you chose: your description, the workflow catalogue (types, labels, settings – the same for everybody), the **names and ids** of your pipelines (with stages), calendars, forms, workflows, products, courses, community groups, trigger links, team members, existing tags and custom fields, the sub-account name and time zone – and, when changing, the workflow's current JSON. **No contact data, no messages, no invoices and no secrets** are sent. If your texts in a workflow contain personal data, they are part of the workflow JSON and go along when you change that workflow.

The context follows your rights: what the signed-in person may not read (for example courses without the area *Kurse*) is left out and ids from it are not checked.

## API and MCP

Area `workflows`:

| Route | |
| --- | --- |
| `GET /api/workflow-ai/status` | `{ready, reason, provider: {label, model, byok}, examples, limits}` |
| `POST /api/workflow-ai/generate` | `{prompt, workflow_id?}` → `{run_id, mode: create\|edit, workflow, diff, summary, notes, warnings, attempts, model, base}`; `422` with the problems after three failed attempts, `409` when the AI is off, has no key or the budget is used up, `429` after 20 requests per hour per sub-account. |
| `POST /api/workflow-ai/runs/:id/apply` | Saves the proposal: a new workflow with status `draft`, or the draft of `workflow_id`. Returns `{workflow_id, mode, replaced_draft}`. A proposal is applied once. |
| `GET /api/workflow-ai/runs`, `GET …/runs/:id` | History (prompt, outcome, summary) and the stored proposal. Kept 30 days. |

**MCP tool `ghl_workflow_generate`:** `{location_id, prompt, workflow_id?, apply?}` – returns the proposal; with `apply: true` it is saved as a draft (never published). The agent's safety classification is *read* without `apply`, *write* with it.

## Limits and good to know

- The AI makes mistakes. **Read the preview, run the *Testlauf*, and activate yourself.** The check guarantees that the workflow is *valid*, not that it is *what you meant*.
- It only knows the steps and triggers of this installation – features you have not set up (WhatsApp templates, Stripe, calendars) appear in the notes, not as invented ids.
- Texts to customers are written in German (Du) unless you ask otherwise, with merge fields like `{{contact.first_name|du}}`. Review them – no prices, dates or promises are invented, but check anyway.
- One request is up to three AI calls, each billed by your provider; the monthly limit of the KI-Assistent applies.
- Proposals older than 30 days are deleted; applied workflows are of course kept.
