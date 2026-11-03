import type { ComplianceDocument, FuelEntry } from '@linck/mock';
import { words } from '../../i18n/words.js';
import type { RecordProblem } from '../../shell/recordApi.js';
import type { BreakdownGap } from './breakdownApi.js';

/**
 * The fleet screens' words, in English and Tamil (LIN-23, docs/WRITING.md).
 *
 * One block per screen, plus a shared block for what every fleet screen says
 * the same way: the module name, units, how long ago, document types.
 *
 * Kept out of here on purpose: what people typed or what names a thing —
 * vehicle numbers, driver names, places, breakdown causes, bunk names, bill
 * numbers, models. Those are shown exactly as recorded.
 */

/** Shared by every fleet screen. */
export const fleetWords = words({
  en: {
    eyebrow: 'Fleet',
    all: 'All',
    showAll: 'Show all',
    min: (n: number) => `${n} min`,
    hours: (n: number) => (n === 1 ? '1 hr' : `${n} hrs`),
    days: (n: number) => (n === 1 ? '1 day' : `${n} days`),
    daysAgo: (n: number) => (n === 1 ? '1 day ago' : `${n} days ago`),
    inDays: (n: number) => (n === 0 ? 'today' : n === 1 ? 'in 1 day' : `in ${n} days`),
    km: 'km',
    litres: 'L',
    kmpl: 'km/l',
    tonnes: 'tonnes',
    expired: 'Expired',
    expiring: 'Expiring',
    valid: 'Valid',
    docType: {
      insurance: 'Insurance',
      fitness: 'FC',
      permit: 'State permit',
      national_permit: 'National permit',
      road_tax: 'Road tax',
      puc: 'PUC',
    } satisfies Record<ComplianceDocument['type'], string>,
    /** Where a figure comes from, on hover over the "Updated" time. */
    from: {
      board: 'Fleet counts',
      vehicles: 'Vehicle status',
      drivers: 'Driver list',
      breakdowns: 'Breakdown book',
      diesel: 'Diesel entries',
      fullTank: 'Full-tank fills',
    },
  },
  ta: {
    eyebrow: 'வண்டிகள்',
    all: 'எல்லாம்',
    showAll: 'எல்லாம் காட்டு',
    min: (n) => `${n} நிமிடம்`,
    hours: (n) => `${n} மணி நேரம்`,
    days: (n) => `${n} நாள்`,
    daysAgo: (n) => `${n} நாள் முன்`,
    inDays: (n) => (n === 0 ? 'இன்று' : `${n} நாளில்`),
    km: 'கி.மீ.',
    litres: 'லிட்டர்',
    kmpl: 'கி.மீ./லி.',
    tonnes: 'டன்',
    expired: 'காலாவதி',
    expiring: 'காலாவதி ஆகிறது',
    valid: 'செல்லும்',
    docType: {
      insurance: 'இன்சூரன்ஸ்',
      fitness: 'எஃப்.சி.',
      permit: 'மாநில பர்மிட்',
      national_permit: 'நேஷனல் பர்மிட்',
      road_tax: 'சாலை வரி',
      puc: 'பி.யு.சி.',
    },
    from: {
      board: 'வண்டி எண்ணிக்கை',
      vehicles: 'வண்டி நிலை',
      drivers: 'டிரைவர் பட்டியல்',
      breakdowns: 'பழுது பதிவேடு',
      diesel: 'டீசல் பதிவுகள்',
      fullTank: 'ஃபுல் டேங்க் பதிவுகள்',
    },
  },
});

/** The fleet manager's home: links, then counts of what needs them. */
export const boardWords = words({
  en: {
    title: 'Home',
    open: 'Open',
    waiting: 'Waiting for you',
    go: {
      vehicles: 'Vehicles',
      drivers: 'Drivers',
      loads: 'Loads',
      breakdowns: 'Breakdowns',
      expenses: 'Expenses',
      requests: 'Material requests',
      documents: 'Documents',
    },
    // `definition` also follows "None now —" when the count is zero.
    cards: {
      breakdown: ['Broken down', 'Vehicles off the road'],
      idle: ['No work', 'Can run, but no load'],
      service: ['Service due', 'Past their service km'],
      docs: ['Documents expired', 'Insurance, permit, FC, tax or PUC'],
      drivers: ['Drivers not here', 'Absent or on leave today'],
      bills: ['Bills to check', 'Diesel, repair and other bills'],
      requests: ['Material requests', 'Spares, oil, tyres — not given yet'],
    } satisfies Record<string, [label: string, definition: string]>,
  },
  ta: {
    title: 'முகப்பு',
    open: 'திற',
    waiting: 'உங்களுக்காக காத்திருக்கிறது',
    go: {
      vehicles: 'வண்டிகள்',
      drivers: 'டிரைவர்கள்',
      loads: 'லோடுகள்',
      breakdowns: 'பழுதுகள்',
      expenses: 'செலவுகள்',
      requests: 'பொருள் கோரிக்கைகள்',
      documents: 'ஆவணங்கள்',
    },
    cards: {
      breakdown: ['பழுதான வண்டிகள்', 'ஓடாமல் நிற்கும் வண்டிகள்'],
      idle: ['வேலை இல்லை', 'ஓடலாம், ஆனால் லோடு இல்லை'],
      service: ['சர்வீஸ் செய்ய வேண்டும்', 'சர்வீஸ் கி.மீ. தாண்டியவை'],
      docs: ['ஆவணம் காலாவதி', 'இன்சூரன்ஸ், பர்மிட், எஃப்.சி., வரி அல்லது பி.யு.சி.'],
      drivers: ['வராத டிரைவர்கள்', 'இன்று வரவில்லை அல்லது விடுப்பு'],
      bills: ['சரிபார்க்க வேண்டிய பில்கள்', 'டீசல், ரிப்பேர் மற்றும் பிற பில்கள்'],
      requests: ['பொருள் கோரிக்கைகள்', 'ஸ்பேர்ஸ், ஆயில், டயர் — இன்னும் கொடுக்கவில்லை'],
    },
  },
});

