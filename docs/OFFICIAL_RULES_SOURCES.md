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

## Verification status of the added entries

- **verified**: figure confirmed from an official page or PIB release found by search.
- **partly verified**: source found but exact per-class figures not seen in full (luggage weights, accepted IDs, ticket transfer).
- **statute; check current amount**: text of the Act, but the prescribed amount can be revised (ticketless-travel excess charge, alarm-chain fine).

## Keeping it current

1. Re-read the pages above every month or after news of a rule change.
2. Update the matching `rule-*` entry and its `source`/`verified` fields.
3. Run `cd backend && python -m pytest tests`.
