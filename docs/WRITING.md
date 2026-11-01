# Writing for the screens

Linck is used by drivers, yard staff, store keepers and clerks as much as by the
owner. Many did little schooling, and many read Tamil better than English. Every
word on a screen is written for them. (LIN-23)

## The rules

1. **Few words.** A label is one to three words. A sentence is one idea, about
   eight words at most. If a screen needs a paragraph, the screen is wrong.
2. **Plain words.** Say *check*, not *validate*; *bill*, not *document*; *wrong*,
   not *invalid*. No table names, no permission keys, no codes, no "IST".
3. **Say what to do.** "Type the total" — not "The total could not be parsed".
   An error names the fix.
4. **Numbers first.** A count and a rupee figure say more than a sentence about
   them. "4 bills · ₹69,575" beats "4 bills worth ₹69.6 K are waiting".
5. **Same word, same thing.** Use the glossary below, everywhere. A bill is never
   also an invoice on the next screen.
6. **Status is a word, a mark and a colour** — never colour alone.
7. **Keep the "why" in code comments,** not on the screen. The screen says what
   is true and what to do; the comment explains the rule.
8. **Big targets.** Buttons and chips are easy to hit with a thumb.

## Two languages

Every screen speaks English and Tamil. The switch is in the top bar and the
choice is remembered.

- Each feature keeps its words beside its code in a `words({ en, ta })` block,
  read with `useWords()` (see `apps/web/src/i18n/words.ts`). The Tamil side must
  have every key the English side has, or the build fails.
- A sentence with a number or a name in it is a function, so each language
  puts the number where its grammar wants it.
- Domain code (`packages/domain`) returns **codes with values**, never sentences,
  for anything a person reads. The screen words them.
- **Translate the product's words only.** What people typed — vendor names, a
  driver's message, remarks, place names — is shown exactly as typed.
- Tamil is simple, everyday written Tamil, as on a bank or UPI app. Where an
  English word is what people actually say (டீசல், டிரைவர், பில், லோடு),
  use it in Tamil script.
- Numbers stay as digits (12,500), dates as 06-08-2026, money as ₹.

## Glossary

| English | Tamil | Not |
|---|---|---|
| Bill | பில் | invoice (for expenses), document |
| Bills | பில்கள் | |
| Expense | செலவு | expenditure |
| Diesel | டீசல் | HSD (on screen) |
| Litres | லிட்டர் | |
| Amount | தொகை | value |
| Total | மொத்தம் | |
| Rate | விலை | |
| Vehicle | வண்டி | asset |
| Driver | டிரைவர் | |
| Vendor / shop | கடை | supplier, vendor |
| Diesel bunk | பங்க் | |
| Customer | வாடிக்கையாளர் | client, party |
| Site | சைட் | plant (on screen), scope |
| Date | தேதி | |
| Bill number | பில் எண் | |
| Photo | போட்டோ | scan, image, attachment |
| Add | சேர் | upload, create |
| Check (verify) | சரிபார் | validate |
| Checked | சரிபார்த்தது | validated |
| Approve | அனுமதி | sanction |
| Approved | அனுமதித்தது | |
| Reject | நிராகரி | decline |
| Send back | திருப்பி அனுப்பு | |
| Delete | நீக்கு | remove |
| Restore | மீண்டும் சேர் | |
| Pass for payment | பணம் கொடுக்க அனுமதி | |
| Pay / Paid | பணம் கொடு / பணம் கொடுத்தது | settle, disburse |
| Waiting | காத்திருக்கிறது | pending, awaiting |
| Waiting for you | உங்களுக்காக காத்திருக்கிறது | |
| Wrong | தவறு | invalid |
| Reason | காரணம் | justification |
| Save | சேமி | |
| Cancel | ரத்து | |
| Close | மூடு | |
| Search | தேடு | |
| All | எல்லாம் | |
| Today | இன்று | |
| Days | நாள் / நாட்கள் | |
| Trip | ட்ரிப் | journey |
| Load (dispatch) | லோடு | consignment |
| Breakdown | பழுது | |
| Repair | ரிப்பேர் | |
| Tyre | டயர் | |
| Spares | ஸ்பேர்ஸ் | parts |
| Toll | டோல் | |
| Other | மற்றவை | |
| Odometer reading | கி.மீ. ரீடிங் | |
| Mileage | மைலேஜ் | |
| Stock | இருப்பு | inventory |
| Weighbridge | எடை மேடை | |
| Tonnes | டன் | |
| Production | உற்பத்தி | |
| Shift | ஷிப்ட் | |
| Invoice (sales) | இன்வாய்ஸ் | |
| Order | ஆர்டர் | purchase order (on screen) |
| Payment received | பணம் வந்தது | receipt |
| Documents (RC, FC, permit) | ஆவணங்கள் | |
| Expires | காலாவதி | |
| Request for material | பொருள் கோரிக்கை | indent (on screen) |
| Profit / Loss | லாபம் / நஷ்டம் | |
| Report | அறிக்கை | |
| Director | இயக்குநர் | MD |
| Accounts | கணக்கு | finance |
| Fleet manager | ஃப்ளீட் மேனேஜர் | |
| Store keeper | ஸ்டோர் கீப்பர் | |
