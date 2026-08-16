# Repository Guidelines

## Project Structure & Module Organization

Mile Terminal is a Windows Electron app for local projects, terminals, ports, and processes. Keep privileged work in `src/main/`: `services/` owns domain behavior and `lib/` contains Windows helpers. `src/preload/` exposes the narrow `window.mile` IPC API. `src/renderer/src/` contains React views, components, Zustand stores, and CSS tokens. Shared IPC names and domain types belong in `src/shared/`. Harnesses and fixture projects live under `scripts/`; icons live in `build/` and `resources/`.

## Build, Test, and Development Commands

- `npm run dev` starts Electron with hot reload.
- `npm run typecheck` runs the separate main-process and renderer TypeScript checks.
- `npm run build` type-checks, then builds production files into `out/`.
- `npm run build:win` creates the NSIS installer in `release/` and needs Node 22 LTS.
- `npm run rebuild` rebuilds the native `node-pty` module after Electron version changes.
- `npx electron scripts/verify-m10.cjs` runs an end-to-end harness; run `npm run build` first.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, single quotes, and no semicolons. Use PascalCase for React components and service files (for example, `EntryService.ts`), camelCase for functions and stores, and descriptive IPC channel names in `src/shared/channels.ts`. Keep the renderer presentation-only; validate inputs and perform filesystem or process actions in the main process.

## Testing Guidelines

This repository intentionally has no unit-test framework; do not add one without agreement. Extend `scripts/verify-*.cjs` when behavior changes. Build first because harnesses load `out/`. Assert measured DOM or process values, not screenshots or fixed delays, and update fixture projects when command behavior changes.

## Security & Configuration

Do not auto-install dependencies or execute detected project code. Commands must use `spawn(file, argsArray)` semantics, and scripts must be declared in the target `package.json`. Never terminate a process based only on its port; revalidate ownership. Keep `runToken` and environment values out of the renderer. Preserve configuration migration and atomic writes under `%APPDATA%/mile-terminal/config.json`.

## Commits & Pull Requests

The Git history contains only the initial CRA commit, so no message convention exists. Use short imperative messages such as `feat(scanner): show watched processes`. Pull requests should explain behavior, list validation results, include UI screenshots, and update `../docs/PRD.md` when product behavior changes.
