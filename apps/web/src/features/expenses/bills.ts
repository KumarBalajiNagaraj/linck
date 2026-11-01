import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { can, formatTime, parseRegistration, type ActionInput, type BatchPlan, type BillAction, type Grants, type PlannedClaim } from '@linck/domain';
import { DRIVERS, NOW, SITES, VEHICLES, type ExpenseBill } from '@linck/mock';
import { LIVE } from '../../auth/api.js';
import { useApp } from '../../shell/store.js';
import { actorFor, useExpenses } from './expenseStore.js';
import {
  BillRefused,
  correctionBody,
  fetchBills,
  newBillBody,
  patchBill,
  postAction,
  postBatch,
  postBill,
  postImport,
  problemOf,
  uploadScan,
  withBills,
  type BillProblem,
  type ImportClaimBody,
} from './expenseApi.js';
import { billFromClaim, importClaimBody, inboxIdsOf, markInboxImported, type IntakeClaim, type IntakeSource } from './whatsappImport.js';

/**
 * WHERE THE EXPENSE SCREENS' BILLS COME FROM — picked once, here, by the mode
 * the app was built in (auth/api.ts).
 *
 *   DEMO (no VITE_API_URL): the zustand store in expenseStore.ts, seeded from
 *     @linck/mock, with the approval chain's rules applied in the browser.
 *     The Vercel preview, exactly as it has always been.
 *   LIVE: a TanStack Query cache over `GET /expenses` (shell/queryClient.ts),
 *     and every move a request. The API applies the same rules and decides;
 *     this end only offers what it expects the API to allow, and shows the
 *     API's refusal, in words, when it does not.
 *
 * Each hook has one shape in both modes, so a screen asks for its bills, or
 * for a move, without knowing which it got. A move answers with why it did not
 * go through, or null. After a move the cache holds the bill as the API now
 * has it and is read again, so every screen shows the same state.
 *
 * Also here, because they are the same choice: the clock, the sites, and how
 * a vehicle or driver is named. The demo's are its seeded afternoon and its
 * sample sites, fleet and drivers. Live, they are today, the session's sites,
 * and — with no fleet list on the API yet — the registration a bill was
 * raised against.
 */

/* ---------------------------------------------------------------- clock */

/** Now: the demo's seeded afternoon (packages/mock NOW), or the real clock. */
export const now: () => Date = LIVE ? () => new Date() : () => NOW;

/* ---------------------------------------------------------------- bills */

export interface BillList {
  bills: ExpenseBill[];
  /** When they were read, for the as-of stamp. */
  asOf: string;
  /** Always 'ready' in the demo. */
  state: 'loading' | 'ready' | 'failed';
  /** Why they could not be read, when `state` is 'failed'. */
  problem: BillProblem | null;
  retry: () => void;
}

/** Holding any one of these, anywhere, a person has bills to read. */
const READ_KEYS = ['fleet.expense.read', 'stores.expense.read', 'finance.expense.read'];
const mayRead = (grants: Grants) => READ_KEYS.some((key) => can(grants, key));

const BILLS = ['expenses'] as const;
/** One entry per person: the cache never hands one person's list to the next. */
const billsKey = (who: string) => [...BILLS, who] as const;

const NONE: ExpenseBill[] = [];
const noop = () => undefined;

/** The demo's register is stamped with its seeded afternoon, as it always was. */
const DEMO_AS_OF = '14:42';

function useDemoBills(): BillList {
  const bills = useExpenses((s) => s.bills);
  return { bills, asOf: DEMO_AS_OF, state: 'ready', problem: null, retry: noop };
}

function useLiveBills(): BillList {
  const persona = useApp((s) => s.persona);
  const enabled = mayRead(persona.grants);
  const query = useQuery({ queryKey: billsKey(persona.key), queryFn: ({ signal }) => fetchBills(signal), enabled });
  // A list once read stays on screen through a failed re-read; only no list at all is a failure.
  const failed = query.isError && query.data === undefined;
  return {
    bills: query.data ?? NONE,
    asOf: query.dataUpdatedAt > 0 ? formatTime(new Date(query.dataUpdatedAt)) : '–',
    state: !enabled || query.data !== undefined ? 'ready' : failed ? 'failed' : 'loading',
    problem: failed ? problemOf(query.error) : null,
    retry: () => void query.refetch(),
  };
}

/** Every bill this person may read, at every site and desk; screens filter by scope and desk. */
export const useBills: () => BillList = LIVE ? useLiveBills : useDemoBills;

/** The cache after a move: the bills as the API now has them, then a fresh read of everything. */
function keep(client: QueryClient, who: string, changed: ExpenseBill[]): void {
  client.setQueryData<ExpenseBill[]>(billsKey(who), (old) => (old ? withBills(old, changed) : old));
  reread(client);
}

/** After a refusal too: the bill may have moved under this person, and the screen should show where. */
function reread(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: BILLS });
}

/* ---------------------------------------------------------------- moves */

