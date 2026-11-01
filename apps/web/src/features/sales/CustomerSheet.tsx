import { useState } from 'react';
import { can, formatINR, sitesFor } from '@linck/domain';
import type { Customer } from '@linck/mock';
import { Button, Detail, DetailGrid, IdCell, MoneyCell, Note, SheetSection, SideSheet } from '@linck/ui';
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { Busy, Field, FIELD_CLASS, FIELD_STYLE, Refusal, StillNeeded } from '../../shell/Field.js';
import type { RecordProblem } from '../../shell/recordApi.js';
import { useApp } from '../../shell/store.js';
import { useSites } from '../expenses/bills.js';
import { useAddCustomer, useChangeCustomer } from './customers.js';
import { customerBody, customerDraft, customerGaps, customerPatch, type CustomerDraft } from './salesApi.js';
import { customerWords, salesWords } from './words.js';

/**
 * A CUSTOMER, LIVE: added, read, and changed field by field.
 *
 * The demo has no such sheet: its customers are the sample master, read
 * only. Live, the sales desk adds the customers it sells to and keeps their
 * terms; what is offered is what the API would allow — a customer is added
 * or changed only at a site where this person holds `sales.customer.write`,
 * and moving one to another site needs the key at both — and the API decides
 * again. A GST number already on another customer is the API's to catch.
 */

const WRITE = 'sales.customer.write';

/** Words for a refusal about a customer, in the reader's language. */
export function useCustomerProblem(): (p: RecordProblem) => string {
  const s = useWords(salesWords);
  const order = useWords(statusWords).order;
  return (p) => s.problem(p, 'customer', (st) => order[st as keyof typeof order] ?? st);
}

/**
 * `customer` null is a new one. Mounted only while open, so each opening
 * starts from the record as it is now.
 */
