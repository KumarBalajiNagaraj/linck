/**
 * GSTIN — the 15-character GST registration number.
 *
 *   state code (2 digits) + PAN (10) + entity number (1) + 'Z' + check (1)
 *
 * The check character is computed with the same base-36 weighted sum the GST
 * portal uses, and the same one `apps/api/scripts/seed_dev.py` seeds with, so
 * a GSTIN that passes here passes the e-way bill and e-invoice portals' first
 * check too.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Shape only: 2 digits, a PAN (5 letters, 4 digits, 1 letter), entity, Z, check. */
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** The check character for the first 14 characters of a GSTIN. */
export function gstinCheckCharacter(first14: string): string {
  let total = 0;
  for (let i = 0; i < first14.length; i++) {
    const value = ALPHABET.indexOf(first14[i]!.toUpperCase());
    if (value < 0) throw new Error(`Not a GSTIN character: ${first14[i]}`);
    const product = value * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return ALPHABET[(36 - (total % 36)) % 36]!;
}

/** A checksum-valid GSTIN from its parts. */
export function buildGstin(stateCode: string, pan: string, entityNumber = 1): string {
  const body = `${stateCode}${pan.toUpperCase()}${entityNumber.toString(36).toUpperCase()}Z`;
  return body + gstinCheckCharacter(body);
}

/** Right shape AND the right check character. */
export function isValidGstin(value: string): boolean {
  const v = value.trim().toUpperCase();
  return GSTIN_PATTERN.test(v) && gstinCheckCharacter(v.slice(0, 14)) === v[14];
}
