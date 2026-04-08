# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@icure/reporting` is an interactive CLI for querying and reporting on iCure healthcare data. It features a custom Peggy query language supporting entity filters (PAT, SVC, HE, INV, CTC), set operations (union, intersection, subtract, negate), reducer pipelines (count, sum, mean, min, max, select, share), variables with relative date calculations, and export to JSON/XLSX.

## Build & Development Commands

| Command | Purpose |
|---|---|
| `yarn build` | Lint + compile TypeScript to `dist/` |
| `yarn start` | Build and launch the interactive CLI |
| `yarn eslint` | Run ESLint 9 (flat config) on `src/*` |
| `yarn test` | Run Vitest tests |
| `yarn test:watch` | Run Vitest in watch mode |
| `yarn peg` | Regenerate Peggy parser from `grammar/icure-reporting-parser.peggy` to `dist/` |

Package manager is Yarn 4 (Berry) with `node-modules` linker. Node >= 22 required (see `.nvmrc`).

## Architecture

```
icure-reporting.ts   → CLI entry point, readline REPL, command dispatch, variable management, parser init
filters.ts           → Query execution: filter rewriting/composition, iCure API calls, async reducers
xls.ts               → XLSX export (flattens nested objects to spreadsheet rows)
reduceDeep.ts        → Generic deep traversal utilities (forEachDeep, mapDeep)
grammar/*.peggy      → Peggy grammar defining the query DSL
test/                → Vitest tests (reduceDeep, parser)
dist/                → Compiled output (JS, declarations, source maps)
```

**Query execution flow:** User input → Peggy parser → filter tree → `filter()` in filters.ts rewrites/composes filters → iCure API calls → optional reducer pipeline → output (console/JSON/XLSX).

**CLI architecture:** The interactive shell uses `node:readline/promises` (no framework dependencies). Commands are registered in a dispatch map and parsed with a custom quote-aware tokenizer.

## Code Style

- Prettier 3: tabs, 100-char width, single quotes, no semicolons, trailing commas (ES5 default)
- ESLint 9 flat config (`eslint.config.mjs`) with `@typescript-eslint` v8 + Prettier integration
- `@typescript-eslint/no-explicit-any` is disabled
- Pre-commit hook via `pretty-quick --staged`
- TypeScript 5.x strict mode, target ES2022, module Node16

## Key Dependencies

- **@icure/api** (v6) — iCure platform client (patients, contacts, services, health elements, invoices, crypto). Uses the `Api()` factory function. v7+ removed this factory in favor of `IcureApi.initialise()` — upgrading would require rewriting initialization and crypto key management.
- **peggy** — parser generator for the query DSL (successor to PEG.js)
- **date-fns** — date manipulation
- **lodash** — utility functions (flatMap, get, pick, uniqBy, groupBy)
- **xlsx** — Excel export
- **picocolors** — terminal color output

## Notes

- The Peggy parser is generated at runtime from the grammar file (not pre-compiled)
- A minimal file-backed localStorage shim is used for `@icure/api` crypto key storage (stored in `$TMPDIR/.icure-localstorage/`)
- Node 22 native `fetch` and `crypto.webcrypto` are used — no polyfills needed
- All API interactions and reducer operations are async
- The `Api()` call in v6 is async (returns `Promise<Apis>`) — APIs are initialized on `login`