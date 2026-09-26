import { useMemo, useState } from 'react';
import {
  COMPARED_FIELDS,
  crossCheckDeliveryDocuments,
  DELIVERY_DOC_LABEL,
  DELIVERY_FIELD_LABEL,
  UNCLEAR,
  type DeliveryFieldKey,
  type ExtractedDocument,
  type ExtractedValue,
  type FieldStatus,
  type OverallResult,
} from '@linck/domain';
import { DELIVERY_DOC_SAMPLES } from '@linck/mock';
import type { StatusFamily } from '@linck/tokens';
import { Button, Note, PageHeader, Section, StatusStamp } from '@linck/ui';

/**
 * DELIVERY DOCUMENT CROSS-CHECK.
 *
 * One load, three papers: the crusher's delivery challan, the transporter's
 * material-received challan and the customer's delivery memo. Paste what the
 * OCR read off each — or type it from the paper — and the screen works out
 * which document is which, pulls the fields out and compares them.
 *
 * It is a checker, not a clerk: every value is shown exactly as read beside
 * the form it was compared in, nothing unreadable is guessed, and nothing
 * missing is borrowed from another paper. What it posts is nothing — a human
 * decides what the mismatch means.
 */

interface Slot {
  key: number;
  name: string;
  text: string;
  /** Object URL of an attached photo, for reading the paper alongside the text. */
  photo: string | null;
}

const EMPTY_SLOTS: Slot[] = [1, 2, 3].map((n) => ({ key: n, name: `Document ${n}`, text: '', photo: null }));

const FIELD_STATUS_FAMILY: Record<FieldStatus, StatusFamily> = {
  MATCH: 'ready',
  MISMATCH: 'critical',
  MISSING: 'pending',
  UNCLEAR: 'attention',
};

const OVERALL_FAMILY: Record<OverallResult, StatusFamily> = {
  MATCHED: 'ready',
  'PARTIALLY MATCHED': 'attention',
  MISMATCHED: 'critical',
};

const EXTRACTED_ORDER: DeliveryFieldKey[] = [
  'documentNumber',
  'date',
  'party',
  'vehicle',
  'material',
  'quantity',
  'grossWeight',
  'tareWeight',
  'netWeight',
  'loadingLocation',
  'unloadingLocation',
];

const TEXTAREA_STYLE: React.CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
  borderRadius: 'var(--r-1)',
};

export function DeliveryDocCrossCheck() {
  const [slots, setSlots] = useState<Slot[]>(EMPTY_SLOTS);

  const result = useMemo(() => {
    const filled = slots.filter((s) => s.text.trim() !== '');
    return filled.length === 0 ? null : crossCheckDeliveryDocuments(filled.map((s) => ({ id: s.name, text: s.text })));
  }, [slots]);

  const update = (key: number, patch: Partial<Slot>) => setSlots((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const loadSample = () =>
    setSlots(DELIVERY_DOC_SAMPLES.map((d, i) => ({ key: i + 1, name: d.id, text: d.text, photo: null })));

  const readTextFile = (key: number, file: File) => {
    if (file.type.startsWith('image/')) {
      update(key, { photo: URL.createObjectURL(file), name: file.name });
      return;
    }
    void file.text().then((text) => update(key, { text, name: file.name }));
  };

  return (
    <>
      <PageHeader
        eyebrow="Review queue"
        title="Delivery document cross-check"
        actions={
          <>
            <Button onClick={loadSample}>Load sample load</Button>
            <Button onClick={() => setSlots(EMPTY_SLOTS)}>Clear</Button>
          </>
        }
      />

      <Section caption="One load, up to three papers" title="What each document says">
        <div className="grid grid-cols-1 gap-4 px-6 lg:grid-cols-3">
          {slots.map((slot) => (
            <div key={slot.key} className="flex min-w-0 flex-col gap-2">
              <input
                value={slot.name}
                onChange={(e) => update(slot.key, { name: e.target.value })}
                aria-label="Document name"
                className="h-8 w-full px-2 text-[13px] font-medium"
                style={TEXTAREA_STYLE}
              />
              {slot.photo ? (
                <img src={slot.photo} alt={`Photo of ${slot.name}`} className="max-h-48 w-full object-contain" style={{ borderRadius: 'var(--r-1)' }} />
              ) : null}
              <textarea
                value={slot.text}
                onChange={(e) => update(slot.key, { text: e.target.value })}
                rows={12}
                placeholder="Paste the OCR text of this document, or type it from the paper. Mark anything you cannot read as [illegible]."
                aria-label={`Text of ${slot.name}`}
                className="w-full p-2 font-mono text-[12px] leading-snug"
                style={TEXTAREA_STYLE}
              />
              <label className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                Attach photo or .txt{' '}
                <input
                  type="file"
                  accept="image/*,.txt,text/plain"
                  className="text-[12px]"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) readTextFile(slot.key, file);
                  }}
                />
              </label>
              {result ? <DetectedType doc={result.documents.find((d) => d.id === slot.name)} /> : null}
            </div>
          ))}
        </div>
        <div className="px-6 pt-3">
          <Note>
            A photo is attached for reading alongside the text; the text is what gets compared. Reading the photo
            itself happens in the extraction service before a load reaches this screen.
          </Note>
        </div>
      </Section>

      {result ? (
        <>
          <Section caption="Cross-verification" title="Do the papers describe the same load?">
            <div className="flex flex-col gap-3 px-6">
              <div className="flex flex-wrap items-center gap-3">
                <StatusStamp status={OVERALL_FAMILY[result.overall]} label={result.overall} />
                <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  {result.documents.length} documents compared
                </span>
              </div>
              {result.explanations.length > 0 ? (
                <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px]" style={{ color: 'var(--text-primary)' }}>
                  {result.explanations.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              ) : (
                <Note>Every compared field agrees, and every net weight adds up.</Note>
              )}
            </div>
          </Section>

          <Section caption="Field by field" title="Comparison">
            <div className="overflow-x-auto px-6">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-strong)' }}>
                    <Th>Field</Th>
                    {result.documents.map((d) => (
                      <Th key={d.id}>{d.type === 'unknown' ? d.id : DELIVERY_DOC_LABEL[d.type]}</Th>
                    ))}
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {result.comparisons.map((c) => (
                    <tr key={c.field} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <Td>{DELIVERY_FIELD_LABEL[c.field]}</Td>
                      {c.values.map((v) => (
                        <Td key={v.docId}>
                          <ValueCell value={v.value} highlight={c.status === 'MISMATCH'} />
                        </Td>
                      ))}
                      <Td>
                        <StatusStamp status={FIELD_STATUS_FAMILY[c.status]} label={c.status} />
                      </Td>
                    </tr>
                  ))}
                  <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <Td>Net = gross − tare</Td>
                    {result.documents.map((d) => (
                      <Td key={d.id}>
                        <span className="flex flex-col gap-1">
                          <StatusStamp
                            status={d.netCheck.status === 'OK' ? 'ready' : d.netCheck.status === 'MISMATCH' ? 'critical' : d.netCheck.implausible ? 'attention' : 'pending'}
                            label={d.netCheck.status === 'NOT_POSSIBLE' ? 'Not possible' : d.netCheck.status}
                          />
                          <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                            {d.netCheck.explanation}
                          </span>
                        </span>
                      </Td>
                    ))}
                    <Td />
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>

          <Section caption="Everything read off each paper" title="Extracted fields">
            <div className="grid grid-cols-1 gap-6 px-6 xl:grid-cols-3">
              {result.documents.map((d) => (
                <ExtractedTable key={d.id} doc={d} />
              ))}
            </div>
          </Section>
        </>
      ) : (
        <div className="px-6 pt-6">
          <Note>Paste at least one document to see what is read from it; two or more to cross-check them.</Note>
        </div>
      )}
      <div className="h-10" />
    </>
  );
}

