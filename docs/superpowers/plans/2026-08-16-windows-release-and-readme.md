# Windows Release And README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a verified x64 NSIS installer and update the repository introduction so it accurately describes the current Mile Terminal release.

**Architecture:** Keep the existing `electron-builder` configuration and package scripts unchanged unless packaging exposes a concrete defect. Treat `README.md` as the contributor-facing project introduction: describe product scope, current capabilities, local development, verification, and the exact release command/output.

**Tech Stack:** Electron 43, electron-vite 5, electron-builder 26, Node.js, NSIS x64.

---

### Task 1: Establish release prerequisites

**Files:**
- Inspect: `package.json`
- Inspect: `release/`

- [ ] **Step 1: Confirm no development server owns the renderer port**

Run:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue
```

Expected: no listener, or stop only the known development process before packaging so `out/` has one producer.

- [ ] **Step 2: Confirm package command and tool versions**

Run:

```powershell
node --version
npm run build:win
```

Expected: the command type-checks, builds `out/`, and invokes `electron-builder --win` using the existing NSIS x64 target.

### Task 2: Refresh the repository introduction

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the opening product description and launchpad capability**

Add the current service-card behavior: services can have a persisted, predefined icon or automatic framework glyph; the choice is presentation-only and can change while a service runs. Keep the existing safety boundaries: no automatic dependency installation, no arbitrary command construction, and no termination based only on a port.

- [ ] **Step 2: Make development, verification, and Windows distribution actionable**

Document the commands below, naming the installer only after the build has produced it:

```powershell
npm run dev
npm run build
npx electron scripts/verify-m13-icon.cjs
npm run build:win
```

Update the harness count and assertion total from the successful verification output. State that `release/` contains the NSIS installer and its associated blockmap/YAML metadata.

### Task 3: Verify the release artifact and documentation

**Files:**
- Generated: `release/Mile Terminal Setup 0.1.0.exe`
- Generated: `release/latest.yml`

- [ ] **Step 1: Inspect generated artifact metadata**

Run:

```powershell
Get-ChildItem release | Select-Object Name, Length, LastWriteTime
Get-FileHash 'release/Mile Terminal Setup 0.1.0.exe' -Algorithm SHA256
```

Expected: a non-empty installer, blockmap, and YAML update metadata with a recorded SHA-256 digest.

- [ ] **Step 2: Re-run the focused regressions from the packed source state**

Run:

```powershell
npx electron scripts/verify-m13-icon.cjs
npx electron scripts/verify-m12-port-config.cjs
```

Expected: the icon harness reports 34 passed / 0 failed and the port-config harness reports 19 passed / 0 failed.