export const driverWords = words({
  en: {
    title: 'Drivers',
    views: {
      all: 'All',
      absent: 'Not here today',
      available: 'Free to drive',
      unassigned: 'No vehicle',
      licence: 'Licence expiry',
    },
    noDrivers: 'No drivers at this site.',
    noneIn: {
      absent: 'Everyone came today.',
      available: 'Nobody is free to drive now.',
      unassigned: 'Every driver has a vehicle.',
      licence: 'No licence expires in 30 days.',
    },
    col: {
      driver: 'Driver',
      today: 'Today',
      vehicle: 'Vehicle',
      licence: 'Licence no.',
      licenceExpiry: 'Licence expires',
    },
  },
  ta: {
    title: 'டிரைவர்கள்',
    views: {
      all: 'எல்லாம்',
      absent: 'இன்று வரவில்லை',
      available: 'ஓட்டத் தயார்',
      unassigned: 'வண்டி இல்லை',
      licence: 'லைசென்ஸ் காலாவதி',
    },
    noDrivers: 'இந்த சைட்டில் டிரைவர்கள் இல்லை.',
    noneIn: {
      absent: 'இன்று எல்லோரும் வந்துள்ளனர்.',
      available: 'இப்போது ஓட்டத் தயாராக யாரும் இல்லை.',
      unassigned: 'எல்லா டிரைவருக்கும் வண்டி உள்ளது.',
      licence: '30 நாளில் எந்த லைசென்ஸும் காலாவதி ஆகாது.',
    },
    col: {
      driver: 'டிரைவர்',
      today: 'இன்று',
      vehicle: 'வண்டி',
      licence: 'லைசென்ஸ் எண்',
      licenceExpiry: 'லைசென்ஸ் காலாவதி',
    },
  },
});

/* -------------------------------------------- breakdowns: the API's refusals */

/** Who holds each key, in words a person knows. */
const BREAKDOWN_WHO_EN: Record<string, string> = {
  'fleet.vehicle.write': 'the fleet manager',
  'fleet.breakdown.read': 'the fleet desk',
};
const BREAKDOWN_WHO_TA: Record<string, string> = {
  'fleet.vehicle.write': 'ஃப்ளீட் மேனேஜர்',
  'fleet.breakdown.read': 'வண்டிப் பிரிவு',
};

/**
 * A value the API would not store, said as the fix. `field` is the request's
 * name for it; `reason`, the API's note in English for the log, only picks
 * between two fixes and is never shown.
 */
function breakdownInvalidEn(field: string, reason: string): string {
  switch (field) {
    case 'vehicleId':
      return 'Type the vehicle number';
    case 'location':
      return 'Type where it is';
    case 'cause':
      return 'Type what broke';
    case 'reportedBy':
      return 'Type who told you';
    case 'reportedAt':
      return reason === 'in the future' ? 'Time cannot be after now' : 'Pick when it broke down';
    case 'resolvedAt':
      return reason === 'in the future'
        ? 'Time cannot be after now'
        : reason.startsWith('before')
          ? 'It cannot be fixed before it broke down'
          : 'Pick when it was fixed';
    case 'repairCost':
      return 'Type the repair cost, like 12,500';
    case 'siteId':
      return 'Pick the site first';
    case 'status':
      return 'Pick the status';
    case 'driverId':
      return 'Check the driver';
    default:
      return 'Check the details, then try again';
  }
}
function breakdownInvalidTa(field: string, reason: string): string {
  switch (field) {
    case 'vehicleId':
      return 'வண்டி எண் டைப் செய்யுங்கள்';
    case 'location':
      return 'எங்கே என்று டைப் செய்யுங்கள்';
    case 'cause':
      return 'என்ன பழுது என்று டைப் செய்யுங்கள்';
    case 'reportedBy':
      return 'யார் சொன்னார் என்று டைப் செய்யுங்கள்';
    case 'reportedAt':
      return reason === 'in the future' ? 'நேரம் இப்போதைக்குப் பிறகு இருக்கக்கூடாது' : 'பழுதான நேரத்தைத் தேர்ந்தெடுங்கள்';
    case 'resolvedAt':
      return reason === 'in the future'
        ? 'நேரம் இப்போதைக்குப் பிறகு இருக்கக்கூடாது'
        : reason.startsWith('before')
          ? 'பழுதான நேரத்துக்கு முன் சரியாகியிருக்க முடியாது'
          : 'சரியான நேரத்தைத் தேர்ந்தெடுங்கள்';
    case 'repairCost':
      return 'ரிப்பேர் செலவு டைப் செய்யுங்கள், உதா. 12,500';
    case 'siteId':
      return 'முதலில் சைட்டைத் தேர்ந்தெடுங்கள்';
    case 'status':
      return 'நிலையைத் தேர்ந்தெடுங்கள்';
    case 'driverId':
      return 'டிரைவரைச் சரிபாருங்கள்';
    default:
      return 'விவரங்களைச் சரிபார்த்து, மீண்டும் முயலுங்கள்';
  }
}

