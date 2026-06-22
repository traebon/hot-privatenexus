# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PrivateNexus is a private infrastructure control plane dashboard. It is a containerized, two-service application:
- **Frontend**: React 18 + Vite + Tailwind CSS (port 5173)
- **Backend**: Express.js REST API (port 3001)

The backend currently returns mock/static data. Real infrastructure hooks are planned for future development.

## Development Commands

### Frontend
```bash
cd app/frontend
npm install
npm run dev        # Dev server on 0.0.0.0:5173 with HMR
npm run build      # Production build
npm run preview    # Serve production build locally
```

### Backend
```bash
cd app/backend
npm install
npm start          # Express server on port 3001 (configurable via PORT env var)
```

### Docker (full stack)
```bash
# From repo root — requires .env with port vars
cd compose
docker compose up --build
docker compose down
```

The install script at `scripts/install.sh` handles first-time Docker setup interactively (requires sudo).

## Environment Variables

Frontend reads `VITE_API_URL` (falls back to `http://127.0.0.1:3001`). Set it in `app/frontend/.env`:
```
VITE_API_URL=http://<host>:3001
```

Root `.env.example` documents compose-level vars (`PRIVATENEXUS_FRONTEND_PORT`, `PRIVATENEXUS_BACKEND_PORT`, `PRIVATENEXUS_INSTALL_DIR`, `PRIVATENEXUS_VERSION`).

## Architecture

### Frontend
- Entry: `app/frontend/src/main.jsx` → `App.jsx` → `PrivateNexusV1Mockup.jsx`
- All UI lives in `PrivateNexusV1Mockup.jsx` (~570 lines), five boards: **Home**, **Ops**, **Admin**, **Stacks**, **Emergency**
- `API_BASE` resolves `import.meta.env.VITE_API_URL || "http://127.0.0.1:3001"`

#### Component architecture
- **`boardThemes`** — object map (`active`, `ring`, `hover`, `shell`) per board; `theme = boardThemes[activeBoard]` is derived and applied globally to the sidebar, user card, and `renderCards()`
- **`StacksBoard`** — inner function component (self-contained, own state) rendered for the Stacks board; has expandable panels (Create, Import, Lifecycle, Insights, Files) plus per-stack file/doc listing
- **`renderCards(items)`** — shared card renderer used by Ops (service CPU/RAM cards) and Emergency; applies `theme.shell`/`theme.hover` and handles `safe`/`danger`/`neutral` card variants
- **`executeAction()` / `handleAction()`** — `handleAction` gates danger actions through a confirm modal; `executeAction` appends to the log and clears `confirmAction`
- Board views (`homeView`, `adminRootView`, `backupPanel`, `networkPanel`) are JSX variables, not render functions

#### Data sources
- **API (live)**: `backupData` and `networkData` fetched via `useEffect` from `/api/admin/backup` and `/api/admin/network`; panels display API values with hardcoded fallbacks
- **Static (hardcoded)**: `allApps` (12 entries with emoji + meta), `recentApps`, `services` (CPU/RAM) — richer than current mock API responses
- **Ops GraphCard**: `buildPoints(data, maxValue)` normalises data arrays to SVG viewBox coords; `graphSeries` provides static time-series data for the four metric cards

### Backend
- Entry: `app/backend/src/server.js` — mounts four route modules under `/api/`
- Routes: `apps.js`, `stacks.js`, `admin.js`, `actions.js` — all return static mock data
- `POST /api/actions/run` accepts `{ action }` and echoes it back in mock mode

### `PrivateNexus/` directory
Contains design documents and iterative UI versions — **not deployed code**:
- `private_nexus_blueprint.md` — full 26-section system design (security model, roles, phased roadmap, data model)
- `private_nexus_install_bundle.md` — snapshot of the repo as a single markdown document for portability
- `PrivateNexus.txt` / `PrivateNexus.jsx` — earlier mockup iterations (simpler, pre-theme-system)
- `private_nexus_v_1_mockup.jsx` — the UI design source that was merged into the deployed component

The deployed `app/frontend/src/PrivateNexusV1Mockup.jsx` is the authoritative, merged version combining the richer UI from `private_nexus_v_1_mockup.jsx` with the corrected `buildPoints()` GraphCard math and API wiring.

### API Surface
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check |
| GET | `/api/apps` | Application catalog |
| GET | `/api/stacks` | Stack status list |
| GET | `/api/admin/backup` | Backup config |
| GET | `/api/admin/network` | Network config |
| POST | `/api/actions/run` | Trigger an action |

### Docker
- `docker/backend.Dockerfile` — node:20-alpine, runs `npm start`
- `docker/frontend.Dockerfile` — multi-stage: Vite build → Nginx. Accepts `VITE_API_BASE` build arg
- `compose/docker-compose.yml` — wires both services; frontend depends on backend
