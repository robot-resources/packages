/**
 * Strip JSON5 features (comments + trailing commas) to produce valid JSON.
 *
 * Handles single-line comments (//), multi-line comments, and trailing
 * commas before } or ]. Preserves // inside quoted strings (e.g. URLs).
 *
 * Does NOT handle: unquoted keys, hex numbers, or backtick templates.
 * These are valid JSON5 but uncommon in OpenClaw configs.
 */
export function stripJson5(text) {
  const clean = text.replace(
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/\/.*$|\/\*[\s\S]*?\*\//gm,
    (match) => (match.startsWith('"') || match.startsWith("'") ? match : ''),
  );
  return clean.replace(/,\s*([\]}])/g, '$1');
}
