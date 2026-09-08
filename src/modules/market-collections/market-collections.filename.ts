// Canonical BSE bulk-import filename normalization. This same algorithm is
// mirrored on the frontend (src/features/admin/lib/bulk-import/derive-
// collection-identity.ts) for instant client-side display before any
// network round trip - this backend copy is the authoritative one actually
// used to resolve/create collections and must stay the source of truth if
// the two ever need reconciling. Real BSE export filenames look like
// "BSE Information Technology [BSE IT].csv" - the bracket suffix is a
// vendor-internal code, used as the stable collection code when present
// (falling back to a slug of the display name otherwise), never stripped
// from a code but never part of the display NAME. The leading "BSE" is
// part of the official collection/index name and is always kept in the
// display name - only the trailing bracket suffix is removed from it.
const TRAILING_BRACKET_PATTERN = /\[([^\]]*)\]\s*\.*\s*$/;

function slugify(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeBseCollectionFilename(filename: string): { name: string; code: string } {
  const basename = filename.split(/[/\\]/).pop() ?? filename;

  let name = basename.replace(/\.csv$/i, "");

  const bracketMatch = name.match(TRAILING_BRACKET_PATTERN);
  const bracketContent = bracketMatch?.[1]?.trim() ?? "";

  name = name.replace(TRAILING_BRACKET_PATTERN, "");
  name = name.replace(/\s+/g, " ");
  name = name.replace(/^[\s.]+|[\s.]+$/g, "");

  const code = bracketContent.length > 0 ? slugify(bracketContent) : slugify(name);

  return { name, code };
}
