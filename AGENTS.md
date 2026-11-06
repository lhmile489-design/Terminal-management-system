# Repository Guidelines

## Project Structure & Module Organization

Mile Terminal is a Windows Electron app for local projects, terminals, ports, and processes. Keep privileged work in `src/main/`: `services/` owns domain behavior, `lib/` holds platform-neutral utilities (output text rules, source inference, window state, semver), and `platform/` holds the win32/darwin adaptation layer selected at runtime. `src/preload/` exposes the narrow `window.mile` IPC API. `src/renderer/src/` contains React views, components, Zustand stores, and CSS tokens. Shared IPC names and domain types belong in `src/shared/`. Harnesses and fixture projects live under `scripts/`; icons live in `build/` and `resources/`. The standalone React product website lives in `website/` and does not depend on the Electron runtime.

## Build, Test, and Development Commands

- `npm run dev` starts Electron with hot reload.
- `npm run typecheck` runs the separate main-process and renderer TypeScript checks.
- `npm run build` type-checks, then builds production files into `out/`.
- `npm run build:win` creates the NSIS installer in `release/` and needs Node 22 LTS.
- `npm run rebuild` rebuilds the native `node-pty` module after Electron version changes.
- `npx electron scripts/verify-m10.cjs` runs an end-to-end harness; run `npm run build` first.
- `cd website && npm run dev` starts the independent product website.
- `cd website && npm run build` type-checks the website and builds static files into `website/dist/`; validate it in a browser rather than with the Electron harnesses.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, single quotes, and no semicolons. Use PascalCase for React components and service files (for example, `EntryService.ts`), camelCase for functions and stores, and descriptive IPC channel names in `src/shared/channels.ts`. Keep the renderer presentation-only; validate inputs and perform filesystem or process actions in the main process.

## Testing Guidelines

This repository intentionally has no unit-test framework; do not add one without agreement. Extend `scripts/verify-*.cjs` when behavior changes. Build first because harnesses load `out/`. Assert measured DOM or process values, not screenshots or fixed delays, and update fixture projects when command behavior changes.

## Security & Configuration

Do not auto-install dependencies or execute detected project code. Commands must use `spawn(file, argsArray)` semantics, and scripts must be declared in the target `package.json`. Never terminate a process based only on its port; revalidate ownership. Keep `runToken` and environment values out of the renderer. External links only through `shell:openLocalhost` (port int) or `shell:openProjectLink` (PROJECT_LINKS keys); `shell:openPath` only accepts whitelisted paths. Preserve configuration migration and atomic writes under `%APPDATA%/mile-terminal/config.json`.

## Commits & Pull Requests

The project uses Conventional Commits (`feat(...)`, `fix(...)`, `refactor(...)`, `chore(...)`, `docs:`). Use short imperative messages such as `feat(scanner): show watched processes`. Pull requests should explain behavior, list validation results, include UI screenshots, and update `../docs/PRD.md` when product behavior changes.
