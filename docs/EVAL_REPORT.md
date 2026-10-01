# Evaluation report

- version `1.1.0`, commit `60f4d4c`, generated 2026-10-01 09:35:09
- python 3.11.15 on Linux x86_64; retrieval backend: **tfidf-svd-lsa (fallback)**

## 1. Intent routing

**Unseen-data accuracy (blind set, 39 queries never used to tune the router): 76.9%.** Before the router fixes the same set scored 56.4%.

Regression sets (the router was developed against these, so they guard against breakage and say little about new wording): 197 queries, **100.0%**, macro-F1 1.000. Entity extraction 93.9% (99 fields).

| set | kind | queries | accuracy |
|---|---|---:|---:|
| dev | tuned | 67 | 100.0% |
| heldout | tuned | 66 | 100.0% |
| validation | tuned | 59 | 100.0% |
| regression | tuned | 5 | 100.0% |
| blind | blind | 39 | 76.9% |

| intent | support | precision | recall | F1 |
|---|---:|---:|---:|---:|
| alternative_route | 11 | 1.00 | 1.00 | 1.00 |
| crowd_prediction | 11 | 1.00 | 1.00 | 1.00 |
| general_faq | 56 | 1.00 | 1.00 | 1.00 |
| help | 14 | 1.00 | 1.00 | 1.00 |
| live_status | 24 | 1.00 | 1.00 | 1.00 |
| nearby_stations | 12 | 1.00 | 1.00 | 1.00 |
| pnr_status | 12 | 1.00 | 1.00 | 1.00 |
| seat_availability | 17 | 1.00 | 1.00 | 1.00 |
| train_schedule | 16 | 1.00 | 1.00 | 1.00 |
| trains_between | 24 | 1.00 | 1.00 | 1.00 |

### Routing misses (9)

| query | expected | got |
|---|---|---|
| has 12301 crossed Kanpur yet | live_status | general_faq |
| 12627 status | live_status | general_faq |
| is the Rajdhani 12951 on schedule right now | live_status | train_schedule |
| I want to book 12627, is there space | seat_availability | general_faq |
| at what time does 22691 reach Bangalore | train_schedule | live_status |
| will 12423 be overcrowded on Saturday | crowd_prediction | general_faq |
| nearby railhead for Dehradun | nearby_stations | general_faq |
| I can't get a train Delhi to Chennai, what else can I do | alternative_route | trains_between |
| suggest a detour route from Mumbai to Patna | alternative_route | train_schedule |

### Entity extraction misses (6)

- `has 12301 crossed Kanpur yet` train_number: expected '12301', got None
- `12627 status` train_number: expected '12627', got None
- `is the Rajdhani 12951 on schedule right now` train_number: expected '12951', got '12951'
- `I want to book 12627, is there space` train_number: expected '12627', got None
- `at what time does 22691 reach Bangalore` train_number: expected '22691', got '22691'
- `will 12423 be overcrowded on Saturday` train_number: expected '12423', got None

## 2. RAG retrieval

51 labelled questions over 95 KB entries. **Hit@1 62.7% · Hit@3 86.3% · Hit@5 90.2% · MRR 0.746**

### Retrieval misses (4)

- 'Why are trains delayed?' wanted one of ['delay-causes'], got ['train-precedence-crossing', 'chart-preparation', 'gk-luxury-trains']
- 'What facilities are available at stations?' wanted one of ['station-facilities'], got ['station-hierarchy', 'outside-food-rules', 'helpline-numbers']
- 'Money deducted but ticket not booked' wanted one of ['booking-payment-failed'], got ['e-ticket-vs-i-ticket', 'rule-cancel-time-slabs', 'rule-train-late-3-hours']
- 'Can I take my dog on the train?' wanted one of ['pets-on-train'], got ['emergency-procedures', 'liquor-alcohol-rules', 'gk-history-first-trains']

## 3. Latency (in-process, providers disabled)

| operation | n | p50 ms | p95 ms | p99 ms | mean ms |
|---|---:|---:|---:|---:|---:|
| classify | 1340 | 1.136 | 1.243 | 1.38 | 1.137 |
| rag_retrieve_top5 | 100 | 20.24 | 46.46 | 66.06 | 25.33 |
| http_healthz | 200 | 4.45 | 6.49 | 9.24 | 4.69 |
| http_chat_faq_offline | 60 | 43.85 | 84.12 | 90.15 | 51.71 |

Latency excludes network, cold start and any external provider (RailKit/RailRadar/LLM) time. See docs/EVALUATION.md.
