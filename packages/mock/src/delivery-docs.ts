/**
 * DELIVERY PAPER, AS OCR TEXT.
 *
 * One real load's three papers, as an OCR pass returns them: the crusher's
 * printed DC, the transporter's handwritten received challan and the
 * builder's handwritten delivery memo. Sample input for the cross-check
 * screen only — nothing in the cross-check reads these names.
 *
 * Its own module rather than a block in data.ts, so the sample set can change
 * without touching the seeded dataset every other screen reads.
 */
export const DELIVERY_DOC_SAMPLES: { id: string; text: string }[] = [
  {
    id: 'Delivery challan (printed)',
    text: `OM SAKTHI ENTERPRISES
GSTIN/UIN #: 33AAFFO0815G1ZL
Delivery Challan
Date: 13-03-2026 09:47 am
DC/Ref #: 6630
OUTGOING TRIP
Party: NEW RAJ AGENCIES
Loading: OMS CRUSHER
UnLoading: PARTY SITE
Truck #: TN 22 EH 9857
Item: VSI 12 MM
Empty Qty: 17.35 MT
Full Qty: 68.10 MT
Net Qty: 50.75 MT
Payment Mode Credit`,
  },
  {
    id: 'Material received (handwritten)',
    text: `NEW RAJ AGENCIES
(Building Material Suppliers)
MATERIAL RECEIVED CHALLAN
No. 013 Date: 13.3.26
Vehicle No. TN22EH9857
Party: GMS - Muthukadu
Place:
Material: 12 MM Jelly
Load Wt 50 Empty Wt
Net Wt 50.75 MT
Customer Signature Driver Signature`,
  },
  {
    id: 'Delivery memo (handwritten)',
    text: `GMS ELEGANT BUILDERS (I) PVT LTD, ERODE
DELIVERY MEMO FOR BULK MATERIALS
No. 1648
Project Site: MCC
P.O. No. 9784, 9785, 9786
Date: 13.3.26
Supplier: JSR Blue Metal
Lorry No. TN 22 EH 9857
Description: 12 MM Jelly
Quantity Recd: 50.75 MT
Location of Unloading: RMC Plant`,
  },
];
