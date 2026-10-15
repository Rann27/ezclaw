import type { ApiErrorBody } from "@ezclaw/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}