export interface Move<A, R> {
  run: (args: A) => Promise<R>;
  /** A request is on its way, so the screen holds its buttons. Never true in the demo. */
  busy: boolean;
}

/* One move on one bill. */

export interface MoveArgs {
  bill: ExpenseBill;
  action: BillAction;
  input?: ActionInput;
}

function useDemoMove(): Move<MoveArgs, BillProblem | null> {
  const act = useExpenses((s) => s.act);
  const persona = useApp((s) => s.persona);
  return { busy: false, run: async ({ bill, action, input }) => act(bill.id, action, actorFor(persona), input) };
}

function useLiveMove(): Move<MoveArgs, BillProblem | null> {
  const client = useQueryClient();
  const who = useApp((s) => s.persona.key);
  const mutation = useMutation({ mutationFn: ({ bill, action, input }: MoveArgs) => postAction(bill.id, action, input) });
  return {
    busy: mutation.isPending,
    run: async (args) => {
      try {
        keep(client, who, [await mutation.mutateAsync(args)]);
        return null;
      } catch (err) {
        reread(client);
        const problem = problemOf(err);
        // Refused as a second signature although the reason was written: this
        // company does not allow one at all (segregation_enforcement).
        return problem.code === 'second-signature' && args.input?.note?.trim() ? { code: 'signed-already' } : problem;
      }
    },
  };
}

/** One move along the approval chain. */
export const useBillMove: () => Move<MoveArgs, BillProblem | null> = LIVE ? useLiveMove : useDemoMove;

/* The same move on many bills. */

export interface BatchArgs {
  plan: BatchPlan<ExpenseBill>;
  input?: ActionInput;
}

export type BatchResult = { done: number; paise: number } | { problem: BillProblem };

function useDemoBatch(): Move<BatchArgs, BatchResult> {
  const actMany = useExpenses((s) => s.actMany);
  const persona = useApp((s) => s.persona);
  return { busy: false, run: async ({ plan, input }) => ({ done: actMany(plan, actorFor(persona), input), paise: plan.totalPaise }) };
}

function useLiveBatch(): Move<BatchArgs, BatchResult> {
  const client = useQueryClient();
  const who = useApp((s) => s.persona.key);
  const mutation = useMutation({
    mutationFn: ({ plan, input }: BatchArgs) =>
      postBatch(
        plan.action,
        plan.eligible.map((b) => b.id),
        input?.payment,
      ),
  });
  return {
    busy: mutation.isPending,
    run: async (args) => {
      try {
        // The API plans the batch again and does what it finds clean; its count is the one shown.
        const out = await mutation.mutateAsync(args);
        keep(client, who, out.done);
        return { done: out.done.length, paise: out.totalPaise };
      } catch (err) {
        reread(client);
        return { problem: problemOf(err) };
      }
    },
  };
}

/** "Approve all", and the other steps' "all": every bill the plan found clean. */
export const useBillBatch: () => Move<BatchArgs, BatchResult> = LIVE ? useLiveBatch : useDemoBatch;

/* A new bill, from the upload sheet. */

export interface AddArgs {
  /** The bill as the sheet made it. Live, who raised it and its status are the API's to say. */
  bill: ExpenseBill;
  file: File;
}

function useDemoAdd(): Move<AddArgs, BillProblem | null> {
  const add = useExpenses((s) => s.add);
  return {
    busy: false,
    run: async ({ bill }) => {
      add(bill);
      return null;
    },
  };
}

function useLiveAdd(): Move<AddArgs, BillProblem | null> {
  const client = useQueryClient();
  const who = useApp((s) => s.persona.key);
  const mutation = useMutation({
    mutationFn: async ({ bill, file }: AddArgs) => {
      // The scan first, so the bill is never saved without the paper behind it.
      const scan = await uploadScan(file, bill.desk);
      return postBill(newBillBody(bill, scan.id));
    },
  });
  return {
    busy: mutation.isPending,
    run: async (args) => {
      try {
        keep(client, who, [await mutation.mutateAsync(args)]);
        return null;
      } catch (err) {
        return problemOf(err);
      }
    },
  };
}

export const useAddBill: () => Move<AddArgs, BillProblem | null> = LIVE ? useLiveAdd : useDemoAdd;

/* A correction to what capture read, while nobody has signed. */

export interface CorrectArgs {
  bill: ExpenseBill;
  /** The demo's patch, capture record and all. Live, the API works the capture record out itself. */
  patch: Partial<ExpenseBill>;
}

function useDemoCorrect(): Move<CorrectArgs, BillProblem | null> {
  const update = useExpenses((s) => s.update);
  return {
    busy: false,
    run: async ({ bill, patch }) => {
      update(bill.id, patch);
      return null;
    },
  };
}

function useLiveCorrect(): Move<CorrectArgs, BillProblem | null> {
  const client = useQueryClient();
  const who = useApp((s) => s.persona.key);
  const mutation = useMutation({ mutationFn: ({ bill, patch }: CorrectArgs) => patchBill(bill.id, correctionBody(patch)) });
  return {
    busy: mutation.isPending,
    run: async (args) => {
      try {
        keep(client, who, [await mutation.mutateAsync(args)]);
        return null;
      } catch (err) {
        reread(client);
        return problemOf(err);
      }
    },
  };
}