export const breakdownWords = words({
  en: {
    title: 'Breakdowns',
    tally: (count: number, hours: string) => `${count === 1 ? '1 breakdown' : `${count} breakdowns`} · ${hours} hrs off road`,
    views: { all: 'All', live: 'Not fixed', resolved: 'Fixed' },
    noBreakdowns: 'No breakdowns at this site.',
    noneLive: 'Nothing is broken down now.',
    noneFixed: 'Nothing fixed yet.',
    col: {
      number: 'No. & date',
      status: 'Status',
      vehicle: 'Vehicle',
      cause: 'What broke',
      where: 'Where',
      driver: 'Driver',
      offRoad: 'Off road',
      hours: 'hrs',
      repair: 'Repair cost',
    },
    /* Live: the register is the API's, and the fleet manager writes it. */
    one: 'Breakdown',
    add: 'Add breakdown',
    newTitle: 'New breakdown',
    change: 'Change',
    changeTitle: 'Change breakdown',
    markFixed: 'Mark fixed',
    fixTitle: 'Back on the road',
    save: 'Save',
    cancel: 'Cancel',
    saving: 'Saving…',
    retry: 'Try again',
    vehicleSite: "Vehicle's site",
    brokeDown: 'Broke down',
    fixedAt: 'Fixed at',
    toldBy: 'Told by',
    toldByHint: (name: string) => `Blank: ${name}`,
    repairRupees: 'Repair cost ₹',
    readAs: (v: string) => `Read as ${v}`,
    needs: {
      vehicle: 'Vehicle',
      cause: 'What broke',
      location: 'Where',
      when: 'Broke down',
      site: "Vehicle's site",
      fixedAt: 'Fixed at',
      fixedBeforeDown: 'Fixed at',
      repairCost: 'Repair cost',
    } satisfies Record<BreakdownGap, string>,
    wrong: {
      when: 'Time cannot be after now.',
      fixedAt: 'Time cannot be after now.',
      fixedBeforeDown: 'It cannot be fixed before it broke down.',
      repairCost: 'Type rupees, like 12,500.',
    },
    stillNeeded: (list: string[]) => `Still needed: ${list.join(', ')}`,
    cannotChange: 'Only the fleet manager at its site can change this.',
    loading: 'Getting the breakdowns…',
    failed: 'Could not get the breakdowns.',
    /**
     * Why a breakdown could not be saved, read or moved: live, the API's
     * refusal, or the API not answering. `status` is a breakdown's status in
     * words; a vehicle comes as people write it (TN 38 AL 1050).
     */
    problem: (p: RecordProblem, status: (s: string) => string): string => {
      switch (p.code) {
        case 'needs-permission':
          return `Only ${BREAKDOWN_WHO_EN[p.permission] ?? 'someone else'} can do this here.`;
        case 'wrong-step':
          return `Not now — this breakdown is "${status(p.status)}".`;
        case 'vehicle-already-down':
          return `${p.vehicle} is already down. Mark that one fixed first.`;
        case 'gone':
          return 'This breakdown is no longer here.';
        case 'invalid':
          return `${breakdownInvalidEn(p.field, p.reason)}.`;
        case 'signed-out':
          return 'You were signed out. Sign in again.';
        case 'offline':
          return 'Linck did not answer. Check the internet, then try again.';
        case 'server':
          return p.status > 0 ? `Linck had a problem (error ${p.status}). Try again.` : 'Linck had a problem. Try again.';
        // Not refusals the register's requests are ever given.
        case 'needs-reason':
        case 'gstin-used':
          return 'Check the details, then try again.';
      }
    },
  },
  ta: {
    title: 'பழுதுகள்',
    tally: (count, hours) => `${count} ${count === 1 ? 'பழுது' : 'பழுதுகள்'} · ${hours} மணி நேரம் ஓடவில்லை`,
    views: { all: 'எல்லாம்', live: 'சரியாகவில்லை', resolved: 'சரியானது' },
    noBreakdowns: 'இந்த சைட்டில் பழுது இல்லை.',
    noneLive: 'இப்போது எந்த வண்டியும் பழுதில் இல்லை.',
    noneFixed: 'இன்னும் எதுவும் சரியாகவில்லை.',
    col: {
      number: 'எண், தேதி',
      status: 'நிலை',
      vehicle: 'வண்டி',
      cause: 'என்ன பழுது',
      where: 'எங்கே',
      driver: 'டிரைவர்',
      offRoad: 'ஓடாத நேரம்',
      hours: 'மணி',
      repair: 'ரிப்பேர் செலவு',
    },
    one: 'பழுது',
    add: 'பழுது சேர்',
    newTitle: 'புது பழுது',
    change: 'மாற்று',
    changeTitle: 'பழுது விவரம் மாற்று',
    markFixed: 'சரியானதாகக் குறி',
    fixTitle: 'மீண்டும் ஓடுகிறது',
    save: 'சேமி',
    cancel: 'ரத்து',
    saving: 'சேமிக்கிறது…',
    retry: 'மீண்டும் முயல்',
    vehicleSite: 'வண்டியின் சைட்',
    brokeDown: 'பழுதான நேரம்',
    fixedAt: 'சரியான நேரம்',
    toldBy: 'சொன்னவர்',
    toldByHint: (name) => `காலியாக விட்டால்: ${name}`,
    repairRupees: 'ரிப்பேர் செலவு ₹',
    readAs: (v) => `${v} எனப் படித்தது`,
    needs: {
      vehicle: 'வண்டி',
      cause: 'என்ன பழுது',
      location: 'எங்கே',
      when: 'பழுதான நேரம்',
      site: 'வண்டியின் சைட்',
      fixedAt: 'சரியான நேரம்',
      fixedBeforeDown: 'சரியான நேரம்',
      repairCost: 'ரிப்பேர் செலவு',
    },
    wrong: {
      when: 'நேரம் இப்போதைக்குப் பிறகு இருக்கக்கூடாது.',
      fixedAt: 'நேரம் இப்போதைக்குப் பிறகு இருக்கக்கூடாது.',
      fixedBeforeDown: 'பழுதான நேரத்துக்கு முன் சரியாகியிருக்க முடியாது.',
      repairCost: 'ரூபாய் டைப் செய்யுங்கள், உதா. 12,500.',
    },
    stillNeeded: (list) => `இன்னும் தேவை: ${list.join(', ')}`,
    cannotChange: 'இதை அதன் சைட்டின் ஃப்ளீட் மேனேஜர் மட்டுமே மாற்ற முடியும்.',
    loading: 'பழுதுகளை எடுக்கிறது…',
    failed: 'பழுதுகளை எடுக்க முடியவில்லை.',
    problem: (p, status) => {
      switch (p.code) {
        case 'needs-permission':
          return `இதை ${BREAKDOWN_WHO_TA[p.permission] ?? 'வேறொருவர்'} மட்டுமே செய்ய முடியும்.`;
        case 'wrong-step':
          return `இப்போது முடியாது — பழுது "${status(p.status)}" நிலையில் உள்ளது.`;
        case 'vehicle-already-down':
          return `${p.vehicle} ஏற்கனவே பழுதில் உள்ளது. முதலில் அதைச் சரியானதாகக் குறியுங்கள்.`;
        case 'gone':
          return 'இந்தப் பழுது இப்போது இல்லை.';
        case 'invalid':
          return `${breakdownInvalidTa(p.field, p.reason)}.`;
        case 'signed-out':
          return 'நீங்கள் வெளியேற்றப்பட்டீர்கள். மீண்டும் உள்நுழையுங்கள்.';
        case 'offline':
          return 'Linck பதில் தரவில்லை. இணையத்தைச் சரிபார்த்து, மீண்டும் முயலுங்கள்.';
        case 'server':
          return p.status > 0 ? `Linck-இல் பிழை (${p.status}). மீண்டும் முயலுங்கள்.` : 'Linck-இல் பிழை. மீண்டும் முயலுங்கள்.';
        case 'needs-reason':
        case 'gstin-used':
          return 'விவரங்களைச் சரிபார்த்து, மீண்டும் முயலுங்கள்.';
      }
    },
  },
});

