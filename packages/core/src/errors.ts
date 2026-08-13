export const ErrorCodes = {
  USAGE: "E_USAGE",
  VALIDATION: "E_VALIDATION",
  NOT_FOUND: "E_NOT_FOUND",
  CONFLICT: "E_CONFLICT",
  PATH_ESCAPE: "E_PATH_ESCAPE",
  LOCK: "E_LOCK",
  GIT: "E_GIT",
  INDEX: "E_INDEX",
  INTERNAL: "E_INTERNAL",
  DISABLED: "E_DISABLED",
  LLM: "E_LLM",
  AUTH: "E_AUTH",
  FORBIDDEN: "E_FORBIDDEN",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class MemoryError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
    this.details = details;
  }
}

export function isUserError(code: ErrorCode): boolean {
  return (
    code === ErrorCodes.USAGE ||
    code === ErrorCodes.VALIDATION ||
    code === ErrorCodes.CONFLICT ||
    code === ErrorCodes.PATH_ESCAPE ||
    code === ErrorCodes.NOT_FOUND ||
    code === ErrorCodes.AUTH ||
    code === ErrorCodes.FORBIDDEN
  );
}
