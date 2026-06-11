/**
 * Minimal structured-logger shape the worker and queue depend on, satisfied by Fastify's
 * pino logger (`app.log`). Declaring our own narrow interface keeps these modules free of a
 * Fastify import and trivially testable with a no-op or capturing stub. `object` first arg
 * matches pino's `(obj, msg)` overload.
 */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}
