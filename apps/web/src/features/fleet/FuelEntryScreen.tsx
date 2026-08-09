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
import { useApp } from '../../shell/store.js';

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
 * The single hard stop is a meter running backwards, and even that keeps the
 * typed value legible: a critical rail on the field's left edge and a message
 * in a RESERVED slot, so nothing under the cursor ever jumps.
 *
 * Two charts sit alongside, and neither of them is decoration. The mileage
 * trend re-draws the moment the operator picks a different tipper, so the
 * question "is this fill odd for THIS lorry" is answered before the litres are
 * typed rather than after. The litres bar carries the tank capacity as a tick,
 * which is the only way an impossible fill — 432 L into a 300 L tank — is
 * visible at all; it is the theft that hides best, because every individual
 * number on the bill is plausible.
 */
export function FuelEntryScreen() {
  const { siteScope, density } = useApp();
  // A bar is a click target here — 20px of it is a miss on a thumb, and no CSS
  // reaches inside the SVG to say so.
  const touch = useIsTouch();
  const fleet = vehiclesForSite(siteScope);
  const crew = siteScope ? DRIVERS.filter((d) => d.siteId === siteScope) : DRIVERS;

  const bill = EXTRACTION_JOBS.find((j) => j.documentType === 'diesel_bill');
  const billValue = (key: string) => bill?.fields.find((f) => f.key === key)?.value ?? '';

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
  // rewrites a posted row.
  const [flagged, setFlagged] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selected, setSelected] = useState<FuelEntry | null>(null);
  const [lens, setLens] = useState<'all' | 'exceptions' | 'flagged'>('all');
  const [confirming, setConfirming] = useState(false);

  const vehicle = fleet.find((v) => v.id === vehicleId) ?? fleet[0];
  if (!vehicle) {
    return (
      <>
        <PageHeader eyebrow="Fleet · Diesel" title="Record a fill" />
        <EmptyState fact="No vehicles at this site." because="Widen the site scope to key a fill against a tipper." />
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

  // Litres × rate must reconcile against the typed amount inside ₹1.
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
  const defPct = defN !== null && litresN ? (defN / litresN) * 100 : null;
  const overTank = litresN !== null && litresN > tank;

  const scoped = new Set(fleet.map((v) => v.id));
  const recent = entries.filter((e) => scoped.has(e.vehicleId)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);

  const exceptions = recent.filter((e) => isShort(e) || overTankFill(e));
  const visible =
    lens === 'flagged' ? recent.filter((e) => flagged.has(e.id)) : lens === 'exceptions' ? exceptions : recent;

  /* ------------------------------------------------------------- the charts */

  // Redrawn from the picked vehicle, not from a snapshot — changing the select
  // above changes this line, which is the whole point of it being here.
  const mileageSeries = mileageFor(vehicle.id).map((m) => ({ label: m.label, value: m.kmpl }));
  const kmplFloor = vehicle.benchmarkKmpl * 0.82;
  const belowFloor = mileageSeries.filter((p) => p.value < kmplFloor).length;
  const latestKmpl = mileageSeries[mileageSeries.length - 1]?.value ?? null;

  // Ten bars, most recent at the top, each with its own tank as the tick — the
  // 48-tonner and the 25-tonner do not share a ceiling and averaging them hides
  // exactly the fill worth arguing about.
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
        date: `${date}T${formatTime(NOW)}:00Z`,
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

  const hatch = prefilled && !inkDry;
  // Inside the hatch the control drops its own box, so the texture is unbroken
  // and the extracted figure still reads at full contrast against the photo.
  const boxed: React.CSSProperties = hatch ? { ...FIELD_BOX, background: 'transparent', boxShadow: 'none' } : FIELD_BOX;

  const tableColumns: Column<FuelEntry>[] = [
    ...columns,
    {
      key: 'standing',
      header: 'Standing',
      type: 'status',
      width: 156,
      group: 'The evidence',
      render: (e) => {
        if (flagged.has(e.id)) return <StatusStamp status="attention" label="Flagged" />;
        if (overTankFill(e)) return <StatusStamp status="critical" label="Over tank" />;
        if (isShort(e)) return <StatusStamp status="attention" label="Off benchmark" severity={`-${shortfallPct(e)}%`} />;
        if (e.provenance === 'proposed') return <StatusStamp status="pending" label="Unconfirmed" provisional />;
        return <StatusStamp status="ready" label="Clean" />;
      },
    },
  ];

  const sheetStatus = selected
    ? flagged.has(selected.id)
      ? { family: 'attention' as const, label: 'Flagged for review' }
      : overTankFill(selected)
        ? { family: 'critical' as const, label: 'Over tank' }
        : isShort(selected)
          ? { family: 'attention' as const, label: 'Off benchmark', severity: `-${shortfallPct(selected)}%` }
          : selected.provenance === 'proposed'
            ? { family: 'pending' as const, label: 'Unconfirmed', provisional: true }
            : { family: 'ready' as const, label: 'Clean' }
    : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Fleet · Diesel"
        title="Record a fill"
        meta={<AsOfStamp asOf={formatTime(NOW)} source="v_fuel_ledger" freshness="live" />}
        actions={
          <Button variant="primary" onClick={post} disabled={odoBackwards || !litresN || !amountN}>
            Post and key the next
          </Button>
        }
      />

      {bill && !prefilled && !dismissed ? (
        <div className="px-6 pt-4">
          <SuggestionStrip onApply={applyBill} onDismiss={() => setDismissed(true)} applyLabel="Prefill from the bill">
            A diesel bill photographed by {bill.capturedBy} at {formatTime(bill.capturedAt)} is waiting against{' '}
            {billValue('vehicle')} — {billValue('litres')} L at ₹{billValue('rate')}. The odometer on that photo read at
            the lowest confidence and is not carried across.
          </SuggestionStrip>
        </div>
      ) : null}

      <Section
        caption="One fill, one vehicle, one meter reading"
        title="New entry"
        actions={hatch ? <Button variant="primary" onClick={() => setInkDry(true)}>Confirm all four</Button> : null}
      >
        <div className="grid grid-cols-1 gap-x-10 gap-y-8 px-6 pt-1 xl:grid-cols-[minmax(0,560px)_minmax(0,1fr)] xl:gap-y-0">
          <div className="w-full max-w-[560px]">
            <Field label="Vehicle">
              <select value={vehicle.id} className={CTRL} style={FIELD_BOX} onChange={(e) => { setVehicleId(e.target.value); setDriverPick('auto'); }}>
                {fleet.map((v) => <option key={v.id} value={v.id}>{v.displayReg} · {v.model}</option>)}
              </select>
            </Field>

            <Field
              label="Driver"
              help={driverPick === 'auto' ? 'Taken from the vehicle roster — change it if someone else took the tipper out.' : 'Overridden by hand.'}
            >
              <select value={driverPick === 'auto' ? (vehicle.driverId ?? '') : driverPick} className={CTRL} style={FIELD_BOX} onChange={(e) => setDriverPick(e.target.value)}>
                <option value="">No driver recorded</option>
                {crew.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>

            <Field label="Date">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={CTRL} style={FIELD_BOX} />
            </Field>

            <Field
              label="Odometer"
              margin={
                !fullTank ? (
                  <Margin>km/l not computed on a top-up</Margin>
                ) : implied !== null ? (
                  <Margin tone={kmplShort ? 'attention' : 'quiet'}>
                    This fill implies {formatQty(implied, 1)} km/l against a {formatQty(vehicle.benchmarkKmpl, 1)} benchmark
                  </Margin>
                ) : prefilled ? (
                  <Margin>
                    <span className="inline-flex items-center gap-1"><ConfidenceMeter level={1} /> read poorly off the photo</span>
                  </Margin>
                ) : null
              }
              error={odoBackwards ? `Below the last reading of ${formatQty(vehicle.odometerKm, 0)} km. A meter does not run backwards — check the dash, or raise a meter-change note.` : undefined}
              help={lastFull ? `Last full tank ${formatDate(lastFull.date)} at ${formatQty(lastFull.odometerKm, 0)} km.` : undefined}
            >
              <input inputMode="decimal" value={odometer} placeholder={formatQty(vehicle.odometerKm, 0)} className={`${CTRL} text-right`} style={FIELD_BOX} onChange={(e) => setOdometer(e.target.value)} />
            </Field>

            <Field
              label="Litres"
              margin={
                overTank ? (
                  <Margin tone="attention">
                    {formatQty(litresN ?? 0, 0)} L into a {formatQty(tank, 0)} L tank
                  </Margin>
                ) : odoDelta ? (
                  <Margin>{formatQty(odoDelta, 0)} km since that tank</Margin>
                ) : null
              }
              help={overTank ? 'More diesel than the tank holds. Either two lorries were filled on one bill, or some of it left in a can.' : undefined}
            >
              <Wrap on={prefilled} confirmed={inkDry}>
                <input inputMode="decimal" value={litres} onChange={(e) => setLitres(e.target.value)} className={`${CTRL} text-right`} style={boxed} />
              </Wrap>
            </Field>

            <Field label="Rate per litre ₹" margin={source === 'own_bunk' && !prefilled ? <Margin>Today&rsquo;s own-bunk issue rate</Margin> : null}>
              <Wrap on={prefilled} confirmed={inkDry}>
                <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className={`${CTRL} text-right`} style={boxed} />
              </Wrap>
            </Field>

            <Field
              label="Amount ₹"
              margin={
                drift === null ? null : Math.abs(drift) <= 1 ? <Margin>Reconciles with litres × rate</Margin> : (
                  <Margin tone="attention">{formatINR(Math.abs(drift))} {drift > 0 ? 'over' : 'under'} litres × rate, which comes to {formatINR(expected ?? 0)}</Margin>
                )
              }
            >
              <Wrap on={prefilled} confirmed={inkDry}>
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${CTRL} text-right`} style={boxed} />
              </Wrap>
            </Field>

            <Field
              label="Tank filled to the brim"
              help={fullTank
                ? 'Full tank to full tank is the only honest mileage. Leave it ticked whenever the nozzle cut off by itself.'
                : 'A part fill records the litres and the money but yields no km/l — the implied figure is held back rather than guessed.'}
            >
              <label
                className="flex h-11 cursor-pointer items-center gap-2 text-[14px] [@media(hover:hover)]:h-[34px]"
                style={{ color: 'var(--text-primary)' }}
              >
                <input
                  type="checkbox"
                  checked={fullTank}
                  onChange={(e) => setFullTank(e.target.checked)}
                  className="h-5 w-5 [@media(hover:hover)]:h-4 [@media(hover:hover)]:w-4"
                  style={{ accentColor: 'var(--brand)' }}
                />
                Full tank
              </label>
            </Field>

            <Field label="Source">
              <select value={source} onChange={(e) => setSource(e.target.value as FuelEntry['source'])} className={CTRL} style={FIELD_BOX}>
                <option value="own_bunk">Own bunk — issued from site stock</option>
                <option value="outside_bunk">Outside bunk — bought on the road</option>
              </select>
            </Field>

            {source === 'outside_bunk' ? (
              <Field label="Bill number" help="An outside fill without a bill number cannot be set against the vendor ledger.">
                <Wrap on={prefilled} confirmed={inkDry}>
                  <input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} className={`font-id ${CTRL}`} style={boxed} />
                </Wrap>
              </Field>
            ) : null}

            <Field
              label="DEF / AdBlue litres"
              margin={defPct === null ? null : (
                <Margin tone={defPct > 6 || defPct < 3 ? 'attention' : 'quiet'}>{formatQty(defPct, 1)}% of the diesel — a BS-VI tipper runs 3 to 6%</Margin>
              )}
              help="Blank means nobody topped it up. Zero means somebody looked and it was already full."
            >
              <input inputMode="decimal" value={def} onChange={(e) => setDef(e.target.value)} className={`${CTRL} text-right`} style={FIELD_BOX} />
            </Field>
          </div>

          {/* The picked vehicle's own history, so the clerk is comparing this
              fill against this lorry rather than against the fleet average. */}
          <div className="min-w-0 pt-1">
            <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
              Twenty-eight days, tank to tank
            </p>
            <h3 className="font-serif mb-1 text-[18px]" style={{ color: 'var(--text-primary)' }}>
              {vehicle.displayReg} on mileage
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
                      summary={`${vehicle.displayReg} mileage over ${
                        mileageSeries.length
                      } full-tank fills, latest ${formatQty(
                        latestKmpl,
                        2,
                      )} km/l against a ${formatQty(vehicle.benchmarkKmpl, 1)} benchmark; ${belowFloor} reading${
                        belowFloor === 1 ? '' : 's'
                      } below ${formatQty(kmplFloor, 2)} km/l.`}
                      seriesLabel={vehicle.displayReg}
                      benchmark={{
                        value: vehicle.benchmarkKmpl,
                        label: `${formatQty(vehicle.benchmarkKmpl, 1)} benchmark`,
                      }}
                      flagBelow={kmplFloor}
                      height={186}
                      format={(v) => formatQty(v, 1)}
                    />
                  </div>
                </div>
                <ChartCaption>
                  Only a full tank to a full tank yields a reading, so the line is sparse by construction — six to nine
                  points a month, never thirty. A steady slide is what a leaking return line or a nightly can of diesel
                  looks like; one bad point is usually a hill and a heavy load.
                </ChartCaption>
              </>
            ) : (
              <Note>
                No tank-to-tank readings for this vehicle yet. Mileage appears once two full-tank fills have been keyed
                against the same meter.
              </Note>
            )}

            <div className="mt-6">
              <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                Last ten fills at this site
              </p>
              <h3 className="font-serif mb-1 text-[18px]" style={{ color: 'var(--text-primary)' }}>
                Litres against the tank
              </h3>
              {/* The label reserve is 178px and the value gutter another 64, so
                  below a tablet the bars themselves would have nothing left to
                  say. The chart keeps its real measure and scrolls inside its
                  own box rather than pushing the page sideways. */}
              <div className="overflow-x-auto">
                <div className="min-w-[460px]">
                  <BarChart
                    summary={`Last ${fillBars.length} fills by litres against each vehicle's tank capacity; ${overFills} fill${
                      overFills === 1 ? '' : 's'
                    } larger than the tank it went into.`}
                    data={fillBars}
                    format={(v) => `${formatQty(v, 0)} L`}
                    barHeight={touch ? 34 : 20}
                    labelWidth={178}
                    onSelect={(d) => {
                      const hit = barOf.get(d.label);
                      if (hit) setSelected(hit);
                    }}
                  />
                </div>
              </div>
              <ChartCaption>
                The dashed tick is what the tank holds. A bar past it did not all go into that lorry — every figure on
                such a bill is individually plausible, which is why this is the one that has to be drawn. Click a bar to
                open the fill.
              </ChartCaption>
            </div>
          </div>
        </div>
      </Section>

      <Section
        caption="What this tipper and this bunk have already done"
        title="Recent fills"
        actions={
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <Chip active={lens === 'all'} onClick={() => setLens('all')} count={recent.length}>
              All
            </Chip>
            <Chip active={lens === 'exceptions'} onClick={() => setLens('exceptions')} count={exceptions.length}>
              Off benchmark or over tank
            </Chip>
            <Chip active={lens === 'flagged'} onClick={() => setLens('flagged')} count={flagged.size}>
              Flagged
            </Chip>
            <AsOfStamp asOf={formatTime(NOW)} source="v_fuel_entry" freshness="live" />
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
              <EmptyState fact="Nothing is flagged for review." because="Open a fill and flag it to put it on the supervisor's list." />
            ) : lens === 'exceptions' ? (
              <EmptyState fact="No fill here reads as an exception." because="Every recent fill sits inside its tank and within 18% of its benchmark." />
            ) : (
              <EmptyState fact="No fills recorded at this site yet." because="The first entry keyed above lands here." />
            )
          }
        />
      </Section>

      <div className="h-10" />

      <SideSheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        width="form"
        title={selected ? (VEHICLES.find((v) => v.id === selected.vehicleId)?.displayReg ?? 'Fill') : ''}
        identifier={selected ? (selected.billNumber ?? selected.id) : undefined}
        {...(sheetStatus ? { status: sheetStatus } : {})}
        revision={selected ? `FILLED ${formatDate(selected.date)} ${formatTime(selected.date)}` : undefined}
        footer={
          selected ? (
            <>
              <Button
                variant={flagged.has(selected.id) ? 'secondary' : 'primary'}
                onClick={() => toggleFlag(selected.id)}
              >
                {flagged.has(selected.id) ? 'Clear the review flag' : 'Flag this fill for review'}
              </Button>
              {/* The sheet footer is a fixed 56px bar. Beside a 44px touch
                  button on a 375px panel this sentence has nowhere to wrap, so
                  on a phone it moves into the body of the sheet instead —
                  FillDetail carries the same words under "Where these figures
                  came from". */}
              <span className="hidden font-serif text-[12px] italic md:inline" style={{ color: 'var(--text-tertiary)' }}>
                {flagged.has(selected.id)
                  ? 'The row carries an attention rail until somebody clears it.'
                  : 'Puts an attention rail on the row and nothing else. It does not alter the posting.'}
              </span>
            </>
          ) : undefined
        }
      >
        {selected ? <FillDetail entry={selected} flagged={flagged.has(selected.id)} /> : null}
      </SideSheet>

      {/*
        The margins never block and never refuse — that rule is untouched. This
        asks once, at the moment of writing to the ledger, and only when the fill
        already disagrees with itself. It posts either way; what it buys is that
        nobody can later claim they did not see it.
      */}
      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={commit}
        title="Post a fill that reads as an exception"
        confirmLabel="Post it and flag it"
        consequence={
          <>
            {formatQty(litresN ?? 0, 1)} L against {vehicle.displayReg} for {formatINR(amountN ?? 0)}.
            {overTank ? ` That is more than the ${formatQty(tank, 0)} L this tank holds.` : ''}
            {kmplShort && implied !== null
              ? ` It implies ${formatQty(implied, 1)} km/l against a ${formatQty(vehicle.benchmarkKmpl, 1)} benchmark.`
              : ''}
            {drift !== null && Math.abs(drift) > 1
              ? ` The amount is ${formatINR(Math.abs(drift))} ${drift > 0 ? 'over' : 'under'} litres × rate.`
              : ''}{' '}
            The entry posts as keyed and carries a review flag into the supervisor&rsquo;s list.
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
 * `Button` and `Chip` already make.
 */
const CTRL = 'h-11 w-full px-2 text-[14px] [@media(hover:hover)]:h-[34px]';

const FIELD_BOX: React.CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
  borderRadius: 'var(--r-1)',
};

function toNum(v: string): number | null {
  const n = Number.parseFloat(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : null;
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
 * Provenance in the operator's words, not the enum's.
 *
 * "proposed" means nothing to a clerk at a bunk. What the row is really saying
 * is who is answerable for the number, and that is what gets written out.
 */
const PROVENANCE_SENTENCE: Record<FuelEntry['provenance'], string> = {
  human: 'Hand-typed from the paper bill. A person is answerable for every figure on it.',
  proposed: 'Read by Linck off a photograph of the bill and not yet confirmed by anybody.',
  confirmed: 'Read by Linck off a photograph and then confirmed, figure by figure, by a person.',
  overridden: 'Read by Linck and then corrected by hand — the machine had it wrong.',
  device: 'Posted straight from the bunk terminal. No hand touched it.',
};

const PROVENANCE_SHORT: Record<FuelEntry['provenance'], string> = {
  human: 'Hand-typed',
  proposed: 'Read by Linck, unconfirmed',
  confirmed: 'Read by Linck, confirmed',
  overridden: 'Corrected by hand',
  device: 'From the bunk terminal',
};

/**
 * The full entry, opened over the list.
 *
 * It carries three things the row could not: the litres set against what the
 * tank physically holds, the implied mileage stated as a shortfall rather than
 * as two numbers to subtract in your head, and who is answerable for the
 * figures. Machine-read values keep the hatch here exactly as they do in the
 * table — a value that has never been confirmed does not become confirmed by
 * being looked at more closely.
 */
function FillDetail({ entry, flagged }: { entry: FuelEntry; flagged: boolean }) {
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
      <SheetSection caption="The fill">
        <DetailGrid>
          <Detail label="Vehicle">
            <Stacked primary={<IdCell>{vehicle?.displayReg}</IdCell>} secondary={vehicle?.model} />
          </Detail>
          <Detail label="Driver">{driver ? driver.name : <Dash />}</Detail>
          <Detail label="Filled">
            {formatDate(entry.date)} · {formatTime(entry.date)}
          </Detail>
          <Detail label="Source">{entry.source === 'own_bunk' ? 'Own bunk — site stock' : 'Outside bunk — on the road'}</Detail>
          <Detail label="Bill number">{entry.billNumber ? asRead(<IdCell>{entry.billNumber}</IdCell>) : <Dash />}</Detail>
          <Detail label="Tank filled to the brim">{entry.fullTank ? 'Yes — nozzle cut off' : 'No — a top-up'}</Detail>
        </DetailGrid>
        {entry.source === 'outside_bunk' && entry.billNumber === null ? (
          <Note>
            Bought outside with no bill number recorded. It cannot be set against the vendor ledger until somebody
            produces the paper.
          </Note>
        ) : null}
      </SheetSection>

      <SheetSection caption="The bill">
        <DetailGrid>
          <Detail label="Litres">{asRead(<QuantityCell value={entry.litres} decimals={1} uom="L" />)}</Detail>
          <Detail label="Rate per litre">{asRead(<MoneyCell value={entry.ratePerLitre} accounting={false} />)}</Detail>
          <Detail label="Amount">{asRead(<MoneyCell value={entry.amount} accounting={false} />)}</Detail>
          <Detail label="Litres × rate">
            <MoneyCell value={expected.toFixed(2)} accounting={false} />
          </Detail>
        </DetailGrid>
        <Note>
          {Math.abs(drift) <= 1
            ? 'Amount reconciles with litres × rate inside a rupee — rounding at the pump, nothing more.'
            : `${formatINR(Math.abs(drift))} ${drift > 0 ? 'over' : 'under'} litres × rate. Either the pump gave a discount nobody wrote down, or one of the three figures is wrong.`}
        </Note>
      </SheetSection>

      <SheetSection caption="Against the tank">
        {cap === null ? (
          <Note>This vehicle is no longer on the roster, so its tank capacity cannot be looked up.</Note>
        ) : (
          <>
            <ProportionBar
              height={22}
              summary={
                over
                  ? `${formatQty(entry.litres, 1)} litres billed into a ${formatQty(cap, 0)} litre tank — ${formatQty(
                      entry.litres - cap,
                      1,
                    )} litres more than it holds.`
                  : `${formatQty(entry.litres, 1)} litres into a ${formatQty(cap, 0)} litre tank, leaving ${formatQty(
                      cap - entry.litres,
                      1,
                    )} litres of headroom.`
              }
              segments={
                over
                  ? [
                      { label: 'Tank holds', value: cap, tone: 'var(--chart-2)' },
                      { label: 'Beyond the tank', value: entry.litres - cap, tone: 'var(--status-critical)' },
                    ]
                  : [
                      { label: 'This fill', value: entry.litres, tone: 'var(--chart-2)' },
                      { label: 'Headroom', value: cap - entry.litres, tone: 'var(--surface-sunken)' },
                    ]
              }
            />
            <Note>
              {over
                ? `${formatQty(entry.litres - cap, 1)} litres more than the tank holds. Either two lorries were filled on one bill, or the rest left the bunk in a can.`
                : `Sits inside the ${formatQty(cap, 0)} litre tank, so the quantity itself is at least possible.`}
            </Note>
          </>
        )}
      </SheetSection>

      <SheetSection caption="The evidence">
        <DetailGrid>
          <Detail label="Odometer at the fill">
            <QuantityCell value={entry.odometerKm} decimals={0} uom="km" />
          </Detail>
          <Detail label="Implied mileage">
            {entry.impliedKmpl === null ? <Dash /> : <QuantityCell value={entry.impliedKmpl} decimals={2} uom="km/l" />}
          </Detail>
          <Detail label="Benchmark for this model">
            <QuantityCell value={benchmark} decimals={1} uom="km/l" />
          </Detail>
          <Detail label="Against benchmark">
            {entry.impliedKmpl === null ? (
              <Dash />
            ) : (
              <span style={isShort(entry) ? { color: 'var(--status-attention)' } : undefined}>
                {shortfallPct(entry) > 0 ? `${shortfallPct(entry)}% short` : `${-shortfallPct(entry)}% ahead`}
              </span>
            )}
          </Detail>
        </DetailGrid>
        <Note>
          {entry.impliedKmpl === null
            ? 'A part fill yields no mileage. The litres and the money are recorded; the km/l is held back rather than guessed.'
            : isShort(entry)
              ? 'More than 18% off benchmark. That is the threshold at which this stops being a hill and a heavy load, and starts being worth a conversation with the driver.'
              : 'Within 18% of benchmark, which is ordinary variation between a loaded run and an empty one.'}
        </Note>
      </SheetSection>

      <SheetSection caption="Where these figures came from">
        <Detail label="Provenance">{PROVENANCE_SHORT[entry.provenance]}</Detail>
        <Note>{PROVENANCE_SENTENCE[entry.provenance]}</Note>
        {flagged ? (
          <div className="mt-3">
            <Note>Flagged for review. It stays on the supervisor&rsquo;s list until somebody clears it.</Note>
          </div>
        ) : null}
        {/* What the footer button does, said where there is room to say it —
            the footer bar itself is 56px and holds only the button on a phone. */}
        <div className="mt-3 md:hidden">
          <Note>
            {flagged
              ? 'Clearing the flag leaves the posting exactly as it is; only the attention rail on the row goes away.'
              : 'Flagging puts an attention rail on the row and nothing else. It does not alter the posting.'}
          </Note>
        </div>
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
      <label className="mb-1 block text-[12px]" style={{ color: 'var(--text-secondary)' }}>{label}</label>
      <div className="relative flex flex-col gap-1 pl-2 md:flex-row md:items-center md:gap-3">
        {/* The field itself never turns red — the typed value has to stay
            readable while it is being corrected. The rail carries the alarm. */}
        {error ? <Rail status="critical" /> : null}
        <div className="min-w-0 flex-1">{children}</div>
        <div className={`${gutter} md:w-[186px] md:shrink-0`}>{margin}</div>
      </div>
      <div className="min-h-[17px] pl-2 pt-1">
        {error ? (
          <span className="text-[11px]" style={{ color: 'var(--status-critical)' }}>{error}</span>
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

const columns: Column<FuelEntry>[] = [
  { key: 'date', header: 'Filled', sticky: true, width: 112, group: 'Entry', render: (e) => <Stacked primary={formatDate(e.date)} secondary={formatTime(e.date)} /> },
  {
    key: 'vehicle', header: 'Vehicle', type: 'id', width: 168, group: 'Entry',
    render: (e) => {
      const v = VEHICLES.find((x) => x.id === e.vehicleId);
      return v ? <Stacked primary={<IdCell>{v.displayReg}</IdCell>} secondary={v.model} /> : null;
    },
  },
  { key: 'driver', header: 'Driver', width: 148, group: 'Entry', render: (e) => DRIVERS.find((d) => d.id === e.driverId)?.name ?? null },
  { key: 'litres', header: 'Litres', unit: 'L', type: 'num', width: 90, group: 'The bill', render: (e) => <QuantityCell value={e.litres} decimals={1} /> },
  { key: 'rate', header: 'Rate', unit: '₹', type: 'money', width: 86, group: 'The bill', render: (e) => <MoneyCell value={e.ratePerLitre} /> },
  {
    key: 'amount', header: 'Amount', unit: '₹', type: 'money', width: 118, group: 'The bill',
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
  { key: 'odometer', header: 'Odometer', unit: 'km', type: 'num', width: 106, group: 'The evidence', render: (e) => <QuantityCell value={e.odometerKm} decimals={0} /> },
  {
    key: 'kmpl', header: 'Implied', unit: 'km/l', type: 'num', width: 112, group: 'The evidence',
    render: (e) => (
      <Stacked
        primary={<span style={isShort(e) ? { color: 'var(--status-attention)' } : undefined}><QuantityCell value={e.impliedKmpl} decimals={2} /></span>}
        secondary={`vs ${formatQty(benchmarkOf(e.vehicleId), 1)}`}
      />
    ),
  },
  {
    key: 'source', header: 'Source', width: 158, group: 'The evidence',
    render: (e) => (
      <Stacked
        primary={e.source === 'own_bunk' ? 'Own bunk' : 'Outside bunk'}
        secondary={e.billNumber ? <IdCell>{e.billNumber}</IdCell> : undefined}
      />
    ),
  },
];
