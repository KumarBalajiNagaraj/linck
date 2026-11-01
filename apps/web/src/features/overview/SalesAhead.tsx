import { useMemo } from 'react';
import {
  addMonths,
  daysInMonth,
  forecastNextMonth,
  formatQty,
  MIN_CHECKED_MONTHS,
  monthDiff,
  monthNumber,
  monthOf,
  salesHeadsUps,
  type HeadsUp,
  type MaterialForecast,
} from '@linck/domain';
import { CUSTOMERS_LIST, NOW, PRODUCTS, SALES_HISTORY, SALES_HISTORY_FROM, SALES_HISTORY_TO, SITES, STOCK } from '@linck/mock';
import type { StatusFamily } from '@linck/tokens';
import { DataTable, EmptyState, KpiTile, PageHeader, Section, StatusStamp, TileRow, type Column } from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { aheadWords, changeArrow, type AheadText } from './aheadWords.js';
import { useSalesFormat, type SalesFormat } from './salesFormat.js';

/**
 * WHAT'S COMING (LIN-9) — next month's sales and the heads-ups, worked out
 * from the company's own sales history.
 *
 * The ticket asked for "AI based" insight. What is here is plain arithmetic
 * that a director can check on paper, because a forecast nobody can explain
 * is a forecast nobody acts on:
 *
 *   - next month = the same month last year × this year's change, shown with
 *     a low-to-high range taken from how far off the same rule was on past
 *     months (`@linck/domain/sales-forecast`);
 *   - five heads-up rules — stock running short, a customer stopped or buying
 *     far less, a material rising fast, the season ahead
 *     (`@linck/domain/sales-heads-up`).
 *
 * There is no market data in the system: no prices from other crushers, no
 * cement or steel index, no news of projects starting. The page says so in
 * one line under its title instead of letting the word "forecast" imply it.
 *
 * Every heads-up carries a line on what it is based on. The site switcher
 * narrows everything; stock is read per site, because a pile at one crusher
 * does not load a lorry at the other.
 */

/** The north-east monsoon months, when a slow month is a rain month. */
const RAIN_MONTHS = new Set([10, 11, 12]);

const customerName = (id: string) => CUSTOMERS_LIST.find((c) => c.id === id)?.name ?? id;
/** Material and site names are the trade's own and are shown as they are. */
const productName = (code: string) => PRODUCTS.find((p) => p.code === code)?.label ?? code;
const siteName = (id: string) => SITES.find((s) => s.id === id)?.name ?? id;

/**
 * A forecast to the unit claims more than it knows: above a hundred units it
 * is shown to the nearest ten.
 */
const approx = (n: number) => formatQty(n >= 100 ? Math.round(n / 10) * 10 : Math.round(n), 0);
const pctChange = (now: number, before: number | null) => (before === null || before <= 0 ? null : Math.round((now / before - 1) * 100));

export function SalesAhead() {
  const { siteScope, density } = useApp();
  const t = useWords(aheadWords);
  const f = useSalesFormat();

  const next = useMemo(
    () => forecastNextMonth(SALES_HISTORY, SALES_HISTORY_TO, SALES_HISTORY_FROM, { siteId: siteScope }),
    [siteScope],
  );
  const headsUps = useMemo(
    () => salesHeadsUps({ lines: SALES_HISTORY, stock: STOCK, today: SALES_HISTORY_TO, historyFrom: SALES_HISTORY_FROM, siteId: siteScope }),
    [siteScope],
  );
  const columns = useMemo(() => materialTable(t, f, next.month), [t, f, next.month]);

  const months = monthDiff(monthOf(SALES_HISTORY_FROM), monthOf(SALES_HISTORY_TO));
  const month = f.monthName(next.month);
  const total = next.total;
  const change = total.change === null ? null : Math.round((total.change - 1) * 100);
  const checked = total.checked;
  // The track record stands for this forecast only when it was made the same way.
  const asChecked = total.basis === 'last_year' && total.change !== null && checked.months >= MIN_CHECKED_MONTHS;
  const nothing = total.units <= 0 && next.materials.length === 0;

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        meta={
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {t.basis(months)}
            </span>
            {/* There is no market feed: no rivals' prices, no cement or steel
                index, no project news. One line, under the title, so nobody
                reads more into the word "expected" than is there. */}
            <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
              {t.notIncluded}
            </span>
          </span>
        }
      />

      {nothing ? (
        // The workshop and the quarry sell nothing of their own.
        <EmptyState fact={t.empty} because={t.emptyWhy} />
      ) : (
        <>
          <TileRow className="grid-cols-1 sm:grid-cols-3 [&>*]:border-b [&>*]:border-[var(--border-subtle)] [&>*:last-child]:border-b-0 sm:[&>*]:border-b-0 sm:[&>*]:border-r">
            {/* The unit rides in the label, so the hero figure is a bare number. */}
            <KpiTile
              eyebrow={t.tiles.expected(month)}
              hero
              value={approx(total.units)}
              delta={{ text: t.tiles.range(approx(total.low), approx(total.high)) }}
              asOf={f.time(NOW)}
              source={t.source}
              freshness="materialised"
            />
            <KpiTile
              eyebrow={t.tiles.lastYear(month)}
              value={total.lastYearUnits === null ? '–' : formatQty(total.lastYearUnits, 0)}
              delta={{ text: change === null ? t.tiles.noChange : t.tiles.change(change) }}
              asOf={f.time(NOW)}
              source={t.source}
              freshness="materialised"
            />
            {/* Each material's units at its own rate over the last 13 weeks. */}
            <KpiTile
              eyebrow={t.tiles.value(month)}
              value={f.money(next.value)}
              title={f.moneyExact(next.value)}
              delta={{ text: t.tiles.atRates }}
              asOf={f.time(NOW)}
              source={t.source}
              freshness="materialised"
            />
          </TileRow>

          <Section caption={t.watch.caption} title={t.watch.title}>
            {headsUps.length === 0 ? (
              <EmptyState fact={t.watch.none} />
            ) : (
              <ul className="flex flex-col gap-2 px-6">
                {headsUps.map((h, i) => (
                  <HeadsUpCard key={`${h.kind}-${i}`} {...describe(h, t, f, siteScope === null)} />
                ))}
              </ul>
            )}
          </Section>

          <Section caption={t.table.caption} title={t.table.title(month)}>
            <DataTable density={density} columns={columns} rows={next.materials} rowKey={(m) => m.productCode} />
          </Section>

          <Section title={t.how.title}>
            <div className="flex max-w-[720px] flex-col gap-1.5 px-6 text-[14px]" style={{ color: 'var(--text-secondary)' }}>
              <p>
                {total.basis === 'recent'
                  ? t.how.ruleRecent(daysInMonth(next.month))
                  : change === null
                    ? t.how.ruleNoChange(month)
                    : t.how.rule(month, changeArrow(change))}
              </p>
              <p>{t.how.perMaterial}</p>
              {asChecked && checked.errorPct !== null && checked.naiveErrorPct !== null ? (
                <p>{t.how.checked(checked.months, Math.round(checked.errorPct), Math.round(checked.naiveErrorPct))}</p>
              ) : null}
              <p>{asChecked ? t.how.range(total.rangePct, checked.held, checked.months) : t.how.plainRange(total.rangePct)}</p>
            </div>
          </Section>
        </>
      )}

      <div className="h-10" />
    </>
  );
}

