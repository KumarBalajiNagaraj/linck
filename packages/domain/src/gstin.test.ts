import { describe, expect, it } from 'vitest';
import { buildGstin, gstinCheckCharacter, isValidGstin } from './gstin.js';

describe('gstin', () => {
  // Reference values produced by apps/api/scripts/seed_dev.py:gstin().
  it('computes the same check character as the backend seed', () => {
    expect(buildGstin('33', 'AABCK4521P', 1)).toBe('33AABCK4521P1ZH');
    expect(buildGstin('33', 'AAKFB7731C', 1)).toBe('33AAKFB7731C1ZS');
    expect(buildGstin('29', 'AKQPM7364L', 2)).toBe('29AKQPM7364L2Z5');
    expect(gstinCheckCharacter('33AABCK4521P1Z')).toBe('H');
  });

  it('rejects a wrong check character and a wrong shape', () => {
    expect(isValidGstin('33AABCK4521P1ZH')).toBe(true);
    expect(isValidGstin('33AABCK4521P1ZR')).toBe(false);
    expect(isValidGstin('33AAAC4660K1Z1')).toBe(false);
  });
});
