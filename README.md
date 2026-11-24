<p align="center">
  <img src="resources/icon.png" width="96" alt="Quarry Studio icon">
</p>

<h1 align="center">Quarry Studio</h1>

<p align="center">
  A fast, keyboard-first desktop SQL client for MySQL, PostgreSQL, SQL Server and SQLite,<br>
  with several database connections open side by side.
</p>

<p align="center">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-35-47848F?logo=electron&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="Vibe coded" src="https://img.shields.io/badge/vibe-coded-ff69b4">
</p>

> [!NOTE]
> **This project is vibe coded.** It was built almost entirely by prompting an AI coding assistant
> (Claude Code), one feature request at a time. A human described the behaviour they wanted and
> tested the result; the AI wrote the code. Every feature was checked in the running app, but the
> code has not had a line-by-line human review. The SQLite driver gets the most testing. The MySQL,
> PostgreSQL and SQL Server drivers have **not been tested against live servers yet**. Use it on
> production databases with care, and bug reports are welcome.

![Table data with filters](docs/screenshots/table-data.png)

## Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Supported databases](#supported-databases)
- [Install](#install)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Build from source](#build-from-source)
- [Project layout](#project-layout)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

## Features

### Connections

- Keep several connections open at once and switch between them from the left rail (`Ctrl+U` / `Ctrl+Shift+U`, `Alt+1…9`).
- Saved connections have a colour, shown as the background of each connection's badge, and the list is searchable.
- **Import from URL:** paste a URL such as `mysql://user:pass@host:3306/db`, `postgres://…`, `jdbc:…` or `sqlserver://…;database=…` and the form fills itself in.
- Connect over SSL/TLS or through an **SSH tunnel** using a password, private key or SSH agent.
- **Read-only mode** blocks every write on that connection.
- Saved passwords are encrypted with your OS keychain (Electron `safeStorage`).

### Query editor

- A Monaco editor (the editor from VS Code) with **context-aware autocomplete** for keywords, functions, snippets, tables, columns and aliases.
- `Ctrl+Enter` runs the statement under the cursor, or the selection. `Ctrl+Shift+Enter` runs the whole script, with one result tab per statement.
- You can cancel a running query (MySQL, PostgreSQL, SQL Server).
- `Ctrl+Shift+F` formats the SQL. Queries can be saved (`Ctrl+S`), and history is kept automatically.

### Confirmation before UPDATE and DELETE

Before a raw `UPDATE`, `DELETE`, `TRUNCATE` or `DROP` runs, Quarry Studio shows what it is about to do:

- **How many rows it affects**, out of how many in the table.
- A warning when the statement **affects every row** (for example, there is no `WHERE` clause).
- For `UPDATE`: how many rows will **actually change**, and a **before → after** preview of the first rows.
- **Foreign-key effects:** tables that reference the affected rows, the number of child rows involved, and their `ON DELETE` / `ON UPDATE` rules.
- Warnings such as setting a `NOT NULL` column to NULL, writing one value to a unique column on several rows, or changing a primary key.

Delete confirmations are red and update confirmations are light blue. **Cancel** has focus by default. The row count comes from rewriting the statement as a `SELECT COUNT(*)`, so nothing is executed before you confirm.

### Table data

- Paged rows with server-side sorting.
- **Filters:** use the builder, which matches **ALL (AND)** or **ANY (OR)** of its lines, or type a raw `WHERE` clause. Lines with an empty value are ignored. For `IS NULL` / `IS NOT NULL` the value field is disabled.
- **Inline editing** of cells, plus adding, cloning and deleting rows and setting values to NULL. Changes are highlighted and stay pending until you **apply them in one transaction** (`Ctrl+S`), or discard them (`Esc`).
- **Range selection:** drag, `Shift+click` or `Shift+arrows` to select cells. Copy them as TSV, paste a block (a single value fills the whole range), or set them all to NULL. A badge shows the count, sum, average, minimum and maximum.
- **Foreign keys are links:** values in a foreign-key column (marked with a link icon in the header) are clickable. Clicking one opens the referenced table in a new tab, filtered to that row. Composite keys match on all their columns. Select a foreign-key cell and press `Ctrl+Enter` to do the same from the keyboard. To edit a foreign-key cell, double-click beside the value or press `Enter`.
- **Copy as INSERT:** right-click a row to copy it as an `INSERT` statement. With rows ticked or a multi-row cell range selected, it copies all of them ("Copy 3 rows as INSERT"). Query results get it too: a plain single-table `SELECT` uses that table's name, and anything else uses a `table_name` placeholder.
- You can open the same table in several tabs. `Ctrl+Shift+T` reopens a closed tab.
- The **Structure** view shows columns, indexes, foreign keys and the DDL.

### Export

Export query results or whole tables (with your filters applied) as **CSV, JSON, SQL `INSERT`s, Markdown or Excel (.xlsx)**, to a file or the clipboard. Excel files get a bold frozen header, autofilter and sized columns. Numbers and dates are typed correctly, and leading zeros are kept.

### Everything else

- `Ctrl+P` is a command palette for tables, views, saved queries and connections.
- Dark and light themes, and resizable panes.
- Shortcuts work wherever the focus is, and with any keyboard layout (including Arabic).

## Screenshots

| Query editor | Table data with filters |
| --- | --- |
| ![Query editor](docs/screenshots/query-editor.png) | ![Table data](docs/screenshots/table-data.png) |

| Delete confirmation (with cascade) | Update confirmation (before → after) |
| --- | --- |
| ![Delete confirmation](docs/screenshots/delete-confirmation.png) | ![Update confirmation](docs/screenshots/update-confirmation.png) |

## Supported databases

| Database | Driver |
| --- | --- |
| MySQL, MariaDB | `mysql2` |
| PostgreSQL, CockroachDB, Amazon Redshift | `pg` |
| Microsoft SQL Server | `mssql` (tedious) |
| SQLite | `better-sqlite3` |

## Install

Only Linux builds are produced at the moment.

1. Build it (see [Build from source](#build-from-source)). This creates `release/Quarry Studio-1.0.0.AppImage` and an unpacked build.
2. Run the unpacked build directly:

   ```bash
   ./release/linux-unpacked/quarry-studio
   ```

   Or run the AppImage. It needs FUSE 2: on Ubuntu 24.04+, `sudo apt install libfuse2t64`.

   ```bash
   chmod +x "release/Quarry Studio-1.0.0.AppImage"
   "./release/Quarry Studio-1.0.0.AppImage"
   ```

The Electron code is cross-platform, so macOS and Windows builds should work with an `electron-builder` target for them, but they haven't been tried.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+P` | Quick open: connections when none is active, the server's databases when no database is selected yet, otherwise tables, views, saved queries and connections (`Shift+Enter` opens a table's structure, `Ctrl+Enter` opens it in a new tab) |
| `Ctrl+Enter` / `Ctrl+Shift+Enter` | Run the current statement or selection / run all |
| `Ctrl+S` | Save the query in a query tab; apply pending changes in a table tab |
| `Ctrl+Shift+F` | Format SQL |
| `F5` / `Ctrl+R` | Refresh table data |
| `Ctrl+F` | Table tab: jump to the filter (query tab: find in the editor) |
| `Esc` | Table tab, one step per press: leave the filter → discard unapplied edits → clear an active filter → deselect rows |
| `Ctrl+A` | Table tab: select all rows on the page (press again to clear) |
| `Ctrl+C` / `Ctrl+V` | Copy the selected rows or cell range as TSV / paste into a cell range |
| Drag / `Shift+Click` / `Shift+Arrows` | Select a range of cells |
| Double-click a cell | Edit it (the whole value is selected) |
| `Delete` | Mark the ticked rows for deletion (applied with `Ctrl+S`, undone with `Esc`) |
| `Ctrl+D` / `Ctrl+Shift+D` | Add a new row / remove unsaved new rows one per press, bottom-up |
| `Ctrl+L` / `Ctrl+Shift+L` | Add a filter line / remove the focused (or last) line |
| `Ctrl+N` | New connection |
| `Ctrl+T` / `Ctrl+W` | New query tab / close tab |
| `Ctrl+Shift+T` | Reopen the last closed tab (query tabs come back with their SQL) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+Click` / middle-click a table | Open it in a new tab |
| `Ctrl+Enter` on a foreign-key cell | Open the referenced row in a new tab (same as clicking the link) |
| `Ctrl+U` / `Ctrl+Shift+U` | Next / previous connection |
| `Alt+1` … `Alt+9` / `Alt+0` | Jump to connection N / connection manager |
| `Ctrl+Q` | Quit |
| `F12` | Developer tools |

## Build from source

You need **Node.js 20+** and **pnpm 10**. On Linux you also need build tools for the native `better-sqlite3` module (`build-essential`, `python3`).

```bash
git clone https://github.com/AhmedMilad/quarry-studio.git
cd quarry-studio
pnpm install        # also rebuilds better-sqlite3 for Electron
pnpm dev            # run with hot reload
```

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the app in development mode with hot reload |
| `pnpm typecheck` | Type-check the main and renderer code |
| `pnpm build` | Production bundle in `out/` |
| `pnpm dist` | Linux AppImage and unpacked build in `release/` |

> [!TIP]
> VS Code's integrated terminal sets `ELECTRON_RUN_AS_NODE`, which stops Electron from opening a
> window. If the app doesn't start, run `unset ELECTRON_RUN_AS_NODE` first.

## Project layout

```
src/
├── main/                 Electron main process
│   ├── index.ts          window, menu, IPC handlers, sessions, export, destructive-query checks
│   ├── drivers/          one driver per database family, all extending BaseDriver
│   ├── tunnel.ts         SSH tunnels (ssh2)
│   ├── store.ts          saved connections, queries, history, settings (JSON + safeStorage)
│   └── xlsx.ts           Excel export (ExcelJS)
├── preload/              contextBridge: exposes a single `invoke` to the renderer
├── shared/               code used by both sides
│   ├── types.ts          shared types
│   ├── sql.ts            statement splitter, read-only detection
│   ├── destructive.ts    parses UPDATE/DELETE/TRUNCATE/DROP for the confirmation dialog
│   └── export.ts         CSV / JSON / SQL / Markdown / TSV formatters
└── renderer/src/         React UI
    ├── App.tsx           app-wide shortcuts and layout
    ├── store.ts          Zustand store: sessions, tabs, closed-tab history, toasts
    ├── commands.ts       command bus that routes shortcuts to the active tab
    ├── monaco.ts         editor themes and the SQL completion provider
    └── components/       Rail, Sidebar, Workspace, QueryTab, TableTab, DataTable, …
```

## How it works

- **Process split.** The UI never talks to a database. It calls `window.bridge.invoke(channel, …)`. The main process owns the connections and returns `{ ok, data }` or `{ ok: false, error }`.
- **Drivers.** `BaseDriver` implements paging, filtering (parameterised), sorting, transactional apply-changes and export. Each database subclass handles quoting, placeholders, catalogue queries and foreign-key lookups.
- **Shortcuts.** One capture-phase key handler per scope matches on `KeyboardEvent.code`, so shortcuts work with any keyboard layout. It sends commands to the active tab through a small command bus.
- **Confirmations.** `shared/destructive.ts` splits a statement into its target table and `WHERE`/`SET` parts. The main process then runs `SELECT COUNT(*)` and preview queries, never the statement itself.

## Known limitations

- **Testing:** only SQLite has been tested end to end. The MySQL, PostgreSQL and SQL Server code paths, including foreign-key lookups and the count queries in the confirmation dialog, still need testing against real servers.
- **Statement parsing:** the parser for the confirmation dialog handles common `UPDATE`/`DELETE` forms (CTEs, `USING`, `FROM`, `TOP`, `LIMIT`, `RETURNING`/`OUTPUT`). Unusual dialect-specific syntax may get an approximate count or none.
- **Platforms:** packaging is set up for Linux only.

## Contributing

Issues and pull requests are welcome. Since the code is AI-generated, reviews that find bugs or simplify things are especially useful. Before opening a PR, please run:

```bash
pnpm typecheck && pnpm build
```

## License

[MIT](LICENSE)
