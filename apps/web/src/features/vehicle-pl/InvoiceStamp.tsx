import { decimal } from '@linck/domain';
import type { PlInvoiceRow } from '@linck/mock';
import { StatusStamp } from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { invoiceWords } from './invoiceWords.js';

/**
 * An invoice's one mark: a draft (dashed: not yet true) or a cancelled one,
 * both without colour; an issued one says its money instead, the rail filled
 * as far as it is paid.
 */
export function InvoiceStamp({ row }: { row: Pick<PlInvoiceRow, 'status' | 'moneyStatus' | 'total' | 'received'> }) {
  const w = useWords(invoiceWords);
  if (row.status === 'draft') return <StatusStamp status="dormant" provisional label={w.status.draft} />;
  if (row.status === 'cancelled') return <StatusStamp status="dormant" label={w.status.cancelled} />;
  const money = row.moneyStatus ?? 'due';
  if (money === 'paid') return <StatusStamp status="ready" label={w.money.paid} />;
  if (money === 'part_paid') {
    const total = decimal.toNumber(decimal.dec(row.total));
    const received = decimal.toNumber(decimal.dec(row.received));
    return <StatusStamp status="attention" label={w.money.part_paid} fillRatio={total > 0 ? received / total : 0} />;
  }
  return <StatusStamp status="pending" label={w.money.due} />;
}