export const vehicleWords = words({
  en: {
    title: 'Vehicle status',
    drivers: (free: number, onTrip: number, away: number) => `Drivers: ${free} free · ${onTrip} on trip · ${away} not here`,
    working: 'Ready or on trip',
    workingSplit: (onTrip: number, ready: number, total: number) => `${onTrip} on trip · ${ready} ready · ${total} total`,
    idleLoss: (units: string) => `About ${units} units not sent`,
    idleNone: 'All have work',
    breakdownNow: 'Off the road now',
    breakdownNone: 'None broken down',
    lowMileage: 'Low mileage',
    lowMileageRule: 'Over 18% below normal',
    views: {
      serviceDue: 'Service due',
      docsSoon: 'Documents expiring',
      docsExpired: 'Documents expired',
    },
    now: 'Vehicles now',
    nowSummary: (total: number, parts: string) => `${total} vehicles: ${parts}`,
    days14: 'Last 14 days',
    trendSummary: (today: string) => `Ready or on trip, last 14 days. Today ${today}%.`,
    trendNote: 'Shaded: a normal day. Sundays are low.',
    lastFull: 'Last full tank',
    mileageTitle: 'Mileage, each vehicle',
    scatterSummary: (low: number, of: number, regs: string) =>
      low === 0
        ? 'All vehicles are near normal mileage.'
        : `${low} of ${of} ${low === 1 ? 'is' : 'are'} over 18% below normal: ${regs}.`,
    scatterX: 'normal km/l',
    scatterY: 'last km/l',
    scatterNote: 'Dots under the line use too much diesel.',
    idleWithDriver: (n: number) => (n === 1 ? '1 vehicle has a driver but no load.' : `${n} vehicles have a driver but no load.`),
    showThem: 'Show them',
    noneHere: 'No vehicles here.',
    reportedHere: 'Reported here, waiting for workshop',
    // Sheet
    sizeOf: (tonnes: number) => `${tonnes} tonnes`,
    reportBreakdown: 'Report breakdown',
    alreadyDown: 'Already off the road.',
    confirmTitle: 'Report breakdown?',
    confirmLines: (reg: string, driver: string | null, from: string, to: string) => [
      `${reg} will get no more loads.`,
      ...(driver ? [`Give ${driver} another vehicle.`] : []),
      `Ready or on trip: ${from}% → ${to}%.`,
    ],
    sheet: {
      vehicle: 'Vehicle',
      number: 'Vehicle no.',
      model: 'Model',
      size: 'Size',
      site: 'Site',
      status: 'Status',
      howLong: 'How long',
      reason: 'Reason',
      noReason: 'No reason written.',
      driver: 'Driver',
      name: 'Name',
      phone: 'Phone',
      licence: 'Licence no.',
      licenceExpiry: 'Licence expires',
      noDriver: 'No driver. It cannot get a load.',
      today: 'Today',
      trips: 'Trips',
      moved: 'Moved',
      mileage: 'Mileage',
      notEnoughFills: 'Not enough full-tank fills yet.',
      mileageSummary: (last: string, normal: string, lowPct: string | null) =>
        `Last ${last} km/l, normal ${normal}.${lowPct ? ` ${lowPct}% low.` : ''}`,
      normalAt: (n: string) => `normal ${n}`,
      dropping: 'Dropping slowly. Ask the driver.',
      steady: 'Normal. Nothing to do.',
      service: 'Service',
      kmReading: 'Km reading',
      nextService: 'Next service in',
      serviceLate: (km: string) => `Service late by ${km} km.`,
      nextDoc: 'Next to expire',
      document: 'Document',
      docNumber: 'Number',
      expires: 'Expires',
      issuer: 'Issued by',
      noDocs: 'No documents on file.',
      docExpiredStops: 'Vehicle cannot run. Renew now.',
      docExpiredRuns: 'It can run. Renew soon.',
      docStops: 'Needed to run. Renewal takes 2 weeks.',
      docRuns: 'Renew with the next batch.',
    },
    col: {
      vehicle: 'Vehicle',
      status: 'Status',
      reason: 'Reason',
      driver: 'Driver',
      today: 'Today',
      trips: 'Trips',
      moved: 'Moved',
      mileage: 'Mileage',
      last: 'Last',
      normal: 'Normal',
      days28: '28 days',
      upkeep: 'Service & documents',
      serviceIn: 'Service in',
      nextDoc: 'Next document',
    },
  },
  ta: {
    title: 'வண்டி நிலை',
    drivers: (free, onTrip, away) => `டிரைவர்கள்: ${free} தயார் · ${onTrip} ட்ரிப்பில் · ${away} வரவில்லை`,
    working: 'தயார் அல்லது ட்ரிப்பில்',
    workingSplit: (onTrip, ready, total) => `${onTrip} ட்ரிப்பில் · ${ready} தயார் · மொத்தம் ${total}`,
    idleLoss: (units) => `சுமார் ${units} யூனிட் அனுப்பவில்லை`,
    idleNone: 'எல்லா வண்டிக்கும் வேலை உள்ளது',
    breakdownNow: 'இப்போது ஓடவில்லை',
    breakdownNone: 'பழுது எதுவும் இல்லை',
    lowMileage: 'மைலேஜ் குறைவு',
    lowMileageRule: 'வழக்கத்தை விட 18%-க்கு மேல் குறைவு',
    views: {
      serviceDue: 'சர்வீஸ் செய்ய வேண்டும்',
      docsSoon: 'ஆவணம் காலாவதி ஆகிறது',
      docsExpired: 'ஆவணம் காலாவதி',
    },
    now: 'இப்போதைய நிலை',
    nowSummary: (total, parts) => `${total} ${total === 1 ? 'வண்டி' : 'வண்டிகள்'}: ${parts}`,
    days14: 'கடந்த 14 நாள்',
    trendSummary: (today) => `கடந்த 14 நாள் — தயார் அல்லது ட்ரிப்பில். இன்று ${today}%.`,
    trendNote: 'நிழல் பகுதி: வழக்கமான நாள். ஞாயிறு குறைவு.',
    lastFull: 'கடைசி ஃபுல் டேங்க்',
    mileageTitle: 'ஒவ்வொரு வண்டியின் மைலேஜ்',
    scatterSummary: (low, of, regs) =>
      low === 0
        ? 'எல்லா வண்டிகளும் வழக்கமான மைலேஜில் உள்ளன.'
        : `${of}-ல் ${low} ${low === 1 ? 'வண்டி' : 'வண்டிகள்'} வழக்கத்தை விட 18%-க்கு மேல் குறைவு: ${regs}.`,
    scatterX: 'வழக்கம் கி.மீ./லி.',
    scatterY: 'கடைசி கி.மீ./லி.',
    scatterNote: 'கோட்டுக்குக் கீழே உள்ளவை அதிக டீசல் செலவு செய்கின்றன.',
    idleWithDriver: (n) => `${n} ${n === 1 ? 'வண்டிக்கு' : 'வண்டிகளுக்கு'} டிரைவர் உண்டு, லோடு இல்லை.`,
    showThem: 'காட்டு',
    noneHere: 'இங்கே வண்டி இல்லை.',
    reportedHere: 'இங்கே பதிவு செய்தது — வொர்க்ஷாப்புக்காக காத்திருக்கிறது',
    sizeOf: (tonnes) => `${tonnes} டன்`,
    reportBreakdown: 'பழுது பதிவு செய்',
    alreadyDown: 'ஏற்கனவே ஓடவில்லை.',
    confirmTitle: 'பழுது பதிவு செய்யவா?',
    confirmLines: (reg, driver, from, to) => [
      `${reg} வண்டிக்கு இனி லோடு கிடையாது.`,
      ...(driver ? [`${driver}-க்கு வேறு வண்டி கொடுங்கள்.`] : []),
      `தயார் அல்லது ட்ரிப்பில்: ${from}% → ${to}%.`,
    ],
    sheet: {
      vehicle: 'வண்டி',
      number: 'வண்டி எண்',
      model: 'மாடல்',
      size: 'அளவு',
      site: 'சைட்',
      status: 'நிலை',
      howLong: 'எவ்வளவு நேரம்',
      reason: 'காரணம்',
      noReason: 'காரணம் எழுதவில்லை.',
      driver: 'டிரைவர்',
      name: 'பெயர்',
      phone: 'போன்',
      licence: 'லைசென்ஸ் எண்',
      licenceExpiry: 'லைசென்ஸ் காலாவதி',
      noDriver: 'டிரைவர் இல்லை. லோடு கொடுக்க முடியாது.',
      today: 'இன்று',
      trips: 'ட்ரிப்கள்',
      moved: 'லோடு',
      mileage: 'மைலேஜ்',
      notEnoughFills: 'போதுமான ஃபுல் டேங்க் பதிவுகள் இல்லை.',
      mileageSummary: (last, normal, lowPct) =>
        `கடைசி ${last} கி.மீ./லி., வழக்கம் ${normal}.${lowPct ? ` ${lowPct}% குறைவு.` : ''}`,
      normalAt: (n) => `வழக்கம் ${n}`,
      dropping: 'மெல்லக் குறைகிறது. டிரைவரிடம் கேளுங்கள்.',
      steady: 'சரியாக உள்ளது.',
      service: 'சர்வீஸ்',
      kmReading: 'கி.மீ. ரீடிங்',
      nextService: 'அடுத்த சர்வீஸ்',
      serviceLate: (km) => `சர்வீஸ் ${km} கி.மீ. தாமதம்.`,
      nextDoc: 'அடுத்து காலாவதி ஆவது',
      document: 'ஆவணம்',
      docNumber: 'எண்',
      expires: 'காலாவதி தேதி',
      issuer: 'வழங்கியவர்',
      noDocs: 'ஆவணங்கள் எதுவும் இல்லை.',
      docExpiredStops: 'வண்டி ஓட முடியாது. உடனே புதுப்பிக்கவும்.',
      docExpiredRuns: 'ஓடலாம். விரைவில் புதுப்பிக்கவும்.',
      docStops: 'ஓட இது தேவை. புதுப்பிக்க 2 வாரம் ஆகும்.',
      docRuns: 'அடுத்த முறை மற்றவற்றுடன் புதுப்பிக்கவும்.',
    },
    col: {
      vehicle: 'வண்டி',
      status: 'நிலை',
      reason: 'காரணம்',
      driver: 'டிரைவர்',
      today: 'இன்று',
      trips: 'ட்ரிப்',
      moved: 'லோடு',
      mileage: 'மைலேஜ்',
      last: 'கடைசி',
      normal: 'வழக்கம்',
      days28: '28 நாள்',
      upkeep: 'சர்வீஸ் & ஆவணம்',
      serviceIn: 'சர்வீஸ்',
      nextDoc: 'அடுத்த ஆவணம்',
    },
  },
});