export const useCorrectBill: () => Move<CorrectArgs, BillProblem | null> = LIVE ? useLiveCorrect : useDemoCorrect;

/* WhatsApp slips, taken in as bills. */

export interface ImportArgs {
  rows: PlannedClaim<IntakeClaim>[];
  source: IntakeSource;
  /** Live: the site the bills are booked to. The demo books each to its sample vehicle's site. */
  siteId: string | null;
}

export type ImportResult = { count: number; paise: number; before: number } | { problem: BillProblem };

const paiseOf = (amount: number | string | null) => Math.round(Number(amount ?? 0) * 100);

function useDemoImport(): Move<ImportArgs, ImportResult> {
  const add = useExpenses((s) => s.add);
  return {
    busy: false,
    run: async ({ rows, source }) => {
      for (const r of rows) add(billFromClaim(r.claim, source));
      void markInboxImported(rows.flatMap((r) => inboxIdsOf(r.claim, source)));
      return { count: rows.length, paise: rows.reduce((s, r) => s + paiseOf(r.claim.amount), 0), before: 0 };
    },
  };
}

function useLiveImport(): Move<ImportArgs, ImportResult> {
  const client = useQueryClient();
  const who = useApp((s) => s.persona.key);
  const mutation = useMutation({
    mutationFn: async ({ rows, source, siteId }: ImportArgs) => {
      if (!siteId) throw new BillRefused({ code: 'invalid', field: 'siteId', reason: 'no site to book to' });
      const at = new Date().toISOString();
      const claims: ImportClaimBody[] = [];
      for (const r of rows) {
        // Each slip's photo goes up first, as the upload sheet's scan does.
        const scan = r.claim.photo ? await uploadScan(r.claim.photo, 'fleet') : null;
        claims.push(importClaimBody(r.claim, billFromClaim(r.claim, source, { siteId, at }), scan?.id ?? null));
      }
      return postImport({
        source: source.kind === 'inbox' ? 'inbox' : 'export',
        via: source.kind === 'inbox' ? '' : source.via,
        // Marked imported in the same transaction as the bills (whatsapp_imports.py).
        inboxMessageIds: rows.flatMap((r) => inboxIdsOf(r.claim, source)),
        claims,
      });
    },
  });
  return {
    busy: mutation.isPending,
    run: async (args) => {
      try {
        const out = await mutation.mutateAsync(args);
        keep(client, who, out.imported);
        return { count: out.imported.length, paise: out.imported.reduce((s, b) => s + paiseOf(b.amount), 0), before: out.skipped.length };
      } catch (err) {
        reread(client);
        return { problem: problemOf(err) };
      }
    },
  };
}

export const useImportClaims: () => Move<ImportArgs, ImportResult> = LIVE ? useLiveImport : useDemoImport;

/* ------------------------------------------------------- sites and names */

export interface SiteName {
  id: string;
  code: string;
  name: string;
}

const NO_SITES: SiteName[] = [];

/** The sites this person is scoped to: the session's, or the demo's sample sites. */
export function useSites(): readonly SiteName[] {
  const signedIn = useApp((s) => s.signedIn);
  return LIVE ? (signedIn?.sites ?? NO_SITES) : SITES;
}

/** A site's name, from its id. */
export function useSiteName(): (id: string) => string {
  const sites = useSites();
  return (id) => sites.find((s) => s.id === id)?.name ?? id;
}

/** TN38AL1050 as people write it: TN 38 AL 1050. Anything else as it is. */
export function spacedRegistration(reg: string): string {
  const m = /^([A-Z]{2})(\d{2})([A-Z]{1,3})(\d{4})$/.exec(reg);
  return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : reg;
}

/**
 * A vehicle number someone typed, as a bill keeps it: TN38AL1050. Null when
 * blank. Not every machine has a registration, so what is not one is kept as
 * typed, in capitals, without the spaces.
 */
export function vehicleRef(typed: string): string | null {
  const reg = parseRegistration(typed);
  if (reg) return reg;
  const plain = typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return plain ? plain.slice(0, 20) : null;
}

/**
 * A bill's vehicle, as the screens print it. The demo looks it up in its
 * sample fleet. Live, a bill keeps its vehicle as the registration it was
 * raised against: fleet.vehicles is not on the API yet, and a real company's
 * bills must never be shown against the demo's sample fleet.
 */
export const vehicleLabel: (id: string | null | undefined) => string | null = LIVE
  ? (id) => (id ? spacedRegistration(id) : null)
  : (id) => VEHICLES.find((v) => v.id === id)?.displayReg ?? null;

/** A bill's driver, by name in the demo. Live there is no driver roster yet: the bill's own note of them, if any. */
export const driverLabel: (id: string | null | undefined) => string | null = LIVE
  ? (id) => id ?? null
  : (id) => DRIVERS.find((d) => d.id === id)?.name ?? null;
