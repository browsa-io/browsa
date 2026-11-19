// Tokens in URLs never reach the model: query and fragment parameters with
// a credential-like name (token, key, session, code, signature, ...) are
// shown as "***" in every tool answer. Applied to all text a tool returns.

const SENSITIVE = /^(?:.*[_.-])?(?:token|access_?token|refresh_?token|id_?token|auth|authorization|key|api_?key|apikey|secret|client_?secret|password|passwd|pwd|pass|session|session_?id|sessionid|sid|jsessionid|phpsessid|code|otp|ticket|signature|sig|credential|jwt|assertion|saml_?response|nonce)(?:[_.-].*)?$/i;

// Parameter names that look sensitive but are not secrets.
const SAFE = new Set(["country_code", "countrycode", "zip_code", "zipcode", "postal_code", "postcode", "currency_code", "lang_code", "keyword", "keywords", "keys", "token_type", "key_type"]);

export function isSensitiveParam(name: string): boolean {
  const n = name.toLowerCase();
  if (SAFE.has(n)) return false;
  return SENSITIVE.test(n);
}

// [?&#;] name = value, where value runs to the next separator, quote,
// space, backslash or bracket.
const PARAM = /([?&#;])([A-Za-z0-9_.\-[\]%]{1,64})=([^&#;\s"'<>\\)\]]+)/g;

/** Masks credential-like URL parameters anywhere in a text. */
export function redactUrls(text: string): string {
  if (!text || text.indexOf("=") < 0) return text;
  return text.replace(PARAM, (all, sep: string, name: string, value: string) => {
    let decoded = name;
    try { decoded = decodeURIComponent(name); } catch { /* keep */ }
    if (!isSensitiveParam(decoded.replace(/\[\]$/, ""))) return all;
    if (value === "***") return all;
    return `${sep}${name}=***`;
  });
}