export function CustomerSheet({ customer, onClose }: { customer: Customer | null; onClose: () => void }) {
  const { persona, siteScope } = useApp();
  const sites = useSites();
  const t = useWords(customerWords);
  const s = useWords(salesWords);
  const say = useCustomerProblem();
  const add = useAddCustomer();
  const change = useChangeCustomer();
  /** Where this person may add a customer, or move one to. */
  const writable = sitesFor(
    persona.grants,
    WRITE,
    sites.map((site) => site.id),
  );
  const startSite = siteScope && writable.includes(siteScope) ? siteScope : (writable[0] ?? '');
  const mayChange = customer !== null && change !== null && can(persona.grants, WRITE, { siteId: customer.servedFromSiteId });
  const [editing, setEditing] = useState(customer === null);
  const [draft, setDraft] = useState<CustomerDraft>(() => customerDraft(customer, startSite));
  /**
   * The customer as it was when the change began. The change is worked out
   * against it, not against a later read: a field someone else changed
   * meanwhile, and this person left alone, is not sent back over theirs.
   */
  const [base, setBase] = useState<Customer | null>(customer);
  const [refused, setRefused] = useState<RecordProblem | null>(null);
  const siteName = (id: string) => sites.find((site) => site.id === id)?.name ?? t.otherSite;

  const gaps = customerGaps(draft, writable);
  const busy = (customer ? change?.busy : add?.busy) ?? false;
  const set = <K extends keyof CustomerDraft>(key: K, value: CustomerDraft[K]) => {
    setRefused(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const save = () => {
    if (gaps.length > 0) return;
    const body = customerBody(draft);
    let sent: Promise<RecordProblem | null>;
    if (customer) {
      const patch = customerPatch(base ?? customer, body);
      // Nothing changed is nothing to send.
      if (Object.keys(patch).length === 0 || !change) {
        setEditing(false);
        return;
      }
      sent = change.run({ customer, patch });
    } else {
      if (!add) return;
      sent = add.run(body);
    }
    void sent.then((no) => {
      setRefused(no);
      if (no) return;
      if (customer) setEditing(false);
      else onClose();
    });
  };

  const gstWrong = gaps.includes('gstin') ? t.wrong.gstin : null;
  const daysWrong = gaps.includes('creditDays') ? t.wrong.creditDays : null;
  const limitWrong = gaps.includes('creditLimit') && draft.creditLimit.trim() !== '' ? t.wrong.creditLimit : null;
  const limit = customerBody(draft).creditLimit;

  return (
    <SideSheet
      open
      onClose={onClose}
      width="form"
      title={customer ? customer.name : t.newTitle}
      {...(customer ? { identifier: customer.gstin ?? t.noGst } : {})}
      footer={
        editing ? (
          <>
            <Button variant="primary" onClick={save} disabled={gaps.length > 0 || busy}>
              {busy ? s.saving : s.save}
            </Button>
            <Button
              onClick={() => {
                if (!customer) return onClose();
                setEditing(false);
                setRefused(null);
                setDraft(customerDraft(customer, startSite));
              }}
            >
              {s.cancel}
            </Button>
          </>
        ) : undefined
      }
    >
      {refused ? <Refusal text={say(refused)} /> : null}
      {editing ? (
        <SheetSection caption={customer ? t.changeTitle : t.groups.details}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t.name}>
              <input value={draft.name} maxLength={200} onChange={(e) => set('name', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
            <Field label={t.gstNo} hint={t.gstHint} error={gstWrong}>
              <input
                value={draft.gstin}
                maxLength={15}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => set('gstin', e.target.value.toUpperCase())}
                className={`${FIELD_CLASS} font-id`}
                style={FIELD_STYLE}
              />
            </Field>
            <Field label={t.deliverTo}>
              <input value={draft.site} maxLength={200} onChange={(e) => set('site', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
            <Field label={t.ourSite}>
              <select value={draft.servedFromSiteId} onChange={(e) => set('servedFromSiteId', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE}>
                {writable.includes(draft.servedFromSiteId) ? null : <option value={draft.servedFromSiteId}>—</option>}
                {writable.map((id) => (
                  <option key={id} value={id}>
                    {siteName(id)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.contactName}>
              <input value={draft.contactName} maxLength={200} onChange={(e) => set('contactName', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
            <Field label={t.phone}>
              <input type="tel" value={draft.phone} maxLength={20} onChange={(e) => set('phone', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
            <Field label={t.creditDays} hint={t.daysHint} error={daysWrong}>
              <input inputMode="numeric" value={draft.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
            <Field
              label={t.creditLimitRupees}
              error={limitWrong}
              echo={!limitWrong && draft.creditLimit.trim() ? t.readAs(formatINR(limit, { decimals: 0 })) : null}
            >
              <input inputMode="decimal" value={draft.creditLimit} onChange={(e) => set('creditLimit', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
            </Field>
          </div>
          {gaps.length > 0 ? <StillNeeded text={s.stillNeeded(gaps.map((g) => t.needs[g]))} /> : null}
          {busy ? <Busy text={s.saving} /> : null}
        </SheetSection>
      ) : customer ? (
        <>
          <SheetSection caption={t.groups.details}>
            <DetailGrid>
              <Detail label={t.deliverTo}>{customer.site || '–'}</Detail>
              <Detail label={t.gstNo}>{customer.gstin ? <IdCell>{customer.gstin}</IdCell> : t.noGst}</Detail>
              <Detail label={t.contactName}>{customer.contactName || '–'}</Detail>
              <Detail label={t.phone}>{customer.phone || '–'}</Detail>
              <Detail label={t.ourSite}>{siteName(customer.servedFromSiteId)}</Detail>
              <Detail label={t.creditDays}>{customer.paymentTermsDays === 0 ? t.cash : customer.paymentTermsDays}</Detail>
              <Detail label={t.creditLimit}>
                <MoneyCell value={customer.creditLimit} accounting={false} decimals={0} />
              </Detail>
            </DetailGrid>
          </SheetSection>
          {mayChange ? (
            <div className="pb-2">
              <Button
                onClick={() => {
                  setRefused(null);
                  setBase(customer);
                  setDraft(customerDraft(customer, startSite));
                  setEditing(true);
                }}
              >
                {t.change}
              </Button>
            </div>
          ) : (
            <Note>{t.cannotChange}</Note>
          )}
        </>
      ) : null}
    </SideSheet>
  );
}
