# Table & Thyme — project guide

This repository is the React frontend for **Table & Thyme**, a restaurant operations app. Its NestJS API and PostgreSQL/Prisma schema live in the sibling repository `../projects/barefoot-management-backend`.

## Product overview

The app supports restaurant administrators and employees working across front-of-house and preparation stations. Main workflows are:

- Browse and manage menu categories, dishes, modifier groups, and modifier options.
- Build a table order, choose dish modifiers, and send order tickets to the kitchen or bar.
- Monitor live order tickets, prepare them, and mark them ready or served.
- Manage table layouts and availability, room stays and folios, employee profiles and shifts, and restaurant settings.
- View operational and business summaries according to the signed-in role and job permissions.

Prices are displayed in Thai baht (THB). Menu labels and modifier options can have English, Burmese, and Thai text.

## Repositories

### Frontend (this repository)

- React 18, TypeScript, Vite, React Router, Zustand, Tailwind CSS, and Lucide icons.
- API calls go through the Axios client in `src/lib/api.ts`.
- The Vite development server proxies `/api/*` to `http://localhost:3000` and strips `/api` from the forwarded path.
- To use another API origin, set `VITE_API_URL` in `.env.local` (see `.env.example`).

### Backend (sibling repository)

`../projects/barefoot-management-backend` contains the NestJS modules, API validation, Prisma schema, and database migrations. The backend expects `DATABASE_URL` and uses Prisma’s PostgreSQL adapter. Its global validation pipe transforms query values and strips fields not declared in DTOs; when adding a write API field, add it to the applicable DTO as well as the schema/service.

## Frontend layout

- `src/App.tsx` — route tree and authentication/permission boundaries.
- `src/layouts/AppLayout.tsx` — authenticated shell and sidebar.
- `src/pages/` — route-level screens: menu, new order, tables, rooms, kitchen/bar, ready orders, order history, team, account, and analytics.
- `src/components/` — shared UI, dialogs, receipts, modifier controls, and pagination.
- `src/lib/` — API client, domain types, formatting, food translations, and shared utilities.
- `src/stores/authStore.ts` — persisted session and user profile.
- `src/stores/orderStore.ts` — order state, API actions, and live order events.
- `src/stores/uiStore.ts` — persisted device preferences, theme, language, and notifications.

Routes are declared in `src/App.tsx`. `RequireAuth` protects signed-in pages; `RequireJobPermission` checks the employee’s job permissions; administrator-only menu and team routes use an explicit ADMIN role guard. Keep frontend route checks consistent with backend authorization.

## Backend layout

In the sibling backend repository:

- `src/modules/` contains NestJS feature modules for auth, menu, orders, tables, rooms, employees, tasks, analytics, restaurant settings, and technical/health endpoints.
- `src/common/` contains shared decorators, guards, and helpers.
- `src/utils/prisma/` contains the Prisma client service and module.
- `prisma/schema.prisma` is the data model; `prisma/migrations/` records database changes.
- Generated Prisma client files under `prisma/generated/` are generated artifacts. Change the schema and migrations, then regenerate the client; do not edit generated model code by hand.

The Nest bootstrap configures CORS, `/uploads/` static files, global `ValidationPipe({ whitelist: true, transform: true })`, and Swagger at `/api/docs`.

## Data and state conventions

- Use `api` from `src/lib/api.ts`; it handles the API base URL, bearer token, timeout, and expired-session behavior.
- Keep API payload/response types in `src/lib/types.ts` when they are shared. Prefer explicit endpoint types over `any`.
- Authentication state is persisted in browser local storage. UI preferences are device-local in the Zustand `restaurant-ui-preferences` store; restaurant identity is loaded from the backend.
- Order state is shared through `useOrderStore`. It obtains a short-lived token from `/orders/events/token`, then subscribes to `/orders/events` with `EventSource`. The current API event stream is process-local; a multi-instance backend needs a shared event broker.
- Use the shared `money()` formatter for prices so the app consistently renders THB.
- Menu editing stores modifier groups separately and links them to dishes. A modifier option can open a follow-up group. Keep order pricing, validation, and kitchen/bar routing aligned with those relationships.
- The Menu dishes endpoint supports server paging. Shared page metadata/query helpers are in `src/lib/pagination.ts`, and the reusable controls are in `src/components/Pagination.tsx`. Preserve the 10-row request limit and show row-shaped skeletons during page loads.
- Modifier groups support RADIO, CHECKBOX, SLIDER, QUANTITY, and TEXT appearances. The editor preview is interactive; the stored `appearance` field must be accepted by backend create/update DTOs as well as persisted by Prisma.

## Development commands

Run these in the relevant repository.

Frontend (`/home/rizekishimaro/project`):

```bash
npm install
npm run dev
npm run build
npm run preview
```

Backend (`/home/rizekishimaro/projects/barefoot-management-backend`):

```bash
npm install
npm run start:dev
npm run build
npm run test
npm run test:e2e
```

The backend also provides `db:seed` and `db:bootstrap-users`; inspect their scripts before using them against a real database. Prisma schema changes require a migration and regenerated client. Use the project’s configured Prisma version and adapter; do not replace its datasource setup with older Prisma examples.

## Working guidelines

- Read the relevant route, component, store, backend controller/service, DTO, and Prisma model before changing a cross-stack feature.
- For a new API field, follow it through the frontend form/payload, DTO validation, service, Prisma schema/migration, and returned frontend type. With `whitelist: true`, undeclared DTO fields are silently stripped.
- For API changes, preserve existing endpoint behavior unless all callers are updated. Search the frontend for every caller before changing a response shape.
- Keep role and job-permission behavior intact when adding routes or actions.
- Prefer existing UI primitives, Tailwind tokens, and domain helpers over duplicated formatting or styles.
- Do not commit secrets, `.env` files, generated build output, or database contents.
- Build commands are appropriate for validating type and compile changes. Run tests when requested or when the task explicitly requires test coverage.