interface Described {
  family: StatusFamily;
  kind: string;
  severity?: string;
  line: string;
  more?: string;
  basis: string;
}

/**
 * A heads-up in words. Colour is spent on what needs doing — a pile running
 * out, a customer lost or slipping, a slow season — and good news (a material
 * rising, a busy month) takes the calm "in motion" colour.
 */
function describe(h: HeadsUp, t: AheadText, f: SalesFormat, showSite: boolean): Described {
  const w = t.watch;
  switch (h.kind) {
    case 'stock_short':
      return {
        family: 'attention',
        kind: w.kinds.stock,
        line: w.stockShort(productName(h.productCode), showSite ? siteName(h.siteId) : null, h.days),
        basis: w.stockBasis,
      };
    case 'customer_stopped':
      return {
        family: 'critical',
        kind: w.kinds.customer,
        severity: w.days(h.daysSince),
        line: w.stopped(customerName(h.customerId), h.daysSince),
        more: w.usedTo(Math.round(h.usualGapDays)),
        basis: w.stoppedBasis,
      };
    case 'customer_less':
      return { family: 'attention', kind: w.kinds.customer, line: w.less(customerName(h.customerId), h.dropPct), basis: w.lessBasis };
    case 'material_rising':
      return { family: 'active', kind: w.kinds.demand, line: w.rising(productName(h.productCode), h.risePct), basis: w.risingBasis };
    case 'season':
      return h.changePct < 0
        ? {
            family: 'attention',
            kind: w.kinds.season,
            line: w.seasonLow(f.monthName(h.lastYearMonth), -h.changePct, RAIN_MONTHS.has(monthNumber(h.month))),
            basis: w.seasonBasis,
          }
        : { family: 'active', kind: w.kinds.season, line: w.seasonHigh(f.monthName(h.lastYearMonth), h.changePct), basis: w.seasonBasis };
  }
}

/** One heads-up: what kind, the line with its numbers, and what it is based on. */
function HeadsUpCard({ family, kind, severity, line, more, basis }: Described) {
  return (
    <li
      className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4"
      style={{ background: 'var(--surface)', boxShadow: 'inset 0 0 0 1px var(--border-subtle)', borderRadius: 'var(--r-2)' }}
    >
      {/* Wide enough for the longest stamp, "வாடிக்கையாளர் 43 நாள்", so the
          sentences line up from card to card. */}
      <span className="shrink-0 sm:w-[208px]">
        <StatusStamp status={family} label={kind} {...(severity ? { severity } : {})} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[15px]" style={{ color: 'var(--text-primary)' }}>
          {line}
        </span>
        {more ? (
          <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            {more}
          </span>
        ) : null}
        <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          {basis}
        </span>
      </span>
    </li>
  );
}

function materialTable(t: AheadText, f: SalesFormat, month: string): Column<MaterialForecast>[] {
  return [
    { key: 'material', header: t.table.material, sticky: true, width: 220, render: (m) => productName(m.productCode) },
    { key: 'expected', header: t.table.expected, type: 'num', width: 130, render: (m) => approx(m.units) },
    {
      key: 'range',
      header: t.table.range,
      type: 'num',
      width: 170,
      render: (m) => t.table.rangeCell(approx(m.low), approx(m.high)),
    },
    {
      key: 'last-year',
      // The same month a year earlier, by name: "Sep 2025".
      header: f.monthYear(addMonths(month, -12)),
      type: 'num',
      width: 130,
      render: (m) => (m.lastYearUnits === null ? null : formatQty(m.lastYearUnits, 0)),
    },
    {
      key: 'change',
      header: t.table.change,
      type: 'num',
      width: 110,
      render: (m) => {
        const pct = pctChange(m.units, m.lastYearUnits);
        return pct === null ? null : changeArrow(pct);
      },
    },
  ];
}
