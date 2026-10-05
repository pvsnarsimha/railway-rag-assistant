# Live-tracking pipeline

How a live-status request should flow, and where each step lives. Long,
multi-day trains (e.g. 12295, three calendar days) are the critical case:
providers return bare "HH:MM" times, so the same clock time occurs on day 1,
2 and 3, and a wrong "actual" can make the whole route look reached.

```
User opens a train
  [1] Cache check (30-60 s, shared per train)            api_cache.py          (exists)
  [2] Collect from all sources in parallel, with timeout RailKit / RailRadar /  (partly: fallback
      RapidAPI, crowd GPS + cell towers, saved history   rapidapi, crowd, cell   exists, not parallel)
  [3] Normalize to one internal format                   -                     (TODO)
  [4] Validate every reading                             timeline_validation.py (DONE, this change)
  [5] Fuse into one position + delay                     crowd_position_tracking.py (exists)
  [6] Predict ahead (ETA/ETD = ETA + halt, delay model)  app.py / delay_prediction.py (exists)
  [7] Respond + log to own history                       delay_accuracy_store.py (exists)
```

## Step 4 rules (timeline_validation.py)
1. **Day-aware time.** Day number per stop comes from the scheduled times
   wrapping past midnight; day 1 is anchored to a real calendar date (a dated
   provider timestamp, else the date that puts the current stop's schedule
   closest to now). Every bare "HH:MM" reading is placed on the day nearest to
   that stop's own scheduled time.
2. **Reject only what is provable**, and only on stops the provider still
   marks `upcoming` (current/passed stops are never touched):
   - the reading is ahead of the clock;
   - the stop is scheduled > 90 min in the future (the train would have to be
     hours early - it is the previous run's record);
   - the reading is earlier than the previous stop's reading.
3. RailRadar "passed" entries are filtered with the same tests.
4. With no reliable calendar anchor the validator changes nothing.

Rejected readings keep `actual_rejected: <reason>` on the event for debugging.

## Still to build
- Step 3: one normalized provider format + automatic ranking/failover.
- Step 2: parallel collection with per-source timeouts and health tracking.
- Step 7 is already covered for predicted-vs-actual per station (`delay_accuracy_store.py`
  writes one row per train/date/station when a real actual is known). A table of *every*
  raw live reading (all sources, with timestamps) would go further and is not built.
- Validate provider data for stops marked `passed` (needs real long-train
  samples; none were available when this was written).
