import { useState } from 'react';
import { businessDate, formatDate, formatINR, formatQty, formatTime } from '@linck/domain';
import {
  DRIVERS, EXTRACTION_JOBS, FUEL_ENTRIES, NOW, VEHICLES, mileageFor, vehiclesForSite, type FuelEntry,
} from '@linck/mock';
import {
  AsOfStamp, BarChart, Button, ChartCaption, Chip, ConfidenceMeter, ConfirmModal, Dash, DataTable, Detail,
  DetailGrid, EmptyState, IdCell, MoneyCell, Note, PageHeader, ProportionBar, Provisional, QuantityCell, Rail,
  Section, SheetSection, SideSheet, Stacked, StatusStamp, SuggestionStrip, TrendChart, useIsTouch, type BarDatum,
  type Column,
} from '@linck/ui';
import { useWords } from '../../i18n/words.js';
import { useApp } from '../../shell/store.js';
import { fleetWords, fuelWords } from './words.js';

/**
 * Diesel and DEF entry.
 *
 * The highest-frequency keystroke surface in the product, and the one place
 * diesel pilferage is actually caught — so every derived check lives in the
 * field's RIGHT MARGIN, never in a modal and never as a blocking error. The
 * clerk keys the bill as it is written; Linck says what the numbers imply and
 * then gets out of the way. A fill implying 2.8 km/l against a 3.6 benchmark is
 * still a fill that happened, and refusing to save it only moves the theft off
 * the system.
 *
 * A driver keys this at the bunk, often in Tamil, so the screen says as little
 * as it can: a label, the figure, and — only when something is off — what to
 * check. "Benchmark" is said as "normal", the odometer as "km reading".
 *
 * The single hard stop is a meter running backwards, and even that keeps the
 * typed value legible: a critical rail on the field's left edge and a message
 * in a RESERVED slot, so nothing under the cursor ever jumps.
 *
 * Two charts sit alongside, and neither of them is decoration. The mileage
 * trend re-draws the moment the operator picks a different tipper, so the
 * question "is this fill odd for THIS lorry" is answered before the litres are
 * typed rather than after. Only a full tank to a full tank yields a reading, so
 * the line is sparse by construction — six to nine points a month, never
 * thirty; a steady slide is what a leaking return line or a nightly can of
 * diesel looks like, one bad point is usually a hill and a heavy load. The
 * litres bar carries the tank capacity as a tick, which is the only way an
 * impossible fill — 432 L into a 300 L tank — is visible at all; it is the
 * theft that hides best, because every individual number on the bill is
 * plausible.
 */
