// The `error instanceof Error ? error.message : fallback` pattern, shared -
// use this wherever a caught error just needs a display/log string with no
// further unwrapping. Call sites that need richer behavior (e.g. unwrapping
// a DB driver's nested cause, or a provider-specific error shape - see
// market-data.service.ts's getSafeProviderErrorMessage) should keep their
// own logic rather than being forced through this.
export function getErrorMessage(error: unknown, fallback = "Unknown error"): string {
  return error instanceof Error ? error.message : fallback;
}
