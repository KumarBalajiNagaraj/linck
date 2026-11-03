import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * THE DRIFT TEST. The Vehicle P&L and trip invoice screens read the demo
 * stores (plStore.ts, invoiceStore.ts) and, live, /vehicle-pl and
 * /vehicle-pl/invoices, in one set of shapes: packages/mock/src/types.ts and
 * the request bodies in plApi.ts and invoiceApi.ts. This holds those shapes
 * to the API's own, apps/api/app/schemas/vehicle_pl.py and party_invoices.py,
 * field for field, the way apps/api/tests/test_sign_in.py holds
 * apps/web/src/auth/session.ts to /me/session: a field either side adds,
 * drops, renames, makes nullable or changes the kind of fails here, before a
 * live screen renders `undefined` or a save is refused for a field the form
 * never sent.
 *
 * Read from the sources, as text, so neither side needs the other built.
 */

const root = new URL('../../../../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), 'utf-8');

/* ----------------------------------------------------------------- python */

type Kind = 'string' | 'number' | 'boolean' | 'array' | 'object';

interface Field {
  kind: Kind;
  nullable: boolean;
  /** Python: the request may leave it out. TypeScript: the field is optional (`?`). */
  optional: boolean;
}

interface PyClass {
  bases: string[];
  own: Map<string, Field>;
}

/** Split `a | b[c | d] | None` at its top level. */
function topLevel(type: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of type) {
    if ('[({<'.includes(ch)) depth += 1;
    if ('])}>'.includes(ch)) depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const snakeToCamel = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** The aliases a schema file defines: `Name = Annotated[str, …]`, `Mode = Literal[…]`, `Number = float | int`. */
function pyAliases(text: string): Map<string, Kind> {
  const out = new Map<string, Kind>();
  for (const m of text.matchAll(/^(\w+) = /gm)) {
    const name = m[1];
    // The right-hand side, to where its brackets close: `Annotated[` may run over several lines.
    let depth = 0;
    let end = m.index + m[0].length;
    for (; end < text.length; end += 1) {
      const ch = text[end]!;
      if ('[('.includes(ch)) depth += 1;
      if ('])'.includes(ch)) depth -= 1;
      if (ch === '\n' && depth === 0) break;
    }
    const value = text.slice(m.index + m[0].length, end).replace(/\s+/g, ' ').trim();
    if (value.startsWith('Literal[')) out.set(name!, 'string');
    else if (value.startsWith('Annotated[')) {
      const inner = topLevel(value.slice('Annotated['.length), ',')[0]!;
      out.set(name!, topLevel(inner, '|').every((t) => t === 'float' || t === 'int') ? 'number' : inner === 'str' ? 'string' : 'object');
    } else if (/^(float|int)( \| (float|int))*$/.test(value)) out.set(name!, 'number');
  }
  return out;
}

const PY_SCALARS: Record<string, Kind> = {
  str: 'string',
  int: 'number',
  float: 'number',
  bool: 'boolean',
  'uuid.UUID': 'string',
  'dt.date': 'string',
  'dt.datetime': 'string',
  date: 'string',
  datetime: 'string',
  AwareDatetime: 'string',
};

function pyKind(part: string, aliases: Map<string, Kind>, classes: Set<string>): Kind {
  if (part.startsWith('list[')) return 'array';
  if (part.startsWith('Literal[')) return 'string';
  const known = PY_SCALARS[part] ?? aliases.get(part);
  if (known) return known;
  if (classes.has(part)) return 'object';
  throw new Error(`a type this test cannot read: ${part}`);
}

function pyClasses(text: string, aliases: Map<string, Kind>, only?: string): Map<string, PyClass> {
  // Docstrings out first: their prose can look like a field.
  const code = text.replace(/"""[\s\S]*?"""/g, '');
  const names = new Set([...code.matchAll(/^class (\w+)\(/gm)].map((m) => m[1]!));
  const out = new Map<string, PyClass>();
  for (const m of code.matchAll(/^class (\w+)\(([^)]*)\):\n((?:[ \t]+.*\n|[ \t]*\n)*)/gm)) {
    if (only && m[1] !== only) continue;
    const own = new Map<string, Field>();
    for (const line of m[3]!.split('\n')) {
      const f = /^ {4}(\w+): (.+?)(?: = (.+))?$/.exec(line);
      if (!f || f[1] === 'model_config') continue;
      const parts = topLevel(f[2]!, '|');
      const kinds = [...new Set(parts.filter((p) => p !== 'None').map((p) => pyKind(p, aliases, names)))];
      if (kinds.length !== 1) throw new Error(`${m[1]}.${f[1]}: one kind expected, read ${kinds.join(', ')}`);
      own.set(snakeToCamel(f[1]!), { kind: kinds[0]!, nullable: parts.includes('None'), optional: f[3] !== undefined });
    }
    out.set(m[1]!, { bases: m[2]!.split(',').map((b) => b.trim()), own });
  }
  return out;
}

/** Every field of a class, its bases' first. */
function pyFields(classes: Map<string, PyClass>, name: string): Map<string, Field> {
  const c = classes.get(name);
  if (!c) return new Map();
  const out = new Map<string, Field>();
  for (const base of c.bases) for (const [k, v] of pyFields(classes, base)) out.set(k, v);
  for (const [k, v] of c.own) out.set(k, v);
  return out;
}

const isInput = (classes: Map<string, PyClass>, name: string): boolean => {
  const c = classes.get(name);
  return !!c && c.bases.some((b) => b === 'CamelIn' || isInput(classes, b));
};

/* ------------------------------------------------------------- typescript */

interface TsInterface {
  extends: string[];
  own: Map<string, { type: string; optional: boolean }>;
}

function tsInterfaces(text: string): Map<string, TsInterface> {
  const out = new Map<string, TsInterface>();
  for (const m of text.matchAll(/^export interface (\w+)(?:<[^{]*?>)?(?: extends ([^{]+))? \{\n([\s\S]*?)^\}/gm)) {
    const own = new Map<string, { type: string; optional: boolean }>();
    for (const f of m[3]!.matchAll(/^ {2}(\w+)(\??): (.+);$/gm)) own.set(f[1]!, { type: f[3]!, optional: f[2] === '?' });
    out.set(m[1]!, { extends: m[2] ? topLevel(m[2], ',') : [], own });
  }
  return out;
}

/** `export type Mode = 'a' | 'b'`: names that are strings. */
const tsStringAliases = (text: string) => new Set([...text.matchAll(/^export type (\w+) =\s*'/gm)].map((m) => m[1]!));

function tsKind(part: string, strings: Set<string>): Kind {
  if (part.endsWith('[]')) return 'array';
  if (part === 'string' || part.startsWith("'") || strings.has(part)) return 'string';
  if (part === 'number') return 'number';
  if (part === 'boolean') return 'boolean';
  return 'object';
}

function tsField(type: string, optional: boolean, strings: Set<string>): Field {
  const parts = topLevel(type, '|');
  const kinds = [...new Set(parts.filter((p) => p !== 'null').map((p) => tsKind(p, strings)))];
  if (kinds.length !== 1) throw new Error(`one kind expected in ${type}`);
  return { kind: kinds[0]!, nullable: parts.includes('null'), optional };
}

/** An inline object type, `{ sheetId: string; sheetNumber: string } | null`, as fields. */
function tsInline(type: string, strings: Set<string>): Map<string, Field> {
  const body = /\{([^}]*)\}/.exec(type);
  if (!body) throw new Error(`no object in ${type}`);
  const out = new Map<string, Field>();
  for (const f of body[1]!.split(';').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\w+)(\??): (.+)$/.exec(f)!;
    out.set(m[1]!, tsField(m[3]!, m[2] === '?', strings));
  }
  return out;
}

/* ----------------------------------------------------------------- reading */

const PY_FILES = ['apps/api/app/schemas/vehicle_pl.py', 'apps/api/app/schemas/party_invoices.py'];
const TS_FILES = [
  'packages/mock/src/types.ts',
  'packages/domain/src/vehicle-pl.ts',
  'packages/domain/src/expense-workflow.ts',
  'apps/web/src/features/vehicle-pl/plApi.ts',
  'apps/web/src/features/vehicle-pl/invoiceApi.ts',
];

const pyCommon = pyAliases(source('apps/api/app/schemas/common.py'));
const py = new Map<string, PyClass>();
for (const file of PY_FILES) {
  const text = source(file);
  for (const [k, v] of pyClasses(text, new Map([...pyCommon, ...pyAliases(text)]))) py.set(k, v);
}
// The one shape vehicle_pl.py borrows: the answer to a photo upload.
for (const [k, v] of pyClasses(source('apps/api/app/schemas/expenses.py'), pyCommon, 'AttachmentOut')) py.set(k, v);

const ts = new Map<string, TsInterface>();
const strings = new Set<string>();
for (const file of TS_FILES) {
  const text = source(file);
  for (const [k, v] of tsInterfaces(text)) ts.set(k, v);
  for (const s of tsStringAliases(text)) strings.add(s);
}

function tsFields(target: string): Map<string, Field> {
  const [name, inline] = target.split('.') as [string, string | undefined];
  const i = ts.get(name);
  if (!i) throw new Error(`no interface ${name}`);
  if (inline) {
    const f = tsAll(name).get(inline);
    if (!f) throw new Error(`no field ${target}`);
    return tsInline(f.type, strings);
  }
  return new Map([...tsAll(name)].map(([k, v]) => [k, tsField(v.type, v.optional, strings)]));
}

function tsAll(name: string): Map<string, { type: string; optional: boolean }> {
  const i = ts.get(name);
  if (!i) return new Map();
  const out = new Map<string, { type: string; optional: boolean }>();
  for (const base of i.extends) for (const [k, v] of tsAll(base.replace(/<.*$/, ''))) out.set(k, v);
  for (const [k, v] of i.own) out.set(k, v);
  return out;
}

/* ------------------------------------------------------------------ pairs */

/** Each API schema, and the web shape that reads or sends it. `X.field`: the inline object type of that field. */
const PAIRS: Record<string, string> = {
  // vehicle_pl.py, requests
  DieselIn: 'PlDieselInput',
  EnRouteIn: 'PlEnRouteInput',
  PurchaseIn: 'PlPurchaseInput',
  SaleIn: 'PlSaleInput',
  PaymentIn: 'PlPaymentInput',
  TripIn: 'PlTripInput',
  SheetIn: 'PlSheetInput',
  CloseIn: 'CloseBody',
  PartyIn: 'PartyBody',
  PartyPatch: 'PartyPatchBody',
  LocationIn: 'LocationBody',
  MaterialIn: 'MaterialBody',
  GstRateBody: 'GstRateBody',
  // vehicle_pl.py, answers
  TripAttachmentOut: 'PlAttachment',
  DieselOut: 'PlDieselOut',
  EnRouteOut: 'PlEnRouteOut',
  PurchaseOut: 'PlPurchaseOut',
  SaleInvoiceOut: 'PlSaleInvoice',
  SaleOut: 'PlSaleOut',
  PaymentOut: 'PlPaymentOut',
  PlOut: 'TripPl',
  LevelCostsOut: 'PlLevelCosts',
  PartyDueOut: 'PlPartyDue',
  TripOut: 'PlTripOut',
  SheetRowOut: 'PlSheetRow',
  SheetOut: 'PlSheetDetail',
  PlTotalsOut: 'PlTotals',
  SheetListOut: 'PlReport',
  TripRowOut: 'PlTripReportRow',
  TripReportOut: 'PlReport',
  VehiclePlOut: 'PlVehicleRow',
  VehicleReportOut: 'PlReport',
  MonthPlOut: 'PlMonthRow',
  MonthReportOut: 'PlReport',
  OutstandingOut: 'PlOutstandingRow',
  OutstandingTotalOut: 'PlOutstandingTotal',
  OutstandingReportOut: 'PlReport',
  LocationOut: 'PlLocation',
  PartyOut: 'PlParty',
  MaterialOut: 'PlMaterial',
  GstRateOut: 'PlGstRate',
  MastersOut: 'PlMasters',
  LinkedSheetOut: 'PlDieselBillOption.linkedSheet',
  DieselBillOut: 'PlDieselBillOption',
  AttachmentOut: 'StoredPhoto',
  // party_invoices.py
  InvoiceIn: 'DraftBody',
  InvoicePatch: 'PlInvoicePatch',
  CancelIn: 'CancelBody',
  MatchIn: 'MatchBody',
  SellerOut: 'PlSeller',
  BuyerOut: 'PlBuyer',
  ShipToOut: 'PlInvoiceDetail.shipTo',
  InvoiceLineOut: 'PlInvoiceLine',
  TaxRowOut: 'PlTaxRow',
  ReceiptOut: 'PlInvoiceReceipt',
  UnmatchedOut: 'PlInvoiceUnmatched',
  ReceiptsOut: 'PlInvoiceReceipts',
  InvoiceRowOut: 'PlInvoiceRow',
  InvoiceOut: 'PlInvoiceDetail',
  InvoiceTotalOut: 'PlInvoiceList.total',
  InvoiceListOut: 'PlInvoiceList',
  InvoiceTripOut: 'PlInvoiceTripRow',
  InvoiceTripsOut: 'TripsAnswer',
};

/** Schemas no screen sends yet, and why. A new schema must be paired above or named here. */
const UNUSED: Record<string, string> = {
  LocationPatch: "no screen corrects a delivery place's address or state yet",
  MaterialPatch: 'no screen corrects or retires a material yet',
  GstRatePatch: 'no screen switches a GST rate off yet',
};

describe('the Vehicle P&L and trip invoice shapes, held to the API', () => {
  it('reads every schema of both files', () => {
    // So a pattern that silently matched nothing cannot pass the rest.
    expect(py.size).toBeGreaterThan(60);
    expect(pyFields(py, 'SheetOut').size).toBeGreaterThan(30);
    expect(tsFields('PlSheetDetail').size).toBe(pyFields(py, 'SheetOut').size);
  });

  it('pairs every schema with the web shape that reads or sends it, or says why none does', () => {
    const named = new Set([...Object.keys(PAIRS), ...Object.keys(UNUSED)]);
    const schemas = [...py.keys()].filter((k) => k !== 'AttachmentOut' || PAIRS[k]);
    expect(schemas.filter((k) => !named.has(k))).toEqual([]);
    expect([...named].filter((k) => !py.has(k))).toEqual([]);
  });

  it.each(Object.entries(PAIRS))('%s has the fields of %s, by name', (schema, web) => {
    expect([...tsFields(web).keys()].sort()).toEqual([...pyFields(py, schema).keys()].sort());
  });

  it.each(Object.entries(PAIRS))('%s and %s agree on each field: its kind, and whether it can be null', (schema, web) => {
    const theirs = pyFields(py, schema);
    const ours = tsFields(web);
    const input = isInput(py, schema);
    for (const [name, f] of theirs) {
      const t = ours.get(name);
      if (!t) continue; // the names test says so
      expect(t.kind, `${schema}.${name}`).toBe(f.kind);
      if (input) {
        // What the page may send as null, the API must take as null; what it may leave out, the API must not need.
        if (t.nullable) expect(f.nullable, `${schema}.${name} is sent as null`).toBe(true);
        if (t.optional) expect(f.optional, `${schema}.${name} may be left out`).toBe(true);
      } else {
        // What the API may answer null, the screens must be ready for, and the other way round.
        expect(t.nullable, `${schema}.${name} null`).toBe(f.nullable);
      }
    }
  });
});