export function FuelEntryScreen() {
  const t = useWords(fuelWords);
  const f = useWords(fleetWords);
  const { siteScope, density } = useApp();
  // A bar is a click target here — 20px of it is a miss on a thumb, and no CSS
  // reaches inside the SVG to say so.
  const touch = useIsTouch();
  const fleet = vehiclesForSite(siteScope);
  const crew = siteScope ? DRIVERS.filter((d) => d.siteId === siteScope) : DRIVERS;

  const bill = EXTRACTION_JOBS.find((j) => j.documentType === 'diesel_bill');
  const billValue = (key: string) => bill?.fields.find((field) => field.key === key)?.value ?? '';

  const [vehicleId, setVehicleId] = useState(() => fleet.find((v) => v.displayReg === billValue('vehicle'))?.id ?? '');
  const [driverPick, setDriverPick] = useState('auto');
  const [date, setDate] = useState(() => businessDate(NOW));
  const [odometer, setOdometer] = useState('');
  const [litres, setLitres] = useState('');
  const [rate, setRate] = useState('95.55');
  const [amount, setAmount] = useState('');
  const [fullTank, setFullTank] = useState(true);
  const [source, setSource] = useState<FuelEntry['source']>('own_bunk');
  const [billNumber, setBillNumber] = useState('');
  const [def, setDef] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const [inkDry, setInkDry] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [entries, setEntries] = useState<FuelEntry[]>(FUEL_ENTRIES);

  // The review flag is a supervisor's bookmark, not a status the ledger owns —
  // it lives beside the entries rather than inside them, so flagging never
  // rewrites a posted row. On screen it is a "mark to check".
  const [flagged, setFlagged] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selected, setSelected] = useState<FuelEntry | null>(null);
  const [lens, setLens] = useState<'all' | 'exceptions' | 'flagged'>('all');
  const [confirming, setConfirming] = useState(false);

  const vehicle = fleet.find((v) => v.id === vehicleId) ?? fleet[0];
  if (!vehicle) {
    return (
      <>
        <PageHeader eyebrow={f.eyebrow} title={t.title} />
        <EmptyState fact={t.noVehicles} because={t.pickSite} />
      </>
    );
  }

  const driverId = driverPick === 'auto' ? vehicle.driverId : driverPick === '' ? null : driverPick;
  const litresN = toNum(litres);
  const rateN = toNum(rate);
  const amountN = toNum(amount);
  const odoN = toNum(odometer);
  const defN = toNum(def);

  const tank = tankCapacity(vehicle.classTonnes);

  // Litres × rate must agree with the typed amount inside ₹1.
  const expected = litresN !== null && rateN !== null ? litresN * rateN : null;
  const drift = expected !== null && amountN !== null ? amountN - expected : null;

  // A meter cannot run backwards. This is the screen's only hard stop.
  const odoBackwards = odoN !== null && odoN <= vehicle.odometerKm;

  // Mileage is computable full tank to full tank and no other way.
  const lastFull = entries
    .filter((e) => e.vehicleId === vehicle.id && e.fullTank)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const odoDelta = odoN !== null && !odoBackwards && lastFull ? odoN - lastFull.odometerKm : null;
  const implied = fullTank && odoDelta !== null && odoDelta > 0 && litresN ? odoDelta / litresN : null;
  const kmplShort = implied !== null && implied < vehicle.benchmarkKmpl * 0.82;
  // DEF (AdBlue) as a share of the diesel: a BS-VI tipper runs 3 to 6%.
  const defPct = defN !== null && litresN ? (defN / litresN) * 100 : null;
  const overTank = litresN !== null && litresN > tank;

  const scoped = new Set(fleet.map((v) => v.id));
  const recent = entries.filter((e) => scoped.has(e.vehicleId)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);

  // Off benchmark by more than 18%, or more litres than the tank holds.
  const exceptions = recent.filter((e) => isShort(e) || overTankFill(e));
  const visible =
    lens === 'flagged' ? recent.filter((e) => flagged.has(e.id)) : lens === 'exceptions' ? exceptions : recent;

  /* ------------------------------------------------------------- the charts */

  // Redrawn from the picked vehicle, not from a snapshot — changing the select
  // above changes this line, which is the whole point of it being here.
  const mileageSeries = mileageFor(vehicle.id).map((m) => ({ label: dayMonth(m.date), value: m.kmpl }));
  const kmplFloor = vehicle.benchmarkKmpl * 0.82;
  const belowFloor = mileageSeries.filter((p) => p.value < kmplFloor).length;
  const latestKmpl = mileageSeries[mileageSeries.length - 1]?.value ?? null;

  // Ten bars, most recent at the top, each with its own tank as the tick — the
  // 48-tonner and the 25-tonner do not share a ceiling and averaging them hides
  // exactly the fill worth arguing about. A bar past its tick did not all go
  // into that lorry.
  const barOf = new Map<string, FuelEntry>();
  const fillBars: BarDatum[] = recent.slice(0, 10).map((e) => {
    const v = VEHICLES.find((x) => x.id === e.vehicleId);
    let label = `${v?.displayReg ?? e.vehicleId} · ${formatDate(e.date)}`;
    while (barOf.has(label)) label += ' ';
    barOf.set(label, e);
    const cap = v ? tankCapacity(v.classTonnes) : null;
    const over = cap !== null && e.litres > cap;
    return {
      label,
      value: e.litres,
      ...(cap !== null ? { marker: cap } : {}),
      ...(over
        ? { tone: 'var(--status-critical)' }
        : flagged.has(e.id)
          ? { tone: 'var(--status-attention)' }
          : {}),
    };
  });
  const overFills = fillBars.filter((b) => b.marker !== undefined && b.value > b.marker).length;

  /* -------------------------------------------------------------- mutations */

  // The odometer on the bill photo read at the lowest confidence, so it is not
  // carried across; the strip asks the person to type it.
  const applyBill = () => {
    setPrefilled(true);
    setInkDry(false);
    setSource('outside_bunk');
    setLitres(billValue('litres'));
    setRate(billValue('rate'));
    setAmount(billValue('amount'));
    setBillNumber(billValue('bill_no'));
  };

  const toggleFlag = (id: string) =>
    setFlagged((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Whether this fill reads as an exception. It never blocks the keystroke —
  // the margins already said all of this while it was being typed — it only
  // decides whether posting asks once before it writes.
  const exceptional = kmplShort || overTank || (drift !== null && Math.abs(drift) > 1);

  // An arrow function, not a hoisted declaration: the `vehicle` guard above
  // narrows the const, and only a non-hoisted closure keeps that narrowing.
  const commit = () => {
    const id = `fuel-new-${entries.length + 1}`;
    setEntries((prev) => [
      {
        id,
        // Both halves are Indian wall-clock: the date picker's day and
        // `formatTime`, which formats in Asia/Kolkata. So the offset is IST's,
        // not `Z` — with `Z` a 14:42 fill was stored as 14:42 UTC and shown
        // back as 20:12.
        date: `${date}T${formatTime(NOW)}:00+05:30`,
        vehicleId: vehicle.id,
        driverId,
        litres: litresN ?? 0,
        ratePerLitre: (rateN ?? 0).toFixed(2),
        amount: (amountN ?? 0).toFixed(2),
        odometerKm: odoN ?? vehicle.odometerKm,
        fullTank,
        source,
        billNumber: source === 'outside_bunk' && billNumber !== '' ? billNumber : null,
        impliedKmpl: implied,
        provenance: prefilled ? (inkDry ? 'confirmed' : 'proposed') : 'human',
      },
      ...prev,
    ]);
    // An exception posts and then carries a flag. The supervisor finds it; the
    // clerk is not made to argue with the software about it at 6am.
    if (exceptional) setFlagged((prev) => new Set(prev).add(id));
    for (const reset of [setOdometer, setLitres, setAmount, setDef, setBillNumber]) reset('');
    setPrefilled(false);
    setInkDry(false);
  };

  const post = () => {
    if (exceptional) setConfirming(true);
    else commit();
  };

  // Saves and clears the form for the next fill.
  const saveDisabled = odoBackwards || !litresN || !amountN;

  const hatch = prefilled && !inkDry;
  // Inside the hatch the control drops its own box, so the texture is unbroken
  // and the extracted figure still reads at full contrast against the photo.
  const boxed: React.CSSProperties = hatch ? { ...FIELD_BOX, background: 'transparent', boxShadow: 'none' } : FIELD_BOX;

  const tableColumns: Column<FuelEntry>[] = [
    ...columnsFor(t, f),
    {
      key: 'standing',
      header: t.col.status,
      type: 'status',
      width: 170,
      render: (e) => {
        if (flagged.has(e.id)) return <StatusStamp status="attention" label={t.standing.marked} />;
        if (overTankFill(e)) return <StatusStamp status="critical" label={t.standing.overTank} />;
        if (isShort(e)) return <StatusStamp status="attention" label={t.standing.low} severity={`-${shortfallPct(e)}%`} />;
        if (e.provenance === 'proposed') return <StatusStamp status="pending" label={t.standing.notChecked} provisional />;
        return <StatusStamp status="ready" label={t.standing.ok} />;
      },
    },
  ];

  const sheetStatus = selected
    ? flagged.has(selected.id)
      ? { family: 'attention' as const, label: t.standing.marked }
      : overTankFill(selected)
        ? { family: 'critical' as const, label: t.standing.overTank }
        : isShort(selected)
          ? { family: 'attention' as const, label: t.standing.low, severity: `-${shortfallPct(selected)}%` }
          : selected.provenance === 'proposed'
            ? { family: 'pending' as const, label: t.standing.notChecked, provisional: true }
            : { family: 'ready' as const, label: t.standing.ok }
    : undefined;

  return (
    <>
      <PageHeader
        eyebrow={f.eyebrow}
        title={t.title}
        meta={<AsOfStamp asOf={formatTime(NOW)} source={f.from.diesel} freshness="live" />}
        actions={
          // On a phone the same button sits under the last field instead,
          // where the thumb is when the form is done.
          <div className="hidden md:block">
            <Button variant="primary" onClick={post} disabled={saveDisabled}>
              {t.save}
            </Button>
          </div>
        }
      />

      {bill && !prefilled && !dismissed ? (
        <div className="px-6 pt-4">
          <SuggestionStrip onApply={applyBill} onDismiss={() => setDismissed(true)} applyLabel={t.fromBill}>
            {t.billPhoto(bill.capturedBy, formatTime(bill.capturedAt), billValue('vehicle'), billValue('litres'), billValue('rate'))}
          </SuggestionStrip>
        </div>
      ) : null}

      <Section
        title={t.newEntry}
        // Confirms the four figures read off the bill photo: litres, rate,
        // amount and bill number.
        actions={hatch ? <Button variant="primary" onClick={() => setInkDry(true)}>{t.matchesBill}</Button> : null}
      >
        <div className="grid grid-cols-1 gap-x-10 gap-y-8 px-6 pt-1 xl:grid-cols-[minmax(0,560px)_minmax(0,1fr)] xl:gap-y-0">
          <div className="w-full max-w-[560px]">
            <Field label={t.vehicle}>
              <select value={vehicle.id} className={CTRL} style={FIELD_BOX} onChange={(e) => { setVehicleId(e.target.value); setDriverPick('auto'); }}>
                {fleet.map((v) => <option key={v.id} value={v.id}>{v.displayReg} · {v.model}</option>)}
              </select>
            </Field>

            {/* The driver is taken from the vehicle roster until someone picks another. */}
            <Field label={t.driver} help={driverPick === 'auto' ? t.driverAuto : t.driverChanged}>
              <select value={driverPick === 'auto' ? (vehicle.driverId ?? '') : driverPick} className={CTRL} style={FIELD_BOX} onChange={(e) => setDriverPick(e.target.value)}>
                <option value="">{t.noDriver}</option>
                {crew.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>

            <Field label={t.date}>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={CTRL} style={FIELD_BOX} />
            </Field>

            {/* A part fill (a top-up) yields no km/l: the figure is held back
                rather than guessed. Below the last reading, the fix is to check
                the dash or raise a meter-change note. */}
            <Field
              label={t.kmReading}
              margin={
                !fullTank ? (
                  <Margin>{t.notFullNoMileage}</Margin>
                ) : implied !== null ? (
                  <Margin tone={kmplShort ? 'attention' : 'quiet'}>
                    {t.mileageIs(formatQty(implied, 1), formatQty(vehicle.benchmarkKmpl, 1))}
                  </Margin>
                ) : prefilled ? (
                  <Margin>
                    <span className="inline-flex items-center gap-1"><ConfidenceMeter level={1} /> {t.photoUnclear}</span>
                  </Margin>
                ) : null
              }
              error={odoBackwards ? t.kmTooLow(formatQty(vehicle.odometerKm, 0)) : undefined}
              help={lastFull ? t.lastFull(formatDate(lastFull.date), formatQty(lastFull.odometerKm, 0)) : undefined}
            >
              <input inputMode="decimal" value={odometer} placeholder={formatQty(vehicle.odometerKm, 0)} className={`${CTRL} text-right`} style={FIELD_BOX} onChange={(e) => setOdometer(e.target.value)} />
            </Field>

            {/* More diesel than the tank holds: either two lorries were filled
                on one bill, or some of it left in a can. */}
            <Field
              label={t.litres}
              margin={
                overTank ? (
                  <Margin tone="attention">{t.overTank(formatQty(tank, 0))}</Margin>
                ) : odoDelta ? (
                  <Margin>{t.sinceLastFull(formatQty(odoDelta, 0))}</Margin>
                ) : null
              }
            >
              <Wrap on={prefilled} confirmed={inkDry}>
                <input inputMode="decimal" value={litres} onChange={(e) => setLitres(e.target.value)} className={`${CTRL} text-right`} style={boxed} />
              </Wrap>
            </Field>

            <Field label={t.rate} margin={source === 'own_bunk' && !prefilled ? <Margin>{t.ourRate}</Margin> : null}>
              <Wrap on={prefilled} confirmed={inkDry}>
                <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className={`${CTRL} text-right`} style={boxed} />
              </Wrap>
            </Field>

            <Field
              label={t.amount}
              margin={
                drift === null ? null : Math.abs(drift) <= 1 ? <Margin>{t.amountMatches}</Margin> : (
                  <Margin tone="attention">{t.litresTimesRate(formatINR(expected ?? 0))}</Margin>
                )
              }
            >
              <Wrap on={prefilled} confirmed={inkDry}>
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${CTRL} text-right`} style={boxed} />
              </Wrap>
            </Field>

            {/* Full tank to full tank is the only honest mileage. Leave it ticked
                whenever the nozzle cut off by itself. */}
            <Field label={t.tank} help={t.fullTankHelp}>
              <label
                className="flex h-11 cursor-pointer items-center gap-2.5 text-[15px] [@media(hover:hover)]:h-[34px] [@media(hover:hover)]:text-[14px]"
                style={{ color: 'var(--text-primary)' }}
              >
                <input
                  type="checkbox"
                  checked={fullTank}
                  onChange={(e) => setFullTank(e.target.checked)}
                  className="h-6 w-6 [@media(hover:hover)]:h-4 [@media(hover:hover)]:w-4"
                  style={{ accentColor: 'var(--brand)' }}
                />
                {t.fullTank}
              </label>
            </Field>

            <Field label={t.where}>
              <select value={source} onChange={(e) => setSource(e.target.value as FuelEntry['source'])} className={CTRL} style={FIELD_BOX}>
                <option value="own_bunk">{t.ownBunk}</option>
                <option value="outside_bunk">{t.outsideBunk}</option>
              </select>
            </Field>

            {/* An outside fill without a bill number cannot be set against the
                vendor ledger. */}
            {source === 'outside_bunk' ? (
              <Field label={t.billNumber} help={t.billNumberHelp}>
                <Wrap on={prefilled} confirmed={inkDry}>
                  <input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} className={`font-id ${CTRL}`} style={boxed} />
                </Wrap>
              </Field>
            ) : null}

            {/* Blank means nobody topped it up. Zero means somebody looked and
                it was already full. */}
            <Field
              label={t.adBlue}
              margin={defPct === null ? null : (
                <Margin tone={defPct > 6 || defPct < 3 ? 'attention' : 'quiet'}>{t.adBlueShare(formatQty(defPct, 1))}</Margin>
              )}
              help={t.adBlueHelp}
            >
              <input inputMode="decimal" value={def} onChange={(e) => setDef(e.target.value)} className={`${CTRL} text-right`} style={FIELD_BOX} />
            </Field>

            <div className="mt-2 md:hidden">
              <Button variant="primary" className="w-full" onClick={post} disabled={saveDisabled}>
                {t.save}
              </Button>
            </div>
          </div>

          {/* The picked vehicle's own history, so the clerk is comparing this
              fill against this lorry rather than against the fleet average. */}
          <div className="min-w-0 pt-1">
            <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
              {t.days28}
            </p>
            <h3 className="font-serif mb-1 text-[18px]" style={{ color: 'var(--text-primary)' }}>
              {t.mileageOf(vehicle.displayReg)}
            </h3>
            {mileageSeries.length >= 2 ? (
              <>
                {/* The trailing series label eats 96px of the frame, so below
                    a phone's width the date axis would collide with itself.
                    The line keeps its measure and scrolls in its own box. */}
                <div className="overflow-x-auto">
                  <div className="min-w-[400px]">
                    <TrendChart
                      data={mileageSeries}
                      summary={t.mileageSummary(
                        vehicle.displayReg,
                        formatQty(latestKmpl, 2),
                        formatQty(vehicle.benchmarkKmpl, 1),
                        belowFloor,
                      )}
                      seriesLabel={vehicle.displayReg}
                      benchmark={{
                        value: vehicle.benchmarkKmpl,
                        label: t.normalAt(formatQty(vehicle.benchmarkKmpl, 1)),
                      }}
                      flagBelow={kmplFloor}
                      height={186}
                      format={(v) => formatQty(v, 1)}
                    />
                  </div>
                </div>
                <ChartCaption>{t.mileageNote}</ChartCaption>
              </>
            ) : (
              // Mileage appears once two full-tank fills have been keyed
              // against the same meter.
              <Note>{t.noMileage}</Note>
            )}

            <div className="mt-6">
              <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                {t.last10}
              </p>
              <h3 className="font-serif mb-1 text-[18px]" style={{ color: 'var(--text-primary)' }}>
                {t.litresVsTank}
              </h3>
              {/* The label reserve is 178px and the value gutter another 64, so
                  below a tablet the bars themselves would have nothing left to
                  say. The chart keeps its real measure and scrolls inside its
                  own box rather than pushing the page sideways. */}
              <div className="overflow-x-auto">
                <div className="min-w-[460px]">
                  <BarChart
                    summary={t.fillsSummary(fillBars.length, overFills)}
                    data={fillBars}
                    format={(v) => t.litresShort(formatQty(v, 0))}
                    barHeight={touch ? 34 : 20}
                    labelWidth={178}
                    onSelect={(d) => {
                      const hit = barOf.get(d.label);
                      if (hit) setSelected(hit);
                    }}
                  />
                </div>
              </div>
              <ChartCaption>{t.fillsNote}</ChartCaption>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title={t.recent}
        actions={
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <Chip active={lens === 'all'} onClick={() => setLens('all')} count={recent.length}>
              {t.lens.all}
            </Chip>
            <Chip active={lens === 'exceptions'} onClick={() => setLens('exceptions')} count={exceptions.length}>
              {t.lens.exceptions}
            </Chip>
            <Chip active={lens === 'flagged'} onClick={() => setLens('flagged')} count={flagged.size}>
              {t.lens.flagged}
            </Chip>
            <AsOfStamp asOf={formatTime(NOW)} source={f.from.diesel} freshness="live" />
          </div>
        }
      >
        <DataTable
          density={density}
          columns={tableColumns}
          rows={visible}
          rowKey={(e) => e.id}
          selectedKey={selected?.id}
          onRowClick={setSelected}
          rail={(e) => ({
            // Provenance alone renders colourless, so it rides alongside the
            // standing of the fill: a fill 18% off benchmark is the theft signal.
            provenance: e.provenance,
            status: flagged.has(e.id) || isShort(e) ? 'attention' : e.provenance === 'proposed' ? 'pending' : 'ready',
          })}
          empty={
            lens === 'flagged' ? (
              <EmptyState fact={t.noneMarked} because={t.howToMark} />
            ) : lens === 'exceptions' ? (
              <EmptyState fact={t.allFine} />
            ) : (
              <EmptyState fact={t.noFills} />
            )
          }
        />
      </Section>

      <div className="h-10" />

      {/* Marking puts an attention rail on the row and nothing else. It does
          not alter the posting, and clearing it only takes the rail away. */}
      <SideSheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        width="form"
        title={selected ? (VEHICLES.find((v) => v.id === selected.vehicleId)?.displayReg ?? t.fill) : ''}
        identifier={selected ? (selected.billNumber ?? selected.id) : undefined}
        {...(sheetStatus ? { status: sheetStatus } : {})}
        // When it was filled is the first section of the sheet, so the header
        // does not repeat it.
        footer={
          selected ? (
            <Button
              variant={flagged.has(selected.id) ? 'secondary' : 'primary'}
              onClick={() => toggleFlag(selected.id)}
            >
              {flagged.has(selected.id) ? t.unmark : t.mark}
            </Button>
          ) : undefined
        }
      >
        {selected ? <FillDetail entry={selected} /> : null}
      </SideSheet>

      {/*
        The margins never block and never refuse — that rule is untouched. This
        asks once, at the moment of writing to the ledger, and only when the fill
        already disagrees with itself. It posts either way; what it buys is that
        nobody can later claim they did not see it. The entry posts as keyed and
        carries a review flag into the supervisor's list.
      */}
      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={commit}
        title={t.confirmTitle}
        confirmLabel={t.confirmLabel}
        consequence={
          <>
            <p>{t.confirmHead(vehicle.displayReg, formatQty(litresN ?? 0, 1), formatINR(amountN ?? 0))}</p>
            {overTank ? <p>{t.confirmOverTank(formatQty(tank, 0))}</p> : null}
            {kmplShort && implied !== null ? (
              <p>{t.confirmMileage(formatQty(implied, 1), formatQty(vehicle.benchmarkKmpl, 1))}</p>
            ) : null}
            {drift !== null && Math.abs(drift) > 1 ? <p>{t.confirmAmount(formatINR(Math.abs(drift)), drift > 0)}</p> : null}
            <p className="mt-2">{t.confirmWillMark}</p>
          </>
        }
      />
    </>
  );
}

/**
 * 44px on a thumb, 34px on a desk.
 *
 * This is the highest-keystroke surface in the product and half of it is keyed
 * standing at a bunk at six in the morning, so the control grows on a touch
 * pointer and shrinks back where a mouse is doing the aiming — the same trade
 * `Button` and `Chip` already make. 16px type on a touch screen also stops a
 * phone zooming into the field when it is tapped.
 */
const CTRL = 'h-11 w-full px-2 text-[16px] [@media(hover:hover)]:h-[34px] [@media(hover:hover)]:text-[14px]';

const FIELD_BOX: React.CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
  borderRadius: 'var(--r-1)',
};

type FuelText = (typeof fuelWords)['en'];
type FleetText = (typeof fleetWords)['en'];

function toNum(v: string): number | null {
  const n = Number.parseFloat(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : null;
}

/** `2026-08-08` → `08-08` — digits read the same in both languages. */
function dayMonth(isoDate: string): string {
  return `${isoDate.slice(8, 10)}-${isoDate.slice(5, 7)}`;
}

function benchmarkOf(vehicleId: string): number {
  return VEHICLES.find((v) => v.id === vehicleId)?.benchmarkKmpl ?? 3.6;
}

/**
 * Tank capacity, read off the chassis class rather than stored per vehicle —
 * the fleet buys three models and every one of them leaves the dealer with the
 * standard tank. It is a ceiling, not a target, and it is the only figure that
 * makes an impossible bill visible.
 */
function tankCapacity(classTonnes: number): number {
  return classTonnes >= 48 ? 365 : classTonnes >= 35 ? 300 : 260;
}

function tankOf(vehicleId: string): number | null {
  const v = VEHICLES.find((x) => x.id === vehicleId);
  return v ? tankCapacity(v.classTonnes) : null;
}

function overTankFill(e: FuelEntry): boolean {
  const cap = tankOf(e.vehicleId);
  return cap !== null && e.litres > cap;
}

function isShort(e: FuelEntry): boolean {
  return e.impliedKmpl !== null && e.impliedKmpl < benchmarkOf(e.vehicleId) * 0.82;
}

function shortfallPct(e: FuelEntry): number {
  if (e.impliedKmpl === null) return 0;
  return Math.round((1 - e.impliedKmpl / benchmarkOf(e.vehicleId)) * 100);
}

/**
 * The full entry, opened over the list.
 *
 * It carries three things the row could not: the litres set against what the
 * tank physically holds, the implied mileage stated as a shortfall rather than
 * as two numbers to subtract in your head, and who is answerable for the
 * figures. Machine-read values keep the hatch here exactly as they do in the
 * table — a value that has never been confirmed does not become confirmed by
 * being looked at more closely.
 *
 * "How entered" is provenance in the operator's words, not the enum's: who is
 * answerable for the number. Hand-typed from the paper bill; read by Linck off
 * a photograph and not yet confirmed; read and then confirmed figure by figure;
 * read and then corrected by hand; or posted straight from the bunk terminal.
 */
function FillDetail({ entry }: { entry: FuelEntry }) {
  const t = useWords(fuelWords);
  const f = useWords(fleetWords);
  const s = t.sheet;
  const vehicle = VEHICLES.find((v) => v.id === entry.vehicleId);
  const driver = DRIVERS.find((d) => d.id === entry.driverId);
  const cap = tankOf(entry.vehicleId);
  const benchmark = benchmarkOf(entry.vehicleId);
  const machineRead = entry.provenance !== 'human' && entry.provenance !== 'device';
  const confirmed = entry.provenance === 'confirmed' || entry.provenance === 'overridden';
  const over = cap !== null && entry.litres > cap;
  const expected = entry.litres * Number.parseFloat(entry.ratePerLitre);
  const drift = Number.parseFloat(entry.amount) - expected;

  const asRead = (node: React.ReactNode) =>
    machineRead ? (
      <Provisional confirmed={confirmed} overridden={entry.provenance === 'overridden'}>
        {node}
      </Provisional>
    ) : (
      node
    );

  return (
    <>
      <SheetSection caption={s.fill}>
        <DetailGrid>
          <Detail label={s.vehicle}>
            <Stacked primary={<IdCell>{vehicle?.displayReg}</IdCell>} secondary={vehicle?.model} />
          </Detail>
          <Detail label={s.driver}>{driver ? driver.name : <Dash />}</Detail>
          <Detail label={s.date}>
            {formatDate(entry.date)} · {formatTime(entry.date)}
          </Detail>
          <Detail label={s.where}>{entry.source === 'own_bunk' ? t.ownBunk : t.outsideBunk}</Detail>
          <Detail label={s.billNumber}>{entry.billNumber ? asRead(<IdCell>{entry.billNumber}</IdCell>) : <Dash />}</Detail>
          <Detail label={s.fullTank}>{entry.fullTank ? s.yes : s.partFill}</Detail>
          <Detail label={s.entered}>{t.provenance[entry.provenance]}</Detail>
        </DetailGrid>
        {/* Bought outside with no bill number: it cannot be set against the
            vendor ledger until somebody produces the paper. */}
        {entry.source === 'outside_bunk' && entry.billNumber === null ? <Note>{s.noBillNumber}</Note> : null}
      </SheetSection>

      <SheetSection caption={s.bill}>
        <DetailGrid>
          <Detail label={s.litres}>{asRead(<QuantityCell value={entry.litres} decimals={1} uom={f.litres} />)}</Detail>
          <Detail label={s.rate}>{asRead(<MoneyCell value={entry.ratePerLitre} accounting={false} />)}</Detail>
          <Detail label={s.amount}>{asRead(<MoneyCell value={entry.amount} accounting={false} />)}</Detail>
          <Detail label={s.litresTimesRate}>
            <MoneyCell value={expected.toFixed(2)} accounting={false} />
          </Detail>
        </DetailGrid>
        {/* Inside a rupee is rounding at the pump. Beyond it, either the pump
            gave a discount nobody wrote down, or one of the three figures is
            wrong. */}
        <Note>{Math.abs(drift) <= 1 ? s.amountMatches : s.amountOff(formatINR(Math.abs(drift)), drift > 0)}</Note>
      </SheetSection>

      <SheetSection caption={s.tank}>
        {cap === null ? (
          // The vehicle is no longer on the roster, so its tank cannot be looked up.
          <Note>{s.tankUnknown}</Note>
        ) : (
          <>
            <ProportionBar
              height={22}
              summary={
                over
                  ? s.tankOverSummary(formatQty(entry.litres, 1), formatQty(cap, 0), formatQty(entry.litres - cap, 1))
                  : s.tankOkSummary(formatQty(entry.litres, 1), formatQty(cap, 0), formatQty(cap - entry.litres, 1))
              }
              segments={
                over
                  ? [
                      { label: s.tankPart, value: cap, tone: 'var(--chart-2)' },
                      { label: s.extraPart, value: entry.litres - cap, tone: 'var(--status-critical)' },
                    ]
                  : [
                      { label: s.thisFill, value: entry.litres, tone: 'var(--chart-2)' },
                      { label: s.spaceLeft, value: cap - entry.litres, tone: 'var(--surface-sunken)' },
                    ]
              }
            />
            {/* Over the tank: either two lorries were filled on one bill, or
                the rest left the bunk in a can. */}
            <Note>{over ? s.tankOver(formatQty(entry.litres - cap, 1)) : s.tankOk(formatQty(cap, 0))}</Note>
          </>
        )}
      </SheetSection>

      <SheetSection caption={s.mileage}>
        <DetailGrid>
          <Detail label={s.kmReading}>
            <QuantityCell value={entry.odometerKm} decimals={0} uom={f.km} />
          </Detail>
          <Detail label={s.mileage}>
            {entry.impliedKmpl === null ? <Dash /> : <QuantityCell value={entry.impliedKmpl} decimals={2} uom={f.kmpl} />}
          </Detail>
          <Detail label={s.normalForModel}>
            <QuantityCell value={benchmark} decimals={1} uom={f.kmpl} />
          </Detail>
          <Detail label={s.vsNormal}>
            {entry.impliedKmpl === null ? (
              <Dash />
            ) : (
              <span style={isShort(entry) ? { color: 'var(--status-attention)' } : undefined}>
                {shortfallPct(entry) > 0 ? s.pctLow(shortfallPct(entry)) : s.pctBetter(-shortfallPct(entry))}
              </span>
            )}
          </Detail>
        </DetailGrid>
        {/* More than 18% off benchmark is where this stops being a hill and a
            heavy load, and starts being worth a conversation with the driver.
            Inside it is ordinary variation between a loaded run and an empty one. */}
        <Note>{entry.impliedKmpl === null ? s.noMileage : isShort(entry) ? s.tooLow : s.fine}</Note>
      </SheetSection>
    </>
  );
}

/**
 * A field with a permanently reserved message slot and a permanently reserved
 * margin gutter. Both exist whether or not there is anything to put in them,
 * because a line that appears mid-keystroke and pushes the next field down
 * costs the clerk the digit they were halfway through typing.
 *
 * On a phone there is no right margin to speak of — 186px of gutter beside a
 * 44px control leaves the control unusable — so the derived reading drops
 * UNDER the field instead of beside it. It does not disappear: it is the whole
 * reason this screen exists. The reservation moves with it, from a fixed width
 * to a fixed two-line height, so the value the clerk is mid-way through typing
 * still never moves under the cursor when the reading appears.
 */
function Field({
  label,
  children,
  margin,
  error,
  help,
}: {
  label: string;
  children: React.ReactNode;
  margin?: React.ReactNode;
  error?: string | undefined;
  help?: string | undefined;
}) {
  // `margin` is passed as an expression that evaluates to null most of the
  // time, so the prop being PRESENT — not truthy — is what says this field
  // will one day have something to say and needs the slot held open.
  const gutter = margin === undefined ? 'hidden md:block' : 'min-h-[26px] md:min-h-0';

  return (
    <div className="mb-2">
      <label className="mb-1 block text-[13px]" style={{ color: 'var(--text-secondary)' }}>{label}</label>
      <div className="relative flex flex-col gap-1 pl-2 md:flex-row md:items-center md:gap-3">
        {/* The field itself never turns red — the typed value has to stay
            readable while it is being corrected. The rail carries the alarm. */}
        {error ? <Rail status="critical" /> : null}
        <div className="min-w-0 flex-1">{children}</div>
        <div className={`${gutter} md:w-[186px] md:shrink-0`}>{margin}</div>
      </div>
      <div className="min-h-[17px] pl-2 pt-1">
        {error ? (
          <span className="text-[12px]" style={{ color: 'var(--status-critical)' }}>{error}</span>
        ) : help ? (
          <span className="font-serif text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>{help}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The live derived reading, in the field's right margin. Tertiary until it
 * disagrees. Right-aligned against the numeral it is talking about on a wide
 * screen; left-aligned below the field on a phone, where it is a wrapping
 * sentence rather than a figure in a gutter.
 */
function Margin({ children, tone = 'quiet' }: { children: React.ReactNode; tone?: 'quiet' | 'attention' }) {
  return (
    <span
      className="num block text-[11px] leading-tight tabular-nums md:text-right"
      style={{ color: tone === 'attention' ? 'var(--status-attention)' : 'var(--text-tertiary)' }}
    >
      {children}
    </span>
  );
}

/**
 * Machine-read values keep FULL CONTRAST and wear the hatch until a person
 * confirms. Dimming them is the obvious move and the wrong one — the clerk's
 * whole job here is reading that figure against a photograph of a paper bill.
 */
function Wrap({ on, confirmed, children }: { on: boolean; confirmed: boolean; children: React.ReactNode }) {
  if (!on) return <>{children}</>;
  return (
    <Provisional confirmed={confirmed} className="w-full">
      <span className="min-w-0 flex-1">{children}</span>
    </Provisional>
  );
}

function columnsFor(t: FuelText, f: FleetText): Column<FuelEntry>[] {
  return [
    { key: 'date', header: t.col.date, sticky: true, width: 112, render: (e) => <Stacked primary={formatDate(e.date)} secondary={formatTime(e.date)} /> },
    {
      key: 'vehicle', header: t.col.vehicle, type: 'id', width: 168,
      render: (e) => {
        const v = VEHICLES.find((x) => x.id === e.vehicleId);
        return v ? <Stacked primary={<IdCell>{v.displayReg}</IdCell>} secondary={v.model} /> : null;
      },
    },
    { key: 'driver', header: t.col.driver, width: 148, render: (e) => DRIVERS.find((d) => d.id === e.driverId)?.name ?? null },
    { key: 'litres', header: t.col.litres, type: 'num', width: 90, render: (e) => <QuantityCell value={e.litres} decimals={1} /> },
    { key: 'rate', header: t.col.rate, unit: '₹', type: 'money', width: 86, render: (e) => <MoneyCell value={e.ratePerLitre} /> },
    {
      key: 'amount', header: t.col.amount, unit: '₹', type: 'money', width: 118,
      // Anything a machine read stays hatched until a second pair of eyes agrees.
      render: (e) =>
        e.provenance === 'human' || e.provenance === 'device' ? (
          <MoneyCell value={e.amount} />
        ) : (
          <Provisional confirmed={e.provenance !== 'proposed'} overridden={e.provenance === 'overridden'}>
            <MoneyCell value={e.amount} />
          </Provisional>
        ),
    },
    { key: 'odometer', header: t.col.km, type: 'num', width: 120, render: (e) => <QuantityCell value={e.odometerKm} decimals={0} /> },
    {
      key: 'kmpl', header: t.col.mileage, unit: f.kmpl, type: 'num', width: 130,
      render: (e) => (
        <Stacked
          primary={<span style={isShort(e) ? { color: 'var(--status-attention)' } : undefined}><QuantityCell value={e.impliedKmpl} decimals={2} /></span>}
          secondary={t.normalAt(formatQty(benchmarkOf(e.vehicleId), 1))}
        />
      ),
    },
    {
      key: 'source', header: t.col.where, width: 158,
      render: (e) => (
        <Stacked
          primary={e.source === 'own_bunk' ? t.ownBunk : t.outsideBunk}
          secondary={e.billNumber ? <IdCell>{e.billNumber}</IdCell> : undefined}
        />
      ),
    },
  ];
}
