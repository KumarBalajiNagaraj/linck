import { useState } from 'react';
import { can, formatDateTime, formatINR, parseTypedAmount, sitesFor } from '@linck/domain';
import { BREAKDOWN_STATUS_FAMILY } from '@linck/mock';
import { Button, Detail, DetailGrid, IdCell, MoneyCell, Note, QuantityCell, SheetSection, SideSheet } from '@linck/ui';
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { Busy, Field, FIELD_CLASS, FIELD_STYLE, Refusal, StillNeeded } from '../../shell/Field.js';
import type { RecordProblem } from '../../shell/recordApi.js';
import { useApp } from '../../shell/store.js';
import { driverLabel, now, spacedRegistration, useSites, vehicleLabel, vehicleRef } from '../expenses/bills.js';
import {
  changeBody,
  changeDraft,
  changeGaps,
  istMinute,
  reportBody,
  reportDraft,
  reportGaps,
  resolveBody,
  resolveDraft,
  resolveGaps,
  type Breakdown,
  type BreakdownGap,
  type ChangeDraft,
  type ReportDraft,
  type ResolveDraft,
} from './breakdownApi.js';
import { useChangeBreakdown, useReportBreakdown, useResolveBreakdown } from './breakdowns.js';
import { breakdownWords, fleetWords } from './words.js';

/**
 * A BREAKDOWN, LIVE: added, read, corrected, and marked fixed.
 *
 * The demo has no such sheet: its register is the sample one, read only.
 * Live, the fleet manager keeps it — what broke, where, since when, who told
 * them, the workshop, the repair cost — at the sites where they hold
 * `fleet.vehicle.write` (a breakdown is the vehicle's status changing), and
 * the API decides again: a vehicle already down is refused a second
 * breakdown, and a fixed one is closed but for its repair cost, which often
 * arrives after the vehicle is back.
 *
 * The vehicle is typed and kept as its registration; there is no fleet list
 * on the API to pick it from (breakdownApi.ts).
 */

const WRITE = 'fleet.vehicle.write';

/** Words for a refusal about a breakdown, in the reader's language. A vehicle is shown as people write it. */
export function useBreakdownProblem(): (p: RecordProblem) => string {
  const t = useWords(breakdownWords);
  const label = useWords(statusWords).breakdown;
  return (p) =>
    t.problem(p.code === 'vehicle-already-down' ? { ...p, vehicle: spacedRegistration(p.vehicle) } : p, (s) => label[s as keyof typeof label] ?? s);
}

/** `11 hrs`, `3 days` — the figure that goes beside a critical stamp. */
export function downFor(hours: number, f: (typeof fleetWords)['en']): string {
  return hours < 48 ? f.hours(Math.round(hours)) : f.days(Math.round(hours / 24));
}

const gapWords = (gaps: BreakdownGap[], t: (typeof breakdownWords)['en']) => [...new Set(gaps.map((g) => t.needs[g]))];

/** A typed repair cost read back as rupees, or nothing while it is blank or unreadable. */
const rupeesTyped = (typed: string): string | null => {
  const n = typed.trim() ? parseTypedAmount(typed) : null;
  return n === null ? null : formatINR(n);
};

/* ------------------------------------------------------------- add one */

