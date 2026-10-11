# Hikers Integrated Platform — Backend

Backend API for the Hikers Integrated Platform, built with Node.js, Express, TypeScript and MongoDB.

## Tech stack

- **Runtime:** Node.js 22, TypeScript
- **Framework:** Express 4 with Socket.io for real-time features
- **Database:** MongoDB via Mongoose
- **Validation:** Zod (environment variables and request data)
- **Logging:** Winston with daily rotating log files
- **Security:** Helmet, CORS, rate limiting
- **Testing:** Vitest and Supertest

## Prerequisites

- Node.js 22 or later
- npm
- A MongoDB instance, either local or hosted (for example MongoDB Atlas)
- Docker, only if you want to run the app in a container

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your environment file and fill in the values:

   ```bash
   cp .env.example .env
   ```

3. Start the development server:

   ```bash
   npm run dev
   ```

4. Check that the server is running:

   ```bash
   curl http://localhost:5001/health
   ```

   A healthy server responds with:

   ```json
   { "status": "success", "message": "Server is up and running" }
   ```

The server connects to MongoDB before it starts listening. If the connection fails, it logs the error and exits.

## Environment variables

All variables are validated at startup in `src/config/env.ts`. The app will not start if a required variable is missing or invalid.

| Variable       | Required | Default       | Description                                                              |
| -------------- | -------- | ------------- | ------------------------------------------------------------------------ |
| `NODE_ENV`     | No       | `development` | One of `development`, `production` or `test`.                            |
| `PORT`         | No       | `5001`        | Port the HTTP server listens on.                                         |
| `MONGODB_URI`  | Yes      | —             | MongoDB connection string.                                               |
| `CORS_ORIGINS` | No       | any origin    | Comma-separated list of allowed origins, e.g. `https://app.example.com`. |

When you add a new environment variable, add it to the schema in `src/config/env.ts` and to `.env.example`.

## Scripts

| Command                 | What it does                                      |
| ----------------------- | ------------------------------------------------- |
| `npm run dev`           | Starts the dev server with auto-reload (nodemon). |
| `npm run build`         | Compiles TypeScript into `dist/`.                 |
| `npm start`             | Runs the compiled app from `dist/`.               |
| `npm test`              | Runs the test suite once.                         |
| `npm run test:coverage` | Runs tests with a coverage report.                |
| `npm run lint`          | Lints the project with ESLint.                    |
| `npm run format`        | Formats the project with Prettier.                |

## Project structure

```
src/
├── index.ts             # Entry point: connects to MongoDB, starts HTTP + Socket.io server
├── app.ts               # Express app and middleware setup (no side effects, safe to import in tests)
├── bootstrap/           # App setup: CORS, security headers, compression, rate limiting, routes, DB
├── config/              # Environment validation (env.ts) and app config (config.ts)
├── modules/             # Feature modules (routes, controllers, services per feature)
├── database/
│   ├── models/          # Mongoose models
│   └── services/        # Database access helpers
├── middleware/          # App-wide middleware (auth, validation, etc.)
├── services/            # Shared services (mail, payments, third-party APIs)
├── shared/              # Shared enums, error classes and middleware
├── types/               # Custom TypeScript type declarations
├── uploads/             # Local file uploads (ignored by git)
├── utils/               # Logging, global error handler, file upload helpers
└── __tests__/           # Tests
```

## Adding a feature module

1. Create a folder under `src/modules/`, for example `src/modules/trails/`.
2. Add its routes, controller and service files there.
3. Mount the router in `src/bootstrap/routes.ts`, above the global error handler:

   ```ts
   app.use(`/api/v${config.defaults.version}/trails`, trailRoutes);
   ```

All API routes are versioned under `/api/v1`.

## Error handling

Async errors in route handlers are caught automatically by `express-async-errors`, so you can `throw` inside async handlers without `try/catch`. The global error handler returns a consistent JSON shape:

```json
{ "message": "Something went wrong", "success": false, "status": 500 }
```

To return a specific status code, throw an error from `http-errors` (for example `throw createHttpError(404, "Trail not found")`) or an error class with a `statusCode` property, such as `ForbiddenError` in `src/shared/errors/`.

## Logging

Use the shared logger instead of `console.log`:

```ts
import logger from "../utils/logging";

logger.general.info("Hike booked");
logger.errors.error("Payment failed");
```

Logs print to the console and are written to `logs/general/` and `logs/error/`. Log files rotate daily, are kept for 14 days and are ignored by git.

## File uploads

Upload middleware lives in `src/utils/multer/multer.ts`. Files are kept in memory so they can be sent straight to cloud storage.

- `upload` accepts images and documents only: jpg, png, pdf, txt, doc, docx, xls and xlsx.
- `uploadAny` accepts any file type.
- The maximum file size is 5 MB.

To save a file to local disk instead, use `saveFile` from `src/utils/saveFile/saveFile.ts`.

## Real-time (Socket.io)

A Socket.io server is attached to the HTTP server in `src/index.ts` and uses the same CORS origins as the API. Before you add socket handlers, move the `io` instance into its own module so that other files can import it without starting a second server.

## Rate limiting

Each client IP is limited to 100 requests per 15 minutes. Adjust this in `src/bootstrap/rate-limiting.ts`.

## Testing

Tests live in `src/__tests__/` and import the Express app directly, so they do not need a running server or database. Test environment variables are set in `vitest.config.mjs`.

```bash
npm test
```

## Running with Docker

```bash
docker build -t hikers-integrated-platform-api .
docker run -p 5001:5001 --env-file .env hikers-integrated-platform-api
```

The image is a two-stage build. It compiles TypeScript in the first stage and ships only the compiled code and production dependencies.

If MongoDB runs on your host machine, use `host.docker.internal` instead of `localhost` in `MONGODB_URI`.
