# Answer-quality evaluation

- mode: **offline (no LLM, extractive fallback)**
- generated 2026-10-01 09:35 UTC

| metric | result |
|---|---:|
| fact recall (required facts present) | 91.7% |
| answers with every required fact | 90.0% |
| gold KB entry retrieved | 93.3% |
| required facts still present in the text handed to the LLM (after compression) | 86.7% |
| answers stating an unsupported number | 3.3% |
| out-of-scope questions declined | 0.0% (6 questions) |
| live-data-unavailable answered honestly | 100.0% (4 questions) |
| latency p50 / p95 | 27.2 / 76.9 ms |

30 factual questions. Facts are matched as strings, so this measures presence of correct facts and absence of invented numbers, not wording quality. See docs/EVALUATION.md.

## Factual answers missing a required fact (3)

- **id-proof**: Which photo IDs are accepted while travelling on an e-ticket? -> missing ['aadhaar', 'passport']
- **child-free**: Do children under 5 need a ticket? -> missing ['free']
- **women-helpline**: Which number should a woman call for safety help on a train? -> missing ['182']

## Answers with numbers not in the question or sources (1)

- **women-helpline**: ['08', '12951', '15', '200', '2026', '2415678901']

## Out-of-scope questions NOT declined (6)

- What is the weather in Paris today? -> answered: "Here's what I found for: "What is the weather in Paris today?"


• (Train Operations) A train's reported delay is the difference between its..."
- What is the price of Bitcoin right now? -> answered: "Here's what I found for: "What is the price of Bitcoin right now?"


• (PNR & Booking Status) The reservation chart is prepared in two stage..."
- Who won the cricket match yesterday? -> answered: "Here's what I found for: "Who won the cricket match yesterday?"


• (Cancellation & Refunds) On one e-ticket where some passengers are confi..."
- Write me a poem about the ocean -> answered: "Here's what I found for: "Write me a poem about the ocean"


• (PNR & Booking Status) A second chart is prepared about 30 minutes before dep..."
- Write a python function to sort a list -> answered: "Here's what I found for: "Write a python function to sort a list"


• (Glossary) Railway glossary A to F: berth (a bed in a coach), bogie (f..."
- Give me a recipe for chicken biryani -> answered: "Here's what I found for: "Give me a recipe for chicken biryani"


• (Booking Process) Chief Reservation Supervisors at important stations ap..."

## Live-data questions not handled honestly (0)