/** Mounted only while open, so each opening starts blank, at now. */
export function ReportBreakdownSheet({ onClose }: { onClose: () => void }) {
  const { persona, siteScope } = useApp();
  const sites = useSites();
  const report = useReportBreakdown();
  const t = useWords(breakdownWords);
  const status = useWords(statusWords).breakdown;
  const say = useBreakdownProblem();
  const writable = sitesFor(
    persona.grants,
    WRITE,
    sites.map((site) => site.id),
  );
  const [draft, setDraft] = useState<ReportDraft>(() => reportDraft(siteScope && writable.includes(siteScope) ? siteScope : (writable[0] ?? ''), now()));
  /** The time the form offered. Left as it is, the API's own now stands. */
  const [offered] = useState(() => draft.reportedAt);
  const [refused, setRefused] = useState<RecordProblem | null>(null);
  const gaps = reportGaps(draft, writable, now());
  const set = <K extends keyof ReportDraft>(key: K, value: ReportDraft[K]) => {
    setRefused(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const typed = vehicleRef(draft.vehicle);
  const siteName = (id: string) => sites.find((site) => site.id === id)?.name ?? '–';

  const save = () => {
    if (gaps.length > 0 || !report) return;
    void report.run(reportBody(draft, offered)).then((no) => {
      setRefused(no);
      if (!no) onClose();
    });
  };

  return (
    <SideSheet
      open
      onClose={onClose}
      width="form"
      title={t.newTitle}
      footer={
        <>
          <Button variant="primary" onClick={save} disabled={gaps.length > 0 || (report?.busy ?? false)}>
            {report?.busy ? t.saving : t.save}
          </Button>
          <Button onClick={onClose}>{t.cancel}</Button>
        </>
      }
    >
      {refused ? <Refusal text={say(refused)} /> : null}
      <SheetSection caption={t.one}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t.col.vehicle} echo={typed ? t.readAs(spacedRegistration(typed)) : null}>
            <input
              value={draft.vehicle}
              onChange={(e) => set('vehicle', e.target.value)}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              className={`${FIELD_CLASS} font-id`}
              style={FIELD_STYLE}
            />
          </Field>
          <Field label={t.vehicleSite}>
            <select value={draft.siteId} onChange={(e) => set('siteId', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE}>
              {writable.includes(draft.siteId) ? null : <option value={draft.siteId}>—</option>}
              {writable.map((id) => (
                <option key={id} value={id}>
                  {siteName(id)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.col.cause}>
            <input value={draft.cause} maxLength={500} onChange={(e) => set('cause', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
          </Field>
          <Field label={t.col.where}>
            <input value={draft.location} maxLength={200} onChange={(e) => set('location', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
          </Field>
          <Field label={t.brokeDown} error={gaps.includes('when') ? t.wrong.when : null}>
            <input
              type="datetime-local"
              value={draft.reportedAt}
              max={istMinute(now())}
              onChange={(e) => set('reportedAt', e.target.value)}
              className={FIELD_CLASS}
              style={FIELD_STYLE}
            />
          </Field>
          <Field label={t.toldBy} hint={t.toldByHint(persona.name)}>
            <input value={draft.reportedBy} maxLength={120} onChange={(e) => set('reportedBy', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
          </Field>
          <Field label={t.col.status}>
            <select value={draft.status} onChange={(e) => set('status', e.target.value as ReportDraft['status'])} className={FIELD_CLASS} style={FIELD_STYLE}>
              <option value="open">{status.open}</option>
              <option value="in_workshop">{status.in_workshop}</option>
            </select>
          </Field>
        </div>
        {gaps.length > 0 ? <StillNeeded text={t.stillNeeded(gapWords(gaps, t))} /> : null}
        {report?.busy ? <Busy text={t.saving} /> : null}
      </SheetSection>
    </SideSheet>
  );
}

/* ------------------------------------------------------- read and change */

type Mode = 'read' | 'change' | 'fix';

/** Mounted per breakdown, so a sheet never carries one breakdown's draft to the next. */
export function BreakdownDetailSheet({ breakdown: b, onClose }: { breakdown: Breakdown; onClose: () => void }) {
  const { persona } = useApp();
  const change = useChangeBreakdown();
  const resolve = useResolveBreakdown();
  const t = useWords(breakdownWords);
  const f = useWords(fleetWords);
  const status = useWords(statusWords).breakdown;
  const say = useBreakdownProblem();
  const mayWrite = change !== null && resolve !== null && can(persona.grants, WRITE, { siteId: b.siteId });
  const fixed = b.status === 'resolved';
  const [mode, setMode] = useState<Mode>('read');
  const [edit, setEdit] = useState<ChangeDraft>(() => changeDraft(b));
  /** The breakdown as it was when the change began: what this person left alone is not sent back over a later change. */
  const [base, setBase] = useState<Breakdown>(b);
  const [fix, setFix] = useState<ResolveDraft>(() => resolveDraft(b, now()));
  const [offered, setOffered] = useState(fix.resolvedAt);
  /** Kept above the breakdown as it now is: a refused move re-reads the register, and it has often moved on. */
  const [refused, setRefused] = useState<RecordProblem | null>(null);
  const busy = (change?.busy ?? false) || (resolve?.busy ?? false);

  const editGaps = mode === 'change' ? changeGaps(base, edit, now()) : [];
  const fixGaps = mode === 'fix' ? resolveGaps(b, fix, now(), offered) : [];
  const gaps = mode === 'change' ? editGaps : fixGaps;

  const start = (next: Mode) => {
    setRefused(null);
    if (next === 'change') {
      setBase(b);
      setEdit(changeDraft(b));
    }
    if (next === 'fix') {
      const draft = resolveDraft(b, now());
      setFix(draft);
      setOffered(draft.resolvedAt);
    }
    setMode(next);
  };

  const save = () => {
    if (gaps.length > 0) return;
    let sent: Promise<RecordProblem | null> | null = null;
    if (mode === 'change' && change) {
      const patch = changeBody(base, edit);
      if (Object.keys(patch).length === 0) {
        setMode('read');
        return;
      }
      sent = change.run({ breakdown: b, patch });
    } else if (mode === 'fix' && resolve) {
      sent = resolve.run({ breakdown: b, body: resolveBody(fix, offered) });
    }
    void sent?.then((no) => {
      setRefused(no);
      // Saved, or moved on meanwhile (fixed by someone else, say): the breakdown
      // as it now is. Any other refusal leaves the form, to put right and try again.
      if (!no || no.code === 'wrong-step' || no.code === 'gone') setMode('read');
    });
  };

  const setE = <K extends keyof ChangeDraft>(key: K, value: ChangeDraft[K]) => {
    setRefused(null);
    setEdit((d) => ({ ...d, [key]: value }));
  };
  const setF = <K extends keyof ResolveDraft>(key: K, value: ResolveDraft[K]) => {
    setRefused(null);
    setFix((d) => ({ ...d, [key]: value }));
  };
  const costWrong = gaps.includes('repairCost') ? t.wrong.repairCost : null;

  return (
    <SideSheet
      open
      onClose={onClose}
      width="form"
      title={vehicleLabel(b.vehicleId) ?? b.vehicleId}
      identifier={b.number}
      status={{ family: BREAKDOWN_STATUS_FAMILY[b.status], label: status[b.status], ...(fixed ? {} : { severity: downFor(b.downtimeHours, f) }) }}
      footer={
        mode === 'read' ? undefined : (
          <>
            <Button variant="primary" onClick={save} disabled={gaps.length > 0 || busy}>
              {busy ? t.saving : mode === 'fix' ? t.markFixed : t.save}
            </Button>
            <Button
              onClick={() => {
                setRefused(null);
                setMode('read');
              }}
            >
              {t.cancel}
            </Button>
          </>
        )
      }
    >
      {refused ? <Refusal text={say(refused)} /> : null}
      {mode === 'change' ? (
        <SheetSection caption={t.changeTitle}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {base.status === 'resolved' ? null : (
              <>
                <Field label={t.col.cause}>
                  <input value={edit.cause} maxLength={500} onChange={(e) => setE('cause', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
                </Field>
                <Field label={t.col.where}>
                  <input value={edit.location} maxLength={200} onChange={(e) => setE('location', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
                </Field>
                <Field label={t.brokeDown} error={gaps.includes('when') ? t.wrong.when : null}>
                  <input
                    type="datetime-local"
                    value={edit.reportedAt}
                    max={istMinute(now())}
                    onChange={(e) => setE('reportedAt', e.target.value)}
                    className={FIELD_CLASS}
                    style={FIELD_STYLE}
                  />
                </Field>
                <Field label={t.toldBy}>
                  <input value={edit.reportedBy} maxLength={120} onChange={(e) => setE('reportedBy', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
                </Field>
                <Field label={t.col.status}>
                  <select value={edit.status} onChange={(e) => setE('status', e.target.value as ChangeDraft['status'])} className={FIELD_CLASS} style={FIELD_STYLE}>
                    <option value="open">{status.open}</option>
                    <option value="in_workshop">{status.in_workshop}</option>
                  </select>
                </Field>
              </>
            )}
            <Field label={t.repairRupees} error={costWrong} echo={!costWrong && rupeesTyped(edit.repairCost) ? t.readAs(rupeesTyped(edit.repairCost)!) : null}>
              <input inputMode="decimal" value={edit.repairCost} onChange={(e) => setE('repairCost', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
          </div>
          {gaps.length > 0 ? <StillNeeded text={t.stillNeeded(gapWords(gaps, t))} /> : null}
          {busy ? <Busy text={t.saving} /> : null}
        </SheetSection>
      ) : mode === 'fix' ? (
        <SheetSection caption={t.fixTitle}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={t.fixedAt}
              error={gaps.includes('fixedAt') ? t.wrong.fixedAt : gaps.includes('fixedBeforeDown') ? t.wrong.fixedBeforeDown : null}
            >
              <input
                type="datetime-local"
                value={fix.resolvedAt}
                min={istMinute(b.reportedAt)}
                max={istMinute(now())}
                onChange={(e) => setF('resolvedAt', e.target.value)}
                className={FIELD_CLASS}
                style={FIELD_STYLE}
              />
            </Field>
            <Field label={t.repairRupees} error={costWrong} echo={!costWrong && rupeesTyped(fix.repairCost) ? t.readAs(rupeesTyped(fix.repairCost)!) : null}>
              <input inputMode="decimal" value={fix.repairCost} onChange={(e) => setF('repairCost', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
          </div>
          {gaps.length > 0 ? <StillNeeded text={t.stillNeeded(gapWords(gaps, t))} /> : null}
          {busy ? <Busy text={t.saving} /> : null}
        </SheetSection>
      ) : (
        <>
          <SheetSection caption={t.one}>
            <DetailGrid>
              <Detail label={t.col.vehicle}>
                <IdCell>{vehicleLabel(b.vehicleId) ?? b.vehicleId}</IdCell>
              </Detail>
              <Detail label={t.col.cause}>{b.cause}</Detail>
              <Detail label={t.col.where}>{b.location}</Detail>
              <Detail label={t.toldBy}>{b.reportedBy}</Detail>
              {b.driverId ? <Detail label={t.col.driver}>{driverLabel(b.driverId)}</Detail> : null}
              <Detail label={t.brokeDown}>{formatDateTime(b.reportedAt)}</Detail>
              {b.resolvedAt ? <Detail label={t.fixedAt}>{formatDateTime(b.resolvedAt)}</Detail> : null}
              <Detail label={t.col.offRoad}>
                <QuantityCell value={b.downtimeHours} decimals={1} uom={t.col.hours} />
              </Detail>
              <Detail label={t.col.repair}>
                <MoneyCell value={b.repairCost} accounting={false} decimals={0} />
              </Detail>
            </DetailGrid>
          </SheetSection>
          {mayWrite ? (
            <div className="flex flex-wrap gap-2 pb-2">
              {fixed ? null : (
                <Button variant="primary" onClick={() => start('fix')}>
                  {t.markFixed}
                </Button>
              )}
              <Button onClick={() => start('change')}>{t.change}</Button>
            </div>
          ) : (
            <Note>{t.cannotChange}</Note>
          )}
        </>
      )}
    </SideSheet>
  );
}
