# Official sources for railway passenger rules

The chatbot's rule entries (`backend/data/knowledge_base.json`, ids starting `rule-`) each carry a
`source` (official link) and a `verified` flag. Rules change often, so re-check them regularly.

## Where to get the rules

| Topic | Official source |
|---|---|
| The law (Railways Act, 1989: penalties, alarm chain, ticketless travel) | https://www.indiacode.nic.in/bitstream/123456789/15416/1/the_railways_act,_1989.pdf |
| Refund and cancellation rules | https://indianrailways.gov.in/railwayboard/uploads/directorate/coaching/pdf/RefundRules.pdf |
| Refund rules and TDR filing (IRCTC copy) | https://contents.irctc.co.in/en/REFUND%20RULES%20wef%2012-Nov-15.pdf |
| Tatkal FAQ (timings, charges) | https://contents.irctc.co.in/en/TatkalFaq.html |
| Advance reservation period (60 days, from 1 Nov 2024) | https://www.pib.gov.in/PressReleasePage.aspx?PRID=2065790&reg=48&lang=2 |
| Reservation chart timing (8 hours / 21:00 previous day, 2025) | https://cr.indianrailways.gov.in/view_detail.jsp?lang=0&id=0%2C4%2C268&dcd=9856&did=1751953668715F08FEB7D1A698517544F5A29DD31BC5D |
| Second chart 30 minutes before departure | https://www.pib.gov.in/PressReleasePage.aspx?PRID=1662084 |
| Commercial Manual (luggage, booking, delivery) | https://indianrailways.gov.in/railwayboard/uploads/codesmanual/CommManual-I/ComercialManualCh8_data.htm |
| Luggage (Western Railway page) | https://wr.indianrailways.gov.in/view_section.jsp?lang=0&id=0,6,629,634 |
| Live status and schedules (NTES) | https://enquiry.indianrail.gov.in/ |
| Ticketing, quotas, FAQs (IRCTC) | https://www.irctc.co.in/ |
| Complaints | Rail Madad (railmadad.indianrailways.gov.in), helpline 139 |

## Second round of checks (four items that were unconfirmed)

| Item | Result | Sources |
|---|---|---|
| Luggage per class | Confirmed: AC First 70/150 kg, AC 2-Tier and First 50/100, AC 3-Tier and Chair Car 40/40, Sleeper 40/80, Second 35/70; excess at 1.5x luggage rate; boxes up to 100x60x25 cm; larger goods go in the luggage van | PIB (https://www.pib.gov.in/Pressreleaseshare.aspx?PRID=1541065&reg=48&lang=2), Railway Minister statement Dec 2025 (https://www.onmanorama.com/travel/travel-news/2025/12/18/indian-railways-trains-to-charge-overweight-luggage.amp.html, https://www.thehitavada.com/Encyc/2025/12/19/passengers-to-pay-charges-for-carrying-extra-luggage-in-trains-says-vaishnaw.html), Commercial Manual |
| Accepted ID proofs | Confirmed: IRCTC prescribed list (Aadhaar, Passport, Voter ID, Driving Licence, PAN, government / PSU / municipal photo ID, student ID, bank passbook with photo, credit card with laminated photo). Without an original ID all passengers on the ticket are treated as ticketless | IRCTC FAQ (https://contents.irctc.co.in/en/etktfaq.html), ID list (https://contents.irctc.co.in/en/listOfGovtAuthorizedIDCards.pdf) |
| Ticket transfer | Confirmed: family members 24 h before; students and marriage parties 48 h via head of institution or group; government servants and NCC 24 h; approved by Chief Reservation Supervisor | Indian Railways (https://ser.indianrailways.gov.in/view_section.jsp?lang=0&id=0,2,406,453,564,1155,1183), IRCTC (https://contents.irctc.co.in/en/AMENDMENT_IN_Etkt.pdf) |
| Ticketless penalty | **Changed**: minimum Rs 500 (was Rs 250) from 1 July 2026 under the Jan Vishwas (Amendment of Provisions) Act, 2026 (Sections 137, 138, 142). Other fines (women's coach Rs 2,500, smoking/hawking/begging Rs 2,000) come from press reports of the Act | PIB Bill (https://static.pib.gov.in/WriteReadData/specificdocs/documents/2026/apr/doc202644839301.pdf), PRS (https://prsindia.org/billtrack/the-jan-vishwas-amendment-of-provisions-bill-2026), SCC Online, Business Standard, Deccan Chronicle |
| Chart timing | **Changed**: from 30 Dec 2025 first chart by 20:00 previous day for 05:01-14:00 departures; at least 10 hours before for other trains; second chart 30 min before. The July 2025 "8 hours" rule was the earlier phase | Hitavada (https://www.thehitavada.com/Encyc/2025/12/27/now-railway-reservation-charts-to-be-ready-one-day-in-advance.html), ixigo, gConnect (Railway Board instructions) |

Still to confirm on the official pages: the alarm-chain fine (Section 141) under the 2026 amendments, and the
exact Rs amounts for the smaller penalties, which are from press reports.

## Verification status of the added entries

- **verified**: figure confirmed from an official page or PIB release found by search.
- **partly verified**: source found but exact per-class figures not seen in full (luggage weights, accepted IDs, ticket transfer).
- **statute; check current amount**: text of the Act, but the prescribed amount can be revised (ticketless-travel excess charge, alarm-chain fine).

## Keeping it current

1. Re-read the pages above every month or after news of a rule change.
2. Update the matching `rule-*` entry and its `source`/`verified` fields.
3. Run `cd backend && python -m pytest tests`.