/**
 * Diesel entry. A driver keys this at the bunk, so every line is short and
 * says what to do.
 */
export const fuelWords = words({
  en: {
    title: 'Add diesel',
    save: 'Save',
    noVehicles: 'No vehicles at this site.',
    pickSite: 'Pick another site.',
    billPhoto: (by: string, time: string, vehicle: string, litres: string, rate: string) =>
      `Bill photo from ${by} at ${time}: ${vehicle}, ${litres} L at ₹${rate}. Type the km reading yourself.`,
    fromBill: 'Fill from bill',
    newEntry: 'New entry',
    matchesBill: 'Matches the bill',
    vehicle: 'Vehicle',
    driver: 'Driver',
    driverAuto: 'Change if someone else drove.',
    driverChanged: 'Changed by you.',
    noDriver: 'No driver',
    date: 'Date',
    kmReading: 'Km reading',
    notFullNoMileage: 'Not full tank: no mileage',
    mileageIs: (kmpl: string, normal: string) => `Mileage ${kmpl} km/l · normal ${normal}`,
    photoUnclear: 'Photo unclear — type it',
    kmTooLow: (last: string) => `Must be more than ${last} km. Check the meter.`,
    lastFull: (date: string, km: string) => `Last full tank: ${date}, ${km} km`,
    litres: 'Litres',
    overTank: (tank: string) => `Tank holds only ${tank} L. Check the bill.`,
    sinceLastFull: (km: string) => `${km} km since last full tank`,
    rate: 'Rate per litre (₹)',
    ourRate: "Today's rate at our bunk",
    amount: 'Amount (₹)',
    amountMatches: 'Matches litres × rate',
    litresTimesRate: (amount: string) => `Litres × rate = ${amount}`,
    tank: 'Tank',
    fullTank: 'Full tank',
    fullTankHelp: 'Tick if the nozzle stopped by itself.',
    where: 'Where filled',
    ownBunk: 'Our bunk',
    outsideBunk: 'Outside bunk',
    billNumber: 'Bill number',
    billNumberHelp: 'Needed to pay the bunk.',
    adBlue: 'AdBlue litres',
    adBlueShare: (pct: string) => `${pct}% of diesel (normal 3–6%)`,
    adBlueHelp: 'Leave empty if not filled.',
    // Charts
    days28: 'Last 28 days',
    mileageOf: (reg: string) => `Mileage · ${reg}`,
    mileageSummary: (reg: string, latest: string, normal: string, low: number) =>
      `${reg}: latest ${latest} km/l, normal ${normal}. ${low} low.`,
    normalAt: (n: string) => `normal ${n}`,
    mileageNote: 'One low point is fine. A steady drop is not.',
    noMileage: 'No mileage yet. Needs 2 full-tank fills.',
    last10: 'Last 10 fills',
    litresVsTank: 'Litres vs tank size',
    fillsSummary: (n: number, over: number) => `Last ${n} fills. ${over} more than the tank.`,
    litresShort: (v: string) => `${v} L`,
    fillsNote: 'Dashed line: tank size. Tap a bar to open.',
    // Recent fills
    recent: 'Recent fills',
    lens: { all: 'All', exceptions: 'Needs a look', flagged: 'Marked' },
    noneMarked: 'Nothing marked.',
    howToMark: 'Open a fill to mark it.',
    allFine: 'All recent fills look fine.',
    noFills: 'No fills at this site yet.',
    col: {
      date: 'Date',
      vehicle: 'Vehicle',
      driver: 'Driver',
      litres: 'Litres',
      rate: 'Rate',
      amount: 'Amount',
      km: 'Km reading',
      mileage: 'Mileage',
      where: 'Where',
      status: 'Status',
    },
    standing: {
      marked: 'Marked',
      overTank: 'More than tank',
      low: 'Low mileage',
      notChecked: 'Not checked',
      ok: 'OK',
    },
    // The sheet
    fill: 'Diesel fill',
    mark: 'Mark to check',
    unmark: 'Remove mark',
    sheet: {
      fill: 'Fill',
      bill: 'Bill',
      tank: 'Tank',
      mileage: 'Mileage',
      vehicle: 'Vehicle',
      driver: 'Driver',
      date: 'Date',
      where: 'Where',
      billNumber: 'Bill number',
      fullTank: 'Full tank',
      yes: 'Yes',
      partFill: 'No',
      entered: 'How entered',
      noBillNumber: 'No bill number. Get the bill.',
      litres: 'Litres',
      rate: 'Rate per litre',
      amount: 'Amount',
      litresTimesRate: 'Litres × rate',
      amountMatches: 'Amount matches.',
      amountOff: (diff: string, more: boolean) => `${diff} ${more ? 'more' : 'less'} than litres × rate. Check the bill.`,
      tankUnknown: 'Tank size not known.',
      tankPart: 'Tank',
      extraPart: 'Extra',
      thisFill: 'This fill',
      spaceLeft: 'Space left',
      tankOverSummary: (litres: string, cap: string, extra: string) => `${litres} L into a ${cap} L tank. ${extra} L too many.`,
      tankOkSummary: (litres: string, cap: string, left: string) => `${litres} L into a ${cap} L tank. ${left} L space left.`,
      tankOver: (extra: string) => `${extra} L more than the tank. Check the bill.`,
      tankOk: (cap: string) => `Fits the ${cap} L tank.`,
      kmReading: 'Km reading',
      normalForModel: 'Normal for this model',
      vsNormal: 'Compared to normal',
      pctLow: (n: number) => `${n}% low`,
      pctBetter: (n: number) => `${n}% better`,
      noMileage: 'Not full tank: no mileage.',
      tooLow: 'Over 18% low. Talk to the driver.',
      fine: 'Normal.',
    },
    provenance: {
      human: 'Typed by hand',
      proposed: 'Read from photo, not checked',
      confirmed: 'Read from photo, checked',
      overridden: 'Read from photo, corrected',
      device: 'From the bunk machine',
    } satisfies Record<FuelEntry['provenance'], string>,
    // The ask-once dialog
    confirmTitle: 'Save this fill?',
    confirmLabel: 'Save and mark',
    confirmHead: (reg: string, litres: string, amount: string) => `${reg}: ${litres} L, ${amount}.`,
    confirmOverTank: (tank: string) => `More than the ${tank} L tank.`,
    confirmMileage: (kmpl: string, normal: string) => `Mileage ${kmpl} km/l, normal ${normal}.`,
    confirmAmount: (diff: string, more: boolean) => `Amount is ${diff} ${more ? 'more' : 'less'} than litres × rate.`,
    confirmWillMark: 'It will be saved and marked to check.',
  },
  ta: {
    title: 'டீசல் சேர்',
    save: 'சேமி',
    noVehicles: 'இந்த சைட்டில் வண்டி இல்லை.',
    pickSite: 'வேறு சைட்டைத் தேர்ந்தெடுங்கள்.',
    billPhoto: (by, time, vehicle, litres, rate) =>
      `${by} ${time} மணிக்கு எடுத்த பில் போட்டோ: ${vehicle}, ${litres} லிட்டர், லிட்டருக்கு ₹${rate}. கி.மீ. ரீடிங்கை நீங்களே டைப் செய்யுங்கள்.`,
    fromBill: 'பில்லில் இருந்து நிரப்பு',
    newEntry: 'புதிய பதிவு',
    matchesBill: 'பில்லுடன் சரி',
    vehicle: 'வண்டி',
    driver: 'டிரைவர்',
    driverAuto: 'வேறு யாராவது ஓட்டினால் மாற்றுங்கள்.',
    driverChanged: 'நீங்கள் மாற்றியது.',
    noDriver: 'டிரைவர் இல்லை',
    date: 'தேதி',
    kmReading: 'கி.மீ. ரீடிங்',
    notFullNoMileage: 'ஃபுல் டேங்க் இல்லை: மைலேஜ் இல்லை',
    mileageIs: (kmpl, normal) => `மைலேஜ் ${kmpl} கி.மீ./லி. · வழக்கம் ${normal}`,
    photoUnclear: 'போட்டோ தெளிவில்லை — டைப் செய்யுங்கள்',
    kmTooLow: (last) => `${last} கி.மீ.-க்கு மேல் இருக்க வேண்டும். மீட்டரைப் பாருங்கள்.`,
    lastFull: (date, km) => `கடைசி ஃபுல் டேங்க்: ${date}, ${km} கி.மீ.`,
    litres: 'லிட்டர்',
    overTank: (tank) => `டேங்க் ${tank} லிட்டர் தான். பில்லைப் பாருங்கள்.`,
    sinceLastFull: (km) => `கடைசி ஃபுல் டேங்கிலிருந்து ${km} கி.மீ.`,
    rate: 'லிட்டர் விலை (₹)',
    ourRate: 'இன்றைய நம் பங்க் விலை',
    amount: 'தொகை (₹)',
    amountMatches: 'லிட்டர் × விலை சரியாக உள்ளது',
    litresTimesRate: (amount) => `லிட்டர் × விலை = ${amount}`,
    tank: 'டேங்க்',
    fullTank: 'ஃபுல் டேங்க்',
    fullTankHelp: 'நாசில் தானாக நின்றால் டிக் செய்யுங்கள்.',
    where: 'எங்கே நிரப்பியது',
    ownBunk: 'நம் பங்க்',
    outsideBunk: 'வெளி பங்க்',
    billNumber: 'பில் எண்',
    billNumberHelp: 'பங்க்குக்குப் பணம் கொடுக்க இது தேவை.',
    adBlue: 'AdBlue லிட்டர்',
    adBlueShare: (pct) => `டீசலில் ${pct}% (வழக்கம் 3–6%)`,
    adBlueHelp: 'நிரப்பவில்லை என்றால் காலியாக விடுங்கள்.',
    days28: 'கடந்த 28 நாள்',
    mileageOf: (reg) => `மைலேஜ் · ${reg}`,
    mileageSummary: (reg, latest, normal, low) =>
      `${reg}: கடைசி ${latest} கி.மீ./லி., வழக்கம் ${normal}. ${low} முறை குறைவு.`,
    normalAt: (n) => `வழக்கம் ${n}`,
    mileageNote: 'ஒரு முறை குறைந்தால் பரவாயில்லை. தொடர்ந்து குறைந்தால் சரியில்லை.',
    noMileage: 'மைலேஜ் இன்னும் இல்லை. 2 ஃபுல் டேங்க் பதிவுகள் தேவை.',
    last10: 'கடைசி 10 பதிவுகள்',
    litresVsTank: 'லிட்டர் — டேங்க் அளவுடன்',
    fillsSummary: (n, over) => `கடைசி ${n} பதிவுகள். ${over} டேங்க் அளவை விட அதிகம்.`,
    litresShort: (v) => `${v} லி.`,
    fillsNote: 'கோடு: டேங்க் அளவு. திறக்க பட்டையைத் தொடுங்கள்.',
    recent: 'சமீபத்திய டீசல் பதிவுகள்',
    lens: { all: 'எல்லாம்', exceptions: 'கவனிக்க வேண்டியவை', flagged: 'குறித்தவை' },
    noneMarked: 'எதுவும் குறிக்கவில்லை.',
    howToMark: 'குறிக்க, ஒரு பதிவைத் திறங்கள்.',
    allFine: 'சமீபத்திய பதிவுகள் எல்லாம் சரி.',
    noFills: 'இந்த சைட்டில் இன்னும் பதிவு இல்லை.',
    col: {
      date: 'தேதி',
      vehicle: 'வண்டி',
      driver: 'டிரைவர்',
      litres: 'லிட்டர்',
      rate: 'விலை',
      amount: 'தொகை',
      km: 'கி.மீ. ரீடிங்',
      mileage: 'மைலேஜ்',
      where: 'எங்கே',
      status: 'நிலை',
    },
    standing: {
      marked: 'குறித்தது',
      overTank: 'டேங்க்கை விட அதிகம்',
      low: 'மைலேஜ் குறைவு',
      notChecked: 'சரிபார்க்கவில்லை',
      ok: 'சரி',
    },
    fill: 'டீசல் பதிவு',
    mark: 'சரிபார்க்கக் குறி',
    unmark: 'குறியை நீக்கு',
    sheet: {
      fill: 'பதிவு',
      bill: 'பில்',
      tank: 'டேங்க்',
      mileage: 'மைலேஜ்',
      vehicle: 'வண்டி',
      driver: 'டிரைவர்',
      date: 'தேதி',
      where: 'எங்கே',
      billNumber: 'பில் எண்',
      fullTank: 'ஃபுல் டேங்க்',
      yes: 'ஆம்',
      partFill: 'இல்லை',
      entered: 'எப்படி பதிவானது',
      noBillNumber: 'பில் எண் இல்லை. பில்லை வாங்குங்கள்.',
      litres: 'லிட்டர்',
      rate: 'லிட்டர் விலை',
      amount: 'தொகை',
      litresTimesRate: 'லிட்டர் × விலை',
      amountMatches: 'தொகை சரியாக உள்ளது.',
      amountOff: (diff, more) => `லிட்டர் × விலையை விட ${diff} ${more ? 'அதிகம்' : 'குறைவு'}. பில்லைப் பாருங்கள்.`,
      tankUnknown: 'டேங்க் அளவு தெரியாது.',
      tankPart: 'டேங்க்',
      extraPart: 'கூடுதல்',
      thisFill: 'இந்த பதிவு',
      spaceLeft: 'மீதி இடம்',
      tankOverSummary: (litres, cap, extra) => `${cap} லிட்டர் டேங்க்கில் ${litres} லிட்டர். ${extra} லிட்டர் அதிகம்.`,
      tankOkSummary: (litres, cap, left) => `${cap} லிட்டர் டேங்க்கில் ${litres} லிட்டர். ${left} லிட்டர் இடம் மீதி.`,
      tankOver: (extra) => `டேங்க்கை விட ${extra} லிட்டர் அதிகம். பில்லைப் பாருங்கள்.`,
      tankOk: (cap) => `${cap} லிட்டர் டேங்க்கில் அடங்கும்.`,
      kmReading: 'கி.மீ. ரீடிங்',
      normalForModel: 'இந்த மாடலுக்கு வழக்கம்',
      vsNormal: 'வழக்கத்துடன் ஒப்பிட்டால்',
      pctLow: (n) => `${n}% குறைவு`,
      pctBetter: (n) => `${n}% அதிகம்`,
      noMileage: 'ஃபுல் டேங்க் இல்லை: மைலேஜ் இல்லை.',
      tooLow: '18%-க்கு மேல் குறைவு. டிரைவரிடம் பேசுங்கள்.',
      fine: 'சரியாக உள்ளது.',
    },
    provenance: {
      human: 'கையால் டைப் செய்தது',
      proposed: 'போட்டோவில் படித்தது, சரிபார்க்கவில்லை',
      confirmed: 'போட்டோவில் படித்தது, சரிபார்த்தது',
      overridden: 'போட்டோவில் படித்தது, திருத்தியது',
      device: 'பங்க் மெஷினில் இருந்து',
    },
    confirmTitle: 'இந்த பதிவைச் சேமிக்கவா?',
    confirmLabel: 'சேமித்து குறி',
    confirmHead: (reg, litres, amount) => `${reg}: ${litres} லிட்டர், ${amount}.`,
    confirmOverTank: (tank) => `${tank} லிட்டர் டேங்க்கை விட அதிகம்.`,
    confirmMileage: (kmpl, normal) => `மைலேஜ் ${kmpl} கி.மீ./லி., வழக்கம் ${normal}.`,
    confirmAmount: (diff, more) => `தொகை லிட்டர் × விலையை விட ${diff} ${more ? 'அதிகம்' : 'குறைவு'}.`,
    confirmWillMark: 'இது சேமிக்கப்பட்டு, சரிபார்க்கக் குறிக்கப்படும்.',
  },
});
