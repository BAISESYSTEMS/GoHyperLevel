# A2UI: interfaces the AI draws in the chat

HyperLevel speaks [A2UI 1.0](https://a2ui.org), Google's open protocol for agent-driven interfaces. Instead of a wall of text, the AI
describes a small interface as JSON – "these free times as chips, a name field, a button" – and HyperLevel draws it with its own
components. No code from the model runs in the browser, and it looks like the rest of your app or website.

The first use is the **appointment picker**.

## Website chat: tap a time, booked

With *KI-Assistent → Live-Chat-Bot → Termine buchen* switched on ([AI books appointments](booking.md#ai-books-appointments)), the
bot looks up free times when a visitor asks for an appointment. Its answer then carries a picker:

- the free times of the day it looked up (or the next free days) as chips,
- name and e-mail fields, but only when the visitor has not given them yet,
- a **Termin buchen** button.

When the visitor taps a time, the chat asks the server whether it is still free (A2UI 1.0 `callAgentFunction`) and says so under
the chips. The button books through exactly the same rules as the bot (released calendars only, no paid calendars, limits per
contact and hour). The picker then turns into the confirmation; the confirmation message with the links to reschedule and cancel
and the visitor's choice appear in the conversation, so the team sees what happened. A reload shows the booked state, a second
tap books nothing.

## Assistant: free times as a picker

When the HyperLevel Agent looks up free times (`ghl_booking_slots`), its tool card shows the same picker. Tapping a time and
**Diesen Termin nehmen** sends "Bitte buche den Termin am … im Kalender …" as your next message; the agent then books with
`ghl_book_appointment` under its safety level. The model keeps reading the plain result – the picker costs no context.

## For developers

| | |
| --- | --- |
| Renderer | `/a2ui-renderer.js` (`web/public/a2ui-renderer.js`, no dependencies): `HLA2UI.mount(element, messages, {send, callAgent})` → `{apply(messages)}` |
| Components | basic catalog subset: Text (plain text, `**bold**`), Column, Row, List, Card, Divider, Button, TextField, CheckBox, ChoicePicker, DateTimeInput, Image (https only); unknown components draw nothing |
| Server messages | `createSurface` (catalog `https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json`, initial data model), `updateComponents`, `updateDataModel` (JSON Pointer paths), `deleteSurface`, `agentFunctionResponse` |
| Client messages | `action` `{name, surfaceId, sourceComponentId, timestamp, context}`, `callAgentFunction` `{surfaceId, functionCallId, callFunction: {"@call", catalogId, args}}` |
| Website chat | `GET /api/public/chat/:locationId/messages` carries `ui` (the A2UI messages) on bot answers with an interface; `POST /api/public/chat/:locationId/a2ui` `{visitor, message}` → `{messages}` for an action, `{message}` (an `agentFunctionResponse`) for a function call; only the visitor's own surfaces, 20 requests per minute and IP |
| Functions | `checkSlot` (catalog `hyperlevel:booking`, args `{calendar_id, slot: "JJJJ-MM-TTTHH:MM"}`) → `{available, message}`; a ChoicePicker names it in `@metadata.onChangeCall`, the answer lands at `@metadata.resultPath` |
| Assistant | a tool result can carry `ui` in its `tool_result` event (`app.services.a2ui.toolPicker(tool, result)`); the panel draws it with the same renderer |
| Storage | `a2ui_surfaces` (one row per surface: chat message, contact, A2UI messages, status `open`/`done`) |

Code: `server/services/a2ui.ts` (messages, picker), `server/modules/a2ui.ts` (storage, endpoint, booking), `web/src/a2ui/A2uiView.tsx`.

**Not yet:** A2UI for external MCP clients (ChatGPT and Claude show MCP Apps rather than A2UI), more pickers (products, forms,
quotes), the Android app.
