import { businessDate, formatTime, parseTypedAmount } from '@linck/domain';
import type { BreakdownRecord } from '@linck/mock';
import { call, readJson, sendJson } from '../../shell/recordApi.js';
import { vehicleRef } from '../expenses/bills.js';

/**
 * THE BREAKDOWN REGISTER ON THE API, for live mode (VITE_API_URL set).
 *
 *   GET   /breakdowns                every breakdown at the sites this person may read, newest first
 *   POST  /breakdowns                a vehicle down: numbered, counting from when it broke down
 *   PATCH /breakdowns/{id}           what was told corrected, sent to the workshop, or the repair cost
 *   POST  /breakdowns/{id}/resolve   back on the road: the downtime stops counting
 *
 * (apps/api/app/api/breakdowns.py.) The API answers in the register's own
 * BreakdownRecord shape, field for field, plus `siteId`: the demo finds a
 * breakdown's site through its sample vehicle, and the API has no vehicle
 * list to find it through, so the record says which site it is booked to.
 *
 * There is no fleet list or driver roster on the API yet. A breakdown's
 * vehicle is typed and kept as its registration (TN38AL1050), as a bill's is
 * (expenses/bills.ts `vehicleRef`); no driver is asked for, because the API
 * keeps a driver as a roster's id, not a name. Nothing here is ever matched
 * against the demo's sample fleet.
 *
 * Times are typed as IST date and minute; the API keeps instants. A time the
 * person left as the form offered it ("now", or what the record already
 * said) is not sent, so the server's own clock and record stand.
 *
 * Refusals come back as shell/recordApi.ts's RecordProblem; the screen words
 * them (words.ts `breakdownWords.problem`). No React here.
 */

/** A breakdown, with the site it is booked to: the vehicle's home site. */
export interface Breakdown extends BreakdownRecord {
  siteId: string;
}

/** BreakdownOut (apps/api/app/schemas/fleet.py), with `status` a plain string the database holds to the three. */
export type ApiBreakdown = Omit<Breakdown, 'status'> & { status: string };

export function breakdownFromApi(row: ApiBreakdown): Breakdown {
  return {
    id: row.id,
    number: row.number,
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    reportedAt: row.reportedAt,
    reportedBy: row.reportedBy,
    location: row.location,
    cause: row.cause,
    status: row.status as Breakdown['status'],
    resolvedAt: row.resolvedAt,
    downtimeHours: row.downtimeHours,
    repairCost: row.repairCost,
    siteId: row.siteId,
  };
}

/** Breakdowns not fixed at a site: the vehicles off the road there, one breakdown each (the API refuses a second). */
export function downAt(breakdowns: readonly Breakdown[], siteId: string | null): number {
  return breakdowns.filter((b) => b.status !== 'resolved' && (siteId === null || b.siteId === siteId)).length;
}

/* ------------------------------------------------------------- requests */

export function fetchBreakdowns(signal?: AbortSignal): Promise<Breakdown[]> {
  return call('/breakdowns', readJson(signal), (body) => (body as ApiBreakdown[]).map(breakdownFromApi));
}

export function postBreakdown(body: BreakdownBody): Promise<Breakdown> {
  return call('/breakdowns', sendJson('POST', body), (b) => breakdownFromApi(b as ApiBreakdown));
}

export function patchBreakdown(breakdownId: string, body: BreakdownPatchBody): Promise<Breakdown> {
  return call(`/breakdowns/${encodeURIComponent(breakdownId)}`, sendJson('PATCH', body), (b) => breakdownFromApi(b as ApiBreakdown));
}

export function resolveBreakdown(breakdownId: string, body: ResolveBody): Promise<Breakdown> {
  return call(`/breakdowns/${encodeURIComponent(breakdownId)}/resolve`, sendJson('POST', body), (b) => breakdownFromApi(b as ApiBreakdown));
}

/* ---------------------------------------------------------------- times */

/** An instant as the form shows it: IST date and minute, `2026-11-01T14:05`. */
export function istMinute(at: Date | string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return `${businessDate(d)}T${formatTime(d)}`;
}

