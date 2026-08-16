# Custom Service Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users choose a safe, persisted Phosphor icon for each service card, including while the service is running.

**Architecture:** Store only a small shared union of approved icon identifiers on `LaunchEntry`; an absent value means the existing framework glyph remains automatic. The renderer maps those identifiers to Phosphor components, while `EntryService` validates every IPC edit and configuration migration removes values that could not have been created by the UI.

**Tech Stack:** Electron 43, React 19, TypeScript 5.9, Phosphor React icons, Node CJS Electron harnesses.

---

### Task 1: Add a failing end-to-end regression harness

**Files:**
- Create: `scripts/verify-m13-icon.cjs`
- Reuse: `scripts/fixture/env-port-server.cjs`

- [x] **Step 1: Seed one service and one task in an isolated app-data directory**

Use the existing `scripts/fixture` project, temporarily declare the `envport` package script, and set `MILE_TEST_PORT` to a free port on the service entry. Restore `scripts/fixture/package.json` and remove the sandbox during teardown.

- [x] **Step 2: Drive the real editing workflow and assert the missing behavior**

The harness must open the launchpad, open the service editor, require `[data-icon-picker]`, choose `rocket` through `[data-icon-option="rocket"]`, save, and assert all of the following:

```js
entry.icon === 'rocket'
JSON.parse(readFileSync(CONFIG, 'utf8')).entries[0].icon === 'rocket'
document.querySelector('[data-entry-id="icons"] [data-card-icon="rocket"] svg')
```

It must also assert that the task editor has no picker, reject `window.mile.entry.edit('icons', { icon: 'untrusted' })`, start the service, change the icon to `cloud` while `runtime.status === 'running'`, then select automatic and verify the persisted icon is absent.

- [x] **Step 3: Run the harness before production changes**

Run: `npm run build && npx electron scripts/verify-m13-icon.cjs`

Expected: FAIL because `EditEntryDialog` has no icon picker or card icon marker.

### Task 2: Define the persisted icon contract and migration

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/services/ConfigStore.ts`

- [x] **Step 1: Add one shared allow-list**

Declare a const tuple and type before `LaunchEntry`:

```ts
export const SERVICE_ICON_IDS = ['rocket', 'globe', 'database', 'terminal', 'code', 'cube', 'cloud', 'gear'] as const
export type ServiceIcon = (typeof SERVICE_ICON_IDS)[number]
```

Add `icon?: ServiceIcon` to `LaunchEntry`, add `icon` to `EditableEntryField`, and make `EntryEdit` accept `icon?: ServiceIcon | null` so `null` is the IPC-safe explicit reset value.

- [x] **Step 2: Migrate existing configuration deliberately**

Bump `CONFIG_VERSION` to `4`. In the `from < 4` branch, remove any historic `icon` property from migrated entries because versions 1-3 never supported this field. Existing cards therefore retain their automatic framework glyph after upgrade.

### Task 3: Validate icon edits in the main process

**Files:**
- Modify: `src/main/services/EntryService.ts`

- [x] **Step 1: Add `icon` to the editable white-list and labels**

Create a `Set<ServiceIcon>` from `SERVICE_ICON_IDS` and include `icon` in `EDITABLE` and `FIELD_LABEL`.

- [x] **Step 2: Sanitize the value and preserve runtime safety**

Add a `case 'icon'` to `sanitizeEdit`:

```ts
const nextKind = out.kind ?? target.kind
if (value === null) {
  out.icon = undefined
  break
}
if (nextKind !== 'service' || typeof value !== 'string' || !SERVICE_ICONS.has(value as ServiceIcon)) {
  throw new Error('...')
}
out.icon = value as ServiceIcon
```

When a service changes into a task, clear `out.icon` along with `out.expectedPort`. Do not add `icon` to `IDENTITY_FIELDS`, so presentation-only edits remain available for live services.

### Task 4: Render and select the approved icons

**Files:**
- Modify: `src/renderer/src/lib/entryMeta.ts`
- Modify: `src/renderer/src/components/EditEntryDialog.tsx`
- Modify: `src/renderer/src/components/EntryCard.tsx`

- [x] **Step 1: Map identifiers to Phosphor icons in the renderer**

Export `SERVICE_ICON_META: Record<ServiceIcon, { label: string; icon: Icon }>` using `RocketLaunch`, `Globe`, `Database`, `Terminal`, `Code`, `Cube`, `Cloud`, and `GearSix`.

- [x] **Step 2: Add the service-only icon picker**

Keep an `icon` draft initialized from `entry.icon`. Under `kind === 'service'`, render an eight-column, labelled button group with an automatic option. Each button uses `data-icon-option`, a visible selected state, a tooltip, and its Phosphor icon. The picker is not disabled when live; save `icon: icon ?? null`.

- [x] **Step 3: Prefer the custom icon on the card**

Replace the direct framework glyph call with a small helper that renders the selected `SERVICE_ICON_META` component for services, otherwise keeps `FrameworkGlyph`. Mark the icon tile with `data-card-icon={entry.icon ?? 'auto'}` so behavior remains inspectable by the real UI harness.

### Task 5: Document and verify

**Files:**
- Modify: `../docs/PRD.md`

- [x] **Step 1: Record the feature policy**

Document that only the predefined icon set is persisted, automatic preserves framework detection, icons are service-only, and changing an icon does not restart a service.

- [x] **Step 2: Verify cleanly**

Run: `npm run typecheck`, `npm run build`, `npx electron scripts/verify-m13-icon.cjs`, and `npx electron scripts/verify-m12-port-config.cjs`.

Expected: all commands exit `0`; the icon harness proves persistence, renderer output, invalid-value rejection, live edit behavior, and reset behavior.
