---
name: backend-quality
description: Use when evaluating or improving backend code — API design, service architecture, authentication, validation, database interactions, error handling, observability, and testing. Loaded by the backend-specialist agent.
---

# Backend Quality

Standards and checklist for backend code quality evaluation.

## API design

- RESTful conventions: resources map to URLs, HTTP methods map to actions (`GET /resources`, `POST /resources`, `PUT /resources/:id`, `DELETE /resources/:id`).
- Consistent naming: plural nouns for collections, kebab-case or snake_case consistent across all routes.
- HTTP status codes: use correctly — 200 for success, 201 for created, 204 for deleted, 400 for bad request, 401 for unauthorized, 403 for forbidden, 404 for not found, 409 for conflict, 422 for validation error, 500 for internal error.
- Request/response shapes: consistent envelope format. Paginated responses include `{ data, meta: { total, page, pageSize } }`.
- Versioning: URL prefix (`/v1/`) or header-based. Never break existing clients.

## Service boundaries

- Route handlers: thin. Parse input, call service, format response. No business logic.
- Services: contain business logic. Orchestrate repositories and external calls.
- Repositories/data layer: query logic only. No business rules.
- Dependency injection: services receive their dependencies (repositories, clients) rather than instantiating them. This enables testing.
- No circular dependencies between services.

## Authentication & authorization

- Every protected route has auth middleware or decorator. No exceptions for "internal" routes.
- Authorization checks at the service layer, not just route middleware — avoid confused deputy problems.
- Token validation: verify signature, expiry, issuer, audience at the boundary. Cache public keys with appropriate TTL.
- Rate limiting on authentication endpoints (login, password reset, MFA verification).

## Input validation

- Validate ALL external input: request body, query parameters, URL params, headers, file uploads.
- Use a schema validation library (Zod, Joi, Pydantic, validator). Do not hand-roll validation.
- Reject unexpected fields (strip or throw). Do not silently ignore extra fields that could be injection vectors.
- Size limits on string fields, array lengths, file sizes.

## Database interactions

- No raw SQL string concatenation. Use parameterized queries or an ORM/query builder.
- N+1 detection: verify eager loading for relationships accessed in loops.
- Transactions for multi-step mutations. Roll back on failure.
- Migrations are reversible (have a `down` migration). Never edit existing migrations — create new ones.
- Connection pooling configured for expected concurrency.

## Error handling

- Structured error responses: `{ error: { code, message, details? } }`. Never return raw stack traces.
- Global error handler that catches unhandled exceptions and returns 500 with a generic message.
- Log the full error server-side; return only what the client needs.
- Distinguish between client errors (4xx) and server errors (5xx). Do not return 500 for validation failures.

## Observability

- Structured logging (JSON format). No `console.log` in production code.
- Log levels: `debug` for development detail, `info` for lifecycle events, `warn` for unexpected but handled situations, `error` for failures.
- Request IDs or trace IDs propagated through the request lifecycle and included in logs.
- Health check endpoints (`/health` for load balancers, `/ready` for dependency readiness).
- Metrics for request rate, error rate, latency (p50/p95/p99).

## Testing

- Unit tests for service logic with mocked dependencies.
- Integration tests for API endpoints with real database (or test container).
- Test validation: invalid inputs, missing fields, boundary values, unexpected types.
- Test error cases: service throws, DB connection times out, external API returns 500.