/** A typed IST date and minute, as the instant the API keeps. Null when it is not one. */
export function instantOf(typed: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(typed)) return null;
  const ms = Date.parse(`${typed}:00+05:30`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A typed repair cost: blank is none, else rupees as the API takes them. Undefined when it cannot be read. */
function costOf(typed: string): string | null | undefined {
  if (!typed.trim()) return null;
  const n = parseTypedAmount(typed);
  return n === null ? undefined : n.toFixed(2);
}

/* ----------------------------------------------------------------- forms */

/** A new breakdown, as typed. */
export interface ReportDraft {
  vehicle: string;
  cause: string;
  location: string;
  /** IST date and minute; offered as now. */
  reportedAt: string;
  /** Who told the desk: often a driver on the phone. Blank is the person typing it. */
  reportedBy: string;
  status: 'open' | 'in_workshop';
  /** The vehicle's home site, where the register keeps it. */
  siteId: string;
}

/** What still needs fixing in a breakdown form, by field. Worded by the screen. */
export type BreakdownGap = 'vehicle' | 'cause' | 'location' | 'when' | 'site' | 'fixedAt' | 'fixedBeforeDown' | 'repairCost';

/** BreakdownIn. Who recorded it and its number are the server's to say. */
export interface BreakdownBody {
  siteId: string;
  vehicleId: string;
  reportedAt?: string;
  reportedBy?: string;
  location: string;
  cause: string;
  status: 'open' | 'in_workshop';
}

/** BreakdownPatch: only what changed. Resolving is its own move. */
export interface BreakdownPatchBody {
  reportedAt?: string;
  reportedBy?: string;
  location?: string;
  cause?: string;
  status?: 'open' | 'in_workshop';
  repairCost?: string | null;
}

/** ResolveIn. */
export interface ResolveBody {
  resolvedAt?: string;
  repairCost?: string;
}

export function reportDraft(siteId: string, now: Date): ReportDraft {
  return { vehicle: '', cause: '', location: '', reportedAt: istMinute(now), reportedBy: '', status: 'open', siteId };
}

const later = (typed: string, now: Date) => {
  const at = instantOf(typed);
  return at === null || Date.parse(at) > now.getTime();
};

export function reportGaps(d: ReportDraft, sites: readonly string[], now: Date): BreakdownGap[] {
  const gaps: BreakdownGap[] = [];
  if (!vehicleRef(d.vehicle)) gaps.push('vehicle');
  if (!d.cause.trim()) gaps.push('cause');
  if (!d.location.trim()) gaps.push('location');
  if (later(d.reportedAt, now)) gaps.push('when');
  if (!sites.includes(d.siteId)) gaps.push('site');
  return gaps;
}

/** A report with no gaps, as `POST /breakdowns` takes it. `offered` is the time the form offered: left as it was, the server's now stands. */
export function reportBody(d: ReportDraft, offered: string): BreakdownBody {
  const reportedBy = d.reportedBy.trim();
  const reportedAt = d.reportedAt !== offered ? instantOf(d.reportedAt) : null;
  return {
    siteId: d.siteId,
    vehicleId: vehicleRef(d.vehicle) ?? '',
    ...(reportedAt ? { reportedAt } : {}),
    ...(reportedBy ? { reportedBy } : {}),
    location: d.location.trim(),
    cause: d.cause.trim(),
    status: d.status,
  };
}

/** A change to a breakdown, as typed. A fixed one keeps only its repair cost open to change. */
export interface ChangeDraft {
  cause: string;
  location: string;
  reportedAt: string;
  reportedBy: string;
  status: 'open' | 'in_workshop';
  repairCost: string;
}

export function changeDraft(b: Breakdown): ChangeDraft {
  return {
    cause: b.cause,
    location: b.location,
    reportedAt: istMinute(b.reportedAt),
    reportedBy: b.reportedBy,
    status: b.status === 'in_workshop' ? 'in_workshop' : 'open',
    repairCost: b.repairCost ?? '',
  };
}

export function changeGaps(b: Breakdown, d: ChangeDraft, now: Date): BreakdownGap[] {
  const gaps: BreakdownGap[] = [];
  if (b.status !== 'resolved') {
    if (!d.cause.trim()) gaps.push('cause');
    if (!d.location.trim()) gaps.push('location');
    if (later(d.reportedAt, now)) gaps.push('when');
  }
  if (costOf(d.repairCost) === undefined) gaps.push('repairCost');
  return gaps;
}

/** The fields a change touched, as `PATCH /breakdowns/{id}` takes them. */
export function changeBody(b: Breakdown, d: ChangeDraft): BreakdownPatchBody {
  const body: BreakdownPatchBody = {};
  if (b.status !== 'resolved') {
    // Who told it can be corrected, never emptied: the API keeps who it was.
    const reportedBy = d.reportedBy.trim();
    if (d.cause.trim() !== b.cause) body.cause = d.cause.trim();
    if (d.location.trim() !== b.location) body.location = d.location.trim();
    if (reportedBy && reportedBy !== b.reportedBy) body.reportedBy = reportedBy;
    if (d.reportedAt !== istMinute(b.reportedAt)) {
      const at = instantOf(d.reportedAt);
      if (at) body.reportedAt = at;
    }
    if (d.status !== b.status) body.status = d.status;
  }
  // Compared as rupees: "12500" is the "12500.00" on record. Cleared is sent as none.
  const cost = costOf(d.repairCost);
  const was = b.repairCost === null ? null : Number(b.repairCost);
  if (cost !== undefined && (cost === null ? was !== null : Number(cost) !== was)) body.repairCost = cost;
  return body;
}

/** Back on the road, as typed. */
export interface ResolveDraft {
  resolvedAt: string;
  repairCost: string;
}

export function resolveDraft(b: Breakdown, now: Date): ResolveDraft {
  return { resolvedAt: istMinute(now), repairCost: b.repairCost ?? '' };
}

/**
 * What stops a fix being saved. `offered` is the time the form offered: left
 * as it is, it is not sent and the API's now stands, which is never before
 * the report. A typed time is held to what the API holds it to.
 */
export function resolveGaps(b: Breakdown, d: ResolveDraft, now: Date, offered: string): BreakdownGap[] {
  const gaps: BreakdownGap[] = [];
  if (d.resolvedAt !== offered) {
    const at = instantOf(d.resolvedAt);
    if (at === null || Date.parse(at) > now.getTime()) gaps.push('fixedAt');
    else if (Date.parse(at) < Date.parse(b.reportedAt)) gaps.push('fixedBeforeDown');
  }
  if (costOf(d.repairCost) === undefined) gaps.push('repairCost');
  return gaps;
}

/** A fix with no gaps, as `POST /breakdowns/{id}/resolve` takes it. `offered` is the time the form offered. */
export function resolveBody(d: ResolveDraft, offered: string): ResolveBody {
  const cost = costOf(d.repairCost);
  const resolvedAt = d.resolvedAt !== offered ? instantOf(d.resolvedAt) : null;
  return {
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(cost ? { repairCost: cost } : {}),
  };
}
