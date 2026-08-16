# Port Conflict Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make port conflict repair change the launched service's real configuration, while preserving safe ownership boundaries.

**Architecture:** Keep command invocation fixed to declared package scripts. Persist per-entry environment variables, merge them into the spawned session, and use only framework keys with known semantics for automatic port repair. Diagnose the exact listener PID and associate it with a managed entry before stopping it.

**Tech Stack:** Electron 43, React 19, TypeScript 5.9, electron-vite, Node CJS Electron harnesses.

---

### Task 1: Add a failing end-to-end regression harness

**Files:**
- Create: `scripts/fixture/env-port-server.cjs`
- Create: `scripts/verify-m12-port-config.cjs`

- [x] **Step 1: Create an env-driven listener fixture**

```js
const port = Number(process.env.MILE_TEST_PORT)
server.listen(port, '127.0.0.1', () => console.log(`MILE_REAL_PORT=${port}`))
```

- [x] **Step 2: Write the failing harness**

Drive the real Edit Entry dialog, add `MILE_TEST_PORT=39210`, save, start the service, and assert `runtime.port === 39210`. Assert the saved config contains the key/value, the dialog uses a password input for values, and diagnosis/log payloads do not contain the secret.

- [x] **Step 3: Run the harness before production changes**

Run: `npx electron scripts/verify-m12-port-config.cjs`

Expected: FAIL because the current dialog has no environment-variable editor.

### Task 2: Implement environment editing and real port repair

**Files:**
- Modify: `src/renderer/src/components/EditEntryDialog.tsx`
- Modify: `src/renderer/src/components/PortDialog.tsx`
- Modify: `src/renderer/src/lib/useEntryFix.tsx`

- [x] **Step 1: Add editable environment key/value rows**

Keep draft rows in component state, serialize non-empty keys as `Record<string, string>`, mask values with `type="password"`, and disable all rows while the entry is live.

- [x] **Step 2: Replace false port repair**

For `framework === 'next'`, submit one atomic patch:

```ts
{ env: { ...entry.env, PORT: String(port) }, expectedPort: port }
```

For other frameworks, show an explanatory dialog instead of guessing an environment key or appending CLI arguments. Direct users to edit environment variables or their project configuration.

- [x] **Step 3: Run the harness after the UI change**

Run: `npx electron scripts/verify-m12-port-config.cjs`

Expected: PASS with the actual listener on the injected port.

### Task 3: Make managed-holder stopping exact

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/services/EntryService.ts`
- Modify: `src/renderer/src/lib/useEntryFix.tsx`
- Modify: `scripts/verify-m11-dual.cjs`

- [x] **Step 1: Extend the diagnosis holder contract**

Return `entryId?: string` by mapping the verified ownership `sessionId` to the entry runtime; use the scanner PID mapping only as a secondary display fallback.

- [x] **Step 2: Use only that identifier to stop a managed holder**

```ts
if (report.portHolder?.ownership === 'owned' && report.portHolder.entryId) {
  await stop(report.portHolder.entryId)
}
```

Do not infer ownership from a matching runtime port.

- [x] **Step 3: Add and run the dual-bind regression assertion**

Assert each diagnosis identifies the other entry's `entryId`, not merely another PID.

### Task 4: Document and verify

**Files:**
- Modify: `../docs/PRD.md`

- [x] **Step 1: Document the implemented repair policy**

Record that Next uses `PORT`, unknown frameworks are never guessed, variable values are masked and omitted from diagnostics, and port conflicts remain warnings.

- [x] **Step 2: Run validation**

Run: `npm run typecheck`, `npm run build`, `npx electron scripts/verify-m11-dual.cjs`, and `npx electron scripts/verify-m12-port-config.cjs`.
