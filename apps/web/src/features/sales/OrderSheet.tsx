import { useRef, useState } from 'react';
import { businessDate, formatINR, formatQty, PRODUCT_DENSITIES, sitesFor } from '@linck/domain';
import { Button, Note, SheetSection, SideSheet } from '@linck/ui';
import { statusWords } from '../../i18n/statusWords.js';
import { useWords } from '../../i18n/words.js';
import { Busy, Field, FIELD_CLASS, FIELD_STYLE, Refusal, StillNeeded } from '../../shell/Field.js';
import type { RecordProblem } from '../../shell/recordApi.js';
import { useApp } from '../../shell/store.js';
import { now, useSites } from '../expenses/bills.js';
import { useCustomers } from './customers.js';
import { useAddOrder } from './orders.js';
import { orderBody, orderDraft, orderGaps, rateOf, unitsOf, type OrderDraft } from './salesApi.js';
import { customerWords, orderWords, salesWords } from './words.js';

/**
 * TAKING AN ORDER, LIVE: what the customer asked for, as they gave it.
 *
 * It goes in waiting approval, numbered by the API (SO/26-27/001) and valued
 * there in exact decimals: units × rate, to the paisa. The amount shown here
 * is only the read-back of what was typed. The materials are the product
 * catalogue a new company starts from (packages/domain uom.ts), not the
 * demo's sample stock; there is no material list on the API yet.
 *
 * Offered only at a site where this person holds `sales.order.write`, and
 * the API decides again.
 */

/** The catalogue a new company starts from, in its own order. */
const PRODUCTS = Object.values(PRODUCT_DENSITIES);
const PRODUCT_CODES = PRODUCTS.map((p) => p.productCode);

/** A material, by the product's own name (M-Sand, 20mm Aggregate), which is not translated. */
export const productLabel = (code: string) => PRODUCT_DENSITIES[code]?.label ?? code;

/** Words for a refusal about an order, in the reader's language. */
export function useOrderProblem(): (p: RecordProblem) => string {
  const s = useWords(salesWords);
  const order = useWords(statusWords).order;
  return (p) => s.problem(p, 'order', (st) => order[st as keyof typeof order] ?? st);
}

/** Mounted only while open, so each opening starts from a blank order. */
export function OrderSheet({ onClose }: { onClose: () => void }) {
  const { persona, siteScope } = useApp();
  const sites = useSites();
  const customers = useCustomers();
  const add = useAddOrder();
  const t = useWords(orderWords);
  const s = useWords(salesWords);
  const c = useWords(customerWords);
  const say = useOrderProblem();
  const writable = sitesFor(
    persona.grants,
    'sales.order.write',
    sites.map((site) => site.id),
  );
  const today = businessDate(now());
  const [draft, setDraft] = useState<OrderDraft>(() => orderDraft(siteScope && writable.includes(siteScope) ? siteScope : (writable[0] ?? ''), today));
  const [refused, setRefused] = useState<RecordProblem | null>(null);
  /** "Deliver to" typed by hand is the person's; picking a customer fills it only until then. */
  const typedDeliverTo = useRef(false);

  const gaps = orderGaps(draft, { customers: customers.rows, sites: writable, products: PRODUCT_CODES, today });
  const set = <K extends keyof OrderDraft>(key: K, value: OrderDraft[K]) => {
    setRefused(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const units = unitsOf(draft.units);
  const rate = rateOf(draft.rate);
  const unitsWrong = draft.units.trim() !== '' && units === null ? t.wrong.units : null;
  const rateWrong = draft.rate.trim() !== '' && rate === null ? t.wrong.rate : null;
  const dateWrong = gaps.includes('deliverBy') && draft.deliverBy !== '' ? t.wrong.deliverBy : null;
  const siteName = (id: string) => sites.find((site) => site.id === id)?.name ?? c.otherSite;

  const save = () => {
    if (gaps.length > 0 || !add) return;
    void add.run(orderBody(draft)).then((no) => {
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
          <Button variant="primary" onClick={save} disabled={gaps.length > 0 || (add?.busy ?? false)}>
            {add?.busy ? s.saving : s.save}
          </Button>
          <Button onClick={onClose}>{s.cancel}</Button>
        </>
      }
    >
      {refused ? <Refusal text={say(refused)} /> : null}
      <SheetSection caption={t.order}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={s.customer} hint={customers.state === 'loading' ? c.loading : null}>
            <select
              value={draft.customerId}
              onChange={(e) => {
                const picked = customers.rows.find((x) => x.id === e.target.value);
                setRefused(null);
                setDraft((d) => ({ ...d, customerId: e.target.value, ...(picked && !typedDeliverTo.current ? { deliverySite: picked.site } : {}) }));
              }}
              className={FIELD_CLASS}
              style={FIELD_STYLE}
            >
              <option value="">{t.pickCustomer}</option>
              {customers.rows.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.theirRef}>
            <input
              value={draft.customerPoRef}
              maxLength={60}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set('customerPoRef', e.target.value)}
              className={`${FIELD_CLASS} font-id`}
              style={FIELD_STYLE}
            />
          </Field>
          <Field label={s.material}>
            <select value={draft.productCode} onChange={(e) => set('productCode', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE}>
              <option value="">—</option>
              {PRODUCTS.map((p) => (
                <option key={p.productCode} value={p.productCode}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.unitsLabel} error={unitsWrong} echo={units !== null ? c.readAs(s.unitsN(formatQty(units, Number.isInteger(units) ? 0 : 3))) : null}>
            <input inputMode="decimal" value={draft.units} onChange={(e) => set('units', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
          </Field>
          <Field
            label={t.rateLabel}
            error={rateWrong}
            echo={rate !== null ? (units !== null ? t.valueIs(formatINR(units * rate)) : c.readAs(formatINR(rate))) : null}
          >
            <input inputMode="decimal" value={draft.rate} onChange={(e) => set('rate', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
          </Field>
          <Field label={t.deliverBy} error={dateWrong}>
            <input type="date" min={today} value={draft.deliverBy} onChange={(e) => set('deliverBy', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE} />
          </Field>
          <Field label={t.deliverTo}>
            <input
              value={draft.deliverySite}
              maxLength={200}
              onChange={(e) => {
                typedDeliverTo.current = true;
                set('deliverySite', e.target.value);
              }}
              className={FIELD_CLASS}
              style={FIELD_STYLE}
            />
          </Field>
          <Field label={c.ourSite}>
            <select value={draft.siteId} onChange={(e) => set('siteId', e.target.value)} className={FIELD_CLASS} style={FIELD_STYLE}>
              {writable.includes(draft.siteId) ? null : <option value={draft.siteId}>—</option>}
              {writable.map((id) => (
                <option key={id} value={id}>
                  {siteName(id)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {gaps.length > 0 ? <StillNeeded text={s.stillNeeded(gaps.map((g) => t.needs[g]))} /> : null}
        {add?.busy ? <Busy text={s.saving} /> : null}
      </SheetSection>
      {/* Nothing is loaded against an order until it is approved. */}
      {units !== null ? <Note>{t.approveToLoad(formatQty(units, Number.isInteger(units) ? 0 : 3))}</Note> : null}
    </SideSheet>
  );
}
