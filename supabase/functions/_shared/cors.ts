const configuredOrigins = (Deno.env.get("ALLOWED_ORIGIN") ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

function normalizeOrigin(origin: string) {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, "");
  }
}

export function isAllowedOrigin(origin: string) {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  return configuredOrigins.some((allowed) => normalizeOrigin(allowed) === normalized);
}

export function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function rejectOrigin(origin: string) {
  console.error("Rejected Edge Function request origin", {
    origin,
    allowedOriginConfigured: configuredOrigins.length > 0,
  });
  return new Response(JSON.stringify({ error: "Origin not allowed" }), {
    status: 403,
    headers: { "Content-Type": "application/json", "Vary": "Origin" },
  });
}
