type FunctionErrorLike = {
  name?: string;
  message?: string;
  context?: Response;
};

export async function describeFunctionError(error: unknown, functionName: string, fallback: string): Promise<string> {
  if (!error) return fallback;
  const err = error as FunctionErrorLike;
  if (err.name === 'FunctionsFetchError') {
    const origin = typeof window === 'undefined' ? 'the site origin' : window.location.origin;
    return `Unable to reach ${functionName}. Confirm the function is deployed; if the browser blocked it, set ALLOWED_ORIGIN to include ${origin}.`;
  }
  if (err.context) {
    try {
      const body = await err.context.clone().json() as { error?: unknown };
      if (typeof body?.error === 'string' && body.error.trim()) return body.error;
    } catch {}
    if (err.name === 'FunctionsRelayError') return `${functionName} relay failed (HTTP ${err.context.status}). Check the function logs.`;
    return `${functionName} failed (HTTP ${err.context.status}${err.context.statusText ? ` ${err.context.statusText}` : ''}).`;
  }
  return err.message || fallback;
}
