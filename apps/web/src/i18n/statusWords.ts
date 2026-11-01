import type { BreakdownRecord, Driver, EwbStanding, ExpenseBill, Invoice, PurchaseOrder, Trip, VehicleStatus } from '@linck/mock';
import { words } from './words.js';

/**
 * Every status the product shows, in one place, in English and Tamil — so a
 * vehicle is "In service" on the board, the list and the search alike.
 *
 * Screens read these instead of the English-only `*_LABEL` maps in
 * `@linck/mock`.
 *
 * A status is a stamp, and a stamp does not wrap or shrink: the Tamil is kept
 * as short as the English, a word or two. "Waiting approval" is அனுமதி
 * வேண்டும் (approval needed), not அனுமதிக்காக காத்திருக்கிறது, which ran to
 * 220px and squeezed every header and phone card it sat in.
 */

interface StatusWords {
  vehicle: Record<VehicleStatus, string>;
  invoice: Record<Invoice['status'], string>;
  trip: Record<Trip['status'], string>;
  ewb: Record<EwbStanding, string>;
  order: Record<PurchaseOrder['status'], string>;
  expense: Record<ExpenseBill['status'], string>;
  expenseKind: Record<ExpenseBill['kind'], string>;
  breakdown: Record<BreakdownRecord['status'], string>;
  attendance: Record<Driver['attendance'], string>;
  indent: Record<'submitted' | 'approved' | 'issued' | 'rejected', string>;
}

export const statusWords = words<StatusWords>({
  en: {
    vehicle: { ready: 'Ready', on_trip: 'On trip', idle: 'No work', under_service: 'In service', breakdown: 'Breakdown', off_road: 'Off road' },
    invoice: {
      draft: 'Draft',
      issued: 'Sent',
      part_paid: 'Part paid',
      payment_reported: 'Paid, not checked',
      payment_verified: 'Payment checked',
      closed: 'Closed',
      overdue: 'Overdue',
    },
    trip: {
      planned: 'Planned',
      loaded: 'Loaded',
      in_transit: 'On the way',
      delivered: 'Delivered',
      completed: 'Done',
      returned: 'Returned',
      cancelled: 'Cancelled',
    },
    ewb: {
      not_required: 'Not needed',
      blocked: 'Blocked',
      to_generate: 'To make',
      part_b_pending: 'Vehicle no. missing',
      part_a_lapsed: 'Lapsed',
      active: 'Valid',
      expiring: 'Expiring',
      expired: 'Expired',
      cancelled: 'Cancelled',
    },
    order: {
      pending_approval: 'Waiting approval',
      approved: 'Approved',
      part_dispatched: 'Part sent',
      fulfilled: 'Done',
      rejected: 'Rejected',
    },
    expense: {
      submitted: 'To check',
      validated: 'With director',
      approved: 'With accounts',
      passed: 'Ready to pay',
      paid: 'Paid',
      rejected: 'Rejected',
      deleted: 'Deleted',
    },
    expenseKind: { diesel: 'Diesel', repair: 'Repair', tyre: 'Tyre', spares: 'Spares', toll: 'Toll', other: 'Other' },
    breakdown: { open: 'Down', in_workshop: 'In workshop', resolved: 'Fixed' },
    attendance: { present: 'Present', on_trip: 'On trip', rest: 'Rest day', leave: 'On leave', absent: 'Absent' },
    indent: { submitted: 'Waiting approval', approved: 'Approved', issued: 'Given', rejected: 'Rejected' },
  },
  ta: {
    vehicle: {
      ready: 'தயார்',
      on_trip: 'ட்ரிப்பில்',
      idle: 'வேலை இல்லை',
      under_service: 'சர்வீஸில்',
      breakdown: 'பழுது',
      off_road: 'நிறுத்தப்பட்டது',
    },
    invoice: {
      draft: 'வரைவு',
      issued: 'அனுப்பியது',
      part_paid: 'பாதி பணம் வந்தது',
      payment_reported: 'சரிபார்க்காத பணம்',
      payment_verified: 'பணம் சரிபார்த்தது',
      closed: 'முடிந்தது',
      overdue: 'தாமதம்',
    },
    trip: {
      planned: 'திட்டமிட்டது',
      loaded: 'லோடு ஏற்றியது',
      in_transit: 'வழியில்',
      delivered: 'டெலிவரி ஆனது',
      completed: 'முடிந்தது',
      returned: 'திரும்பியது',
      cancelled: 'ரத்து',
    },
    ewb: {
      not_required: 'தேவையில்லை',
      blocked: 'தடுக்கப்பட்டது',
      to_generate: 'உருவாக்க வேண்டும்',
      part_b_pending: 'வண்டி எண் இல்லை',
      part_a_lapsed: 'காலம் கடந்தது',
      active: 'செல்லும்',
      expiring: 'காலாவதி ஆகிறது',
      expired: 'காலாவதி',
      cancelled: 'ரத்து',
    },
    order: {
      pending_approval: 'அனுமதி வேண்டும்',
      approved: 'அனுமதித்தது',
      part_dispatched: 'பாதி அனுப்பியது',
      fulfilled: 'முடிந்தது',
      rejected: 'நிராகரித்தது',
    },
    expense: {
      submitted: 'சரிபார்க்க வேண்டும்',
      validated: 'இயக்குநரிடம்',
      approved: 'கணக்காளரிடம்',
      passed: 'பணம் கொடுக்கத் தயார்',
      paid: 'பணம் கொடுத்தது',
      rejected: 'நிராகரித்தது',
      deleted: 'நீக்கியது',
    },
    expenseKind: { diesel: 'டீசல்', repair: 'ரிப்பேர்', tyre: 'டயர்', spares: 'ஸ்பேர்ஸ்', toll: 'டோல்', other: 'மற்றவை' },
    breakdown: { open: 'பழுது', in_workshop: 'வொர்க்ஷாப்பில்', resolved: 'சரியானது' },
    attendance: { present: 'வந்துள்ளார்', on_trip: 'ட்ரிப்பில்', rest: 'ஓய்வு நாள்', leave: 'விடுப்பு', absent: 'வரவில்லை' },
    indent: { submitted: 'அனுமதி வேண்டும்', approved: 'அனுமதித்தது', issued: 'கொடுத்தது', rejected: 'நிராகரித்தது' },
  },
});
