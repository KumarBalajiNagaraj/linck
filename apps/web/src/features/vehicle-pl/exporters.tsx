import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { strToU8, zipSync } from 'fflate';
import { Button } from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { plWords } from './words.js';

/**
 * One report model, two outputs (LIN-22): a real .xlsx workbook, zipped with
 * fflate (already a dependency: no spreadsheet library), one sheet per report;
 * and a print-ready view the browser prints or saves as PDF.
 *
 * Money stays exact: it is written into the cell as the decimal string the
 * rules gave, which Excel reads as a number, never through a JS float.
 */

export type CellKind = 'text' | 'money' | 'number' | 'pct' | 'date';
export type Cell = string | number | null;

export interface ReportSheet {
  /** The tab's name; cut to Excel's 31 characters and cleaned of what it refuses. */
  name: string;
  title: string;
  subtitle?: string;
  columns: { header: string; kind: CellKind }[];
  rows: Cell[][];
  total?: Cell[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Excel's serial day number for YYYY-MM-DD (1900 system), or null for anything else. */
function serialDay(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return Math.round((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

const STYLE = { text: 0, header: 1, money: 2, number: 3, pct: 4, date: 5, title: 6, totalText: 7, totalMoney: 8, totalNumber: 9, totalPct: 10 } as const;

function cellXml(ref: string, value: Cell, kind: CellKind, total: boolean): string {
  if (value === null || value === '') return '';
  const numeric = kind === 'money' || kind === 'number' || kind === 'pct';
  if (numeric && /^-?\d+(\.\d+)?$/.test(String(value))) {
    const style = total
      ? kind === 'money'
        ? STYLE.totalMoney
        : kind === 'pct'
          ? STYLE.totalPct
          : STYLE.totalNumber
      : STYLE[kind];
    return `<c r="${ref}" s="${style}"><v>${String(value)}</v></c>`;
  }
  if (kind === 'date' && typeof value === 'string') {
    const day = serialDay(value);
    if (day !== null) return `<c r="${ref}" s="${STYLE.date}"><v>${day}</v></c>`;
  }
  const style = total ? STYLE.totalText : STYLE.text;
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${esc(String(value))}</t></is></c>`;
}

function sheetXml(sheet: ReportSheet): string {
  const width = Math.max(1, sheet.columns.length);
  const rows: string[] = [];
  let r = 1;
  const text = (s: string, style: number) => `<c r="A${r}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
  rows.push(`<row r="${r}">${text(sheet.title, STYLE.title)}</row>`);
  r += 1;
  if (sheet.subtitle) {
    rows.push(`<row r="${r}">${text(sheet.subtitle, STYLE.text)}</row>`);
    r += 1;
  }
  const headerRow = r;
  rows.push(
    `<row r="${r}">${sheet.columns.map((c, i) => `<c r="${colName(i)}${r}" t="inlineStr" s="${STYLE.header}"><is><t xml:space="preserve">${esc(c.header)}</t></is></c>`).join('')}</row>`,
  );
  r += 1;
  for (const row of sheet.rows) {
    rows.push(`<row r="${r}">${row.map((v, i) => cellXml(`${colName(i)}${r}`, v, sheet.columns[i]?.kind ?? 'text', false)).join('')}</row>`);
    r += 1;
  }
  if (sheet.total) {
    rows.push(`<row r="${r}">${sheet.total.map((v, i) => cellXml(`${colName(i)}${r}`, v, sheet.columns[i]?.kind ?? 'text', true)).join('')}</row>`);
  }
  const cols = sheet.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.kind === 'text' ? 28 : c.kind === 'date' ? 12 : 15}" customWidth="1"/>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<dimension ref="A1:${colName(width - 1)}${Math.max(r, 1)}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${cols}</cols>` +
    `<sheetData>${rows.join('')}</sheetData>` +
    '</worksheet>'
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="dd-mm-yyyy"/><numFmt numFmtId="166" formatCode="0.00&quot;%&quot;"/></numFmts>' +
  '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="11">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>' +
  '<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>' +
  '<xf numFmtId="166" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** Names Excel accepts: at most 31 characters, none of : \ / ? * [ ], and unique in the book. */
function sheetNames(sheets: readonly ReportSheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((s, i) => {
    let name = s.name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${i + 1}`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** The workbook's bytes: a zip of the SpreadsheetML parts, one worksheet per report. */
export function buildXlsx(sheets: readonly ReportSheet[]): Uint8Array {
  const names = sheetNames(sheets);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(STYLES_XML),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s));
  });
  return zipSync(files, { level: 6 });
}

export function downloadXlsx(fileName: string, sheets: readonly ReportSheet[]): void {
  const blob = new Blob([buildXlsx(sheets) as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** How a cell reads on paper: money with the Indian grouping, a % sign, a date as 06-08-2026. */
function shown(value: Cell, kind: CellKind): string {
  if (value === null || value === '') return '—';
  if ((kind === 'money' || kind === 'number' || kind === 'pct') && /^-?\d+(\.\d+)?$/.test(String(value))) {
    const [whole, frac] = String(value).split('.');
    const negative = whole!.startsWith('-');
    const digits = negative ? whole!.slice(1) : whole!;
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    const grouped = rest ? `${rest},${last3}` : last3;
    const text = `${grouped}${frac !== undefined ? `.${frac}` : ''}`;
    return `${negative ? '−' : ''}${kind === 'money' ? '₹' : ''}${text}${kind === 'pct' ? '%' : ''}`;
  }
  if (kind === 'date' && typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  }
  return String(value);
}

/**
 * The print view: the reports as plain tables, laid over the page while it is
 * open, so "PDF / Print" prints only these (index.css hides the app under
 * `body.pl-printing`). Opens the print dialog once it is on screen.
 */
export function PrintView({ sheets, onClose, printedOn }: { sheets: readonly ReportSheet[]; onClose: () => void; printedOn: string }) {
  const w = useWords(plWords);
  useEffect(() => {
    document.body.classList.add('pl-printing');
    const timer = window.setTimeout(() => window.print(), 250);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('pl-printing');
    };
  }, [onClose]);
  return createPortal(
    <div className="pl-print" role="dialog" aria-modal="true" aria-label={w.print}>
      <div className="pl-print-bar">
        <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          {w.printedOn(printedOn)}
        </span>
        <span className="flex gap-2">
          <Button variant="primary" onClick={() => window.print()}>
            {w.printNow}
          </Button>
          <Button onClick={onClose}>{w.close}</Button>
        </span>
      </div>
      {sheets.map((s) => (
        <section key={s.name} className="pl-print-sheet">
          <h2 className="text-[18px] font-semibold">{s.title}</h2>
          {s.subtitle && <p className="text-[13px]">{s.subtitle}</p>}
          <div className="pl-print-scroll">
            <table>
              <thead>
                <tr>
                  {s.columns.map((c) => (
                    <th key={c.header} className={c.kind === 'text' || c.kind === 'date' ? '' : 'num'}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((v, j) => (
                      <td key={j} className={s.columns[j]?.kind === 'text' || s.columns[j]?.kind === 'date' ? '' : 'num'}>
                        {shown(v, s.columns[j]?.kind ?? 'text')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {s.total && (
                <tfoot>
                  <tr>
                    {s.total.map((v, j) => (
                      <td key={j} className={s.columns[j]?.kind === 'text' || s.columns[j]?.kind === 'date' ? '' : 'num'}>
                        {v === null ? '' : shown(v, s.columns[j]?.kind ?? 'text')}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>
      ))}
    </div>,
    document.body,
  );
}
