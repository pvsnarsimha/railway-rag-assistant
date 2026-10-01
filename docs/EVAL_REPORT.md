# Evaluation report

- version `1.0.0`, commit `b1b71df`, generated 2026-10-01 05:35:02
- python 3.11.15 on Linux x86_64; retrieval backend: **tfidf-svd-lsa (fallback)**

## 1. Intent routing

67 labelled queries. **Accuracy 80.6%**, macro-F1 0.828, entity extraction 83.9% (31 fields).

| intent | support | precision | recall | F1 |
|---|---:|---:|---:|---:|
| alternative_route | 4 | 1.00 | 0.50 | 0.67 |
| crowd_prediction | 4 | 1.00 | 0.75 | 0.86 |
| general_faq | 16 | 0.58 | 0.88 | 0.70 |
| help | 4 | 0.80 | 1.00 | 0.89 |
| live_status | 8 | 0.88 | 0.88 | 0.88 |
| nearby_stations | 5 | 1.00 | 0.80 | 0.89 |
| pnr_status | 6 | 1.00 | 1.00 | 1.00 |
| seat_availability | 6 | 1.00 | 0.67 | 0.80 |
| train_schedule | 6 | 0.83 | 0.83 | 0.83 |
| trains_between | 8 | 1.00 | 0.62 | 0.77 |

### Routing misses (13)

| query | expected | got |
|---|---|---|
| track train 12009 live | live_status | general_faq |
| check berth availability 12627 SBC to NDLS | seat_availability | general_faq |
| is there availability for 12423 on 15-12-2026 | seat_availability | general_faq |
| stops of train 12627 | train_schedule | general_faq |
| which trains go from Chennai to Bangalore | trains_between | general_faq |
| find trains Pune to Hyderabad tomorrow | trains_between | general_faq |
| show me trains Lucknow to Varanasi | trains_between | general_faq |
| nearby railway stations | nearby_stations | general_faq |
| other ways to reach Mumbai from Kolkata | alternative_route | general_faq |
| suggest backup route Bangalore to Pune | alternative_route | train_schedule |
| is sleeper class busy on 12009 | crowd_prediction | general_faq |
| how do I book a ticket on IRCTC | general_faq | help |
| how can I get a refund if train is late | general_faq | live_status |

### Entity extraction misses (5)

- `track train 12009 live` train_number: expected '12009', got None
- `check berth availability 12627 SBC to NDLS` train_number: expected '12627', got None
- `is there availability for 12423 on 15-12-2026` train_number: expected '12423', got None
- `stops of train 12627` train_number: expected '12627', got None
- `is sleeper class busy on 12009` train_number: expected '12009', got None

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
| classify | 1340 | 0.96 | 1.124 | 1.232 | 0.97 |
| rag_retrieve_top5 | 100 | 19.54 | 41.85 | 58.71 | 23.4 |
| http_healthz | 200 | 5.09 | 7.47 | 9.81 | 5.32 |
| http_chat_faq_offline | 60 | 46.34 | 88.43 | 102.82 | 52.08 |

Latency excludes network, cold start and any external provider (RailKit/RailRadar/LLM) time. See docs/EVALUATION.md.
