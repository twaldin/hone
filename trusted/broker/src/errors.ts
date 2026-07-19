import type { BrokerErrorCode } from "@hone/schema";

/** JSON-RPC numeric codes for the contract's string error codes (server-defined range). */
export const BROKER_ERROR_NUMBER: Record<BrokerErrorCode, number> = {
  BUDGET_EXCEEDED: -32000,
  SANDBOX_NOT_FOUND: -32001,
  PROTECTED_PATH_VIOLATION: -32002,
  HOLDOUT_ACCESS_DENIED: -32003,
  DEPTH_EXCEEDED: -32007,
  RESERVATION_EXCEEDED: -32008,
  CORPUS_UNAVAILABLE: -32009,
  CURSOR_INVALID: -32010,
  NOT_IMPLEMENTED: -32004,
  QUOTA_EXCEEDED: -32005,
  INTERNAL: -32006,
};

export class BrokerError extends Error {
  constructor(
    readonly code: BrokerErrorCode,
    message?: string,
    readonly detail?: unknown,
  ) {
    super(message ?? code);
    this.name = "BrokerError";
  }
}