function DetectedType({ doc }: { doc: ExtractedDocument | undefined }) {
  if (!doc) return null;
  return (
    <span className="flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
      <StatusStamp
        status={doc.type === 'unknown' ? 'attention' : 'active'}
        label={DELIVERY_DOC_LABEL[doc.type]}
        {...(doc.type === 'unknown' ? {} : { severity: `${Math.round(doc.typeConfidence * 100)}%` })}
      />
      {doc.typeEvidence.length > 0 ? <span>because it says: {doc.typeEvidence.join(', ')}</span> : null}
    </span>
  );
}

function ValueCell({ value, highlight }: { value: ExtractedValue | null; highlight: boolean }) {
  if (!value) {
    return (
      <span className="italic" style={{ color: 'var(--text-tertiary)' }}>
        not on this paper
      </span>
    );
  }
  const isUnclear = value.normalized === UNCLEAR;
  return (
    <span className="flex flex-col">
      <span
        style={{
          color: isUnclear ? 'var(--status-attention)' : highlight ? 'var(--status-critical)' : 'var(--text-primary)',
          fontWeight: highlight ? 600 : undefined,
        }}
      >
        {value.raw}
      </span>
      <span className="font-id text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        {value.normalized}
      </span>
    </span>
  );
}

function ExtractedTable({ doc }: { doc: ExtractedDocument }) {
  return (
    <div className="min-w-0">
      <p className="pb-1 text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
        {doc.id}{' '}
        <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>
          — {DELIVERY_DOC_LABEL[doc.type]}
        </span>
      </p>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-strong)' }}>
            <Th>Field</Th>
            <Th>As read</Th>
            <Th>Compared as</Th>
          </tr>
        </thead>
        <tbody>
          {EXTRACTED_ORDER.map((key) => {
            const v = doc.fields[key];
            return (
              <tr key={key} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <Td>{DELIVERY_FIELD_LABEL[key]}</Td>
                <Td>{v ? v.raw : <span style={{ color: 'var(--text-tertiary)' }}>–</span>}</Td>
                <Td>
                  {v ? (
                    <span className="flex flex-col">
                      <span
                        className="font-id"
                        style={{ color: v.normalized === UNCLEAR ? 'var(--status-attention)' : 'var(--text-primary)' }}
                      >
                        {v.normalized}
                      </span>
                      {v.note ? (
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                          {v.note}
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-tertiary)' }}>{COMPARED_FIELDS.includes(key) ? 'MISSING' : '–'}</span>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="py-2 pr-4 text-left text-[11px] font-medium uppercase tracking-[0.06em]" style={{ color: 'var(--text-tertiary)' }}>
      {children}
    </th>
  );
}

function Td({ children }: { children?: React.ReactNode }) {
  return <td className="py-2 pr-4 align-top">{children}</td>;
}
