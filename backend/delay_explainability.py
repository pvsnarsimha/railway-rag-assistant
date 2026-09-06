"""
delay_explainability.py
------------------------
FEATURE: Train Delay Prediction with Explainable AI.

Wraps the existing delay_prediction ensemble (RandomForest + MLPRegressor +
optional PyTorch LSTM, blended by a RidgeCV meta-learner — see
delay_prediction.py) with real SHAP (SHapley Additive exPlanations)
attribution, instead of hand-waving at which input "probably" mattered.

WHICH SHAP, AND WHY: this uses `shap.KernelExplainer` over the WHOLE
blended ensemble output (RF + MLP + LSTM-when-available + the RidgeCV
meta-learner, called as one black-box function via
delay_prediction.ensemble_predict_batch) — not just a fast TreeExplainer on
the RandomForest alone. KernelExplainer is model-agnostic: it estimates
each feature's Shapley value by sampling coalitions of "present" vs.
"replaced by a background reference row" features and observing how the
ensemble's OWN combined output moves, so the explanation is honest about
what the ensemble as a whole actually did — including the LSTM's
contribution when torch is installed — rather than only explaining one of
its three component models and assuming the rest agree. The real tradeoff:
KernelExplainer is slower than a tree-structural explainer, so `nsamples`
below is capped to keep one explanation call in the ~1-3s range, and the
background reference set is summarized down to a handful of weighted
k-means prototypes (`shap.kmeans`) rather than run against hundreds of raw
rows — standard SHAP practice for KernelExplainer, and it keeps the
coalition-sampling cost bounded without biasing the attribution.

WEATHER IS HANDLED SEPARATELY, ON PURPOSE: weather is not one of the
ensemble's 9 trained features (see delay_prediction.FEATURE_NAMES) — it's
folded on TOP of the ensemble's output as its own bounded, documented
additive term (see weather.py's weather_delay_component_minutes and
app.py's websocket handler, which already does this same fold for the
live-tracking headline figure). So it's surfaced here as an explicit,
separately-computed attribution line — its own real minutes value, not a
SHAP estimate, since SHAP was never shown it as an input — placed on equal
footing with the 9 SHAP-attributed features in the final ranked breakdown,
so "why" is never silently missing the single biggest real-world delay
driver this project tracks.

HISTORICAL COMPARISON ("this train usually runs closest to on-time on
Tuesdays") is a separate, genuinely real signal — see historical_delay.py,
which pulls this train's own completed-journey history from the provider.
It's folded in here only as a plain-English headline string the caller
supplies (never computed inline — that needs real, potentially slow
provider calls the caller may or may not want to pay for), never as a
numeric SHAP-style attribution line, since it isn't one of the model's
inputs — it's independent diagnostic context.
"""

from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

import delay_prediction

# Coalition samples per explanation call. KernelExplainer's cost scales
# with this directly; 120 keeps a single explanation comfortably under a
# couple of seconds on the 9-feature input this model uses, while still
# giving the Shapley estimate enough samples to be stable run to run.
_SHAP_NSAMPLES = 120

# Background reference rows are summarized to this many weighted k-means
# prototypes before being handed to KernelExplainer (see module docstring).
_BACKGROUND_KMEANS_K = 12

_explainer = None
_explainer_model_name = None


FEATURE_LABELS = {
    "distance_km": "journey distance",
    "hour_of_day": "time of day",
    "is_weekend": "weekend/long-weekend travel",
    "is_high_demand_season": "festival/holiday rush season",
    "route_progress_ratio": "route position",
    "current_delay_minutes": "currently reported delay",
    "is_unreserved_class": "unreserved-class boarding overruns",
    "recent_delay_trend_per_stop": "recent delay trend",
    "speed_deficit_kmph": "current running speed vs. typical",
}


def _dynamic_label(name: str, value: float) -> str:
    """A few features read better with the actual resolved value folded
    into the label — matching the style of the worked examples this
    feature was requested from ("time of day (peak hour)", "route
    position")."""
    if name == "hour_of_day":
        hour = int(round(value)) % 24
        if 7 <= hour <= 10 or 17 <= hour <= 21:
            return f"time of day ({hour:02d}:00, peak hour)"
        return f"time of day ({hour:02d}:00)"
    if name == "route_progress_ratio":
        return f"route position ({round(value * 100)}% through the journey)"
    if name == "recent_delay_trend_per_stop":
        if value > 0.5:
            direction = "worsening"
        elif value < -0.5:
            direction = "improving"
        else:
            direction = "flat"
        return f"delay trend ({direction}, {value:+.1f} min/stop)"
    if name == "current_delay_minutes":
        return f"currently reported delay (~{value:.0f} min)"
    if name == "speed_deficit_kmph":
        return "running slower than typical right now" if value > 2 else "running speed close to typical"
    if name == "distance_km":
        return f"journey distance (~{value:.0f} km)"
    return FEATURE_LABELS.get(name, name)


def _get_explainer():
    """Lazy singleton — building a KernelExplainer needs the fitted
    ensemble plus a summarized background set, both cheap to build once
    and safe to reuse across every explanation call in this process.
    Rebuilt automatically if the underlying model was retrained (its
    _model_name changes) so a stale explainer never silently persists
    against a model that no longer exists."""
    global _explainer, _explainer_model_name
    model = delay_prediction.get_model()
    current_name = delay_prediction._model_name
    if _explainer is not None and _explainer_model_name == current_name:
        return _explainer

    import shap

    background = delay_prediction.get_background_matrix(n=80)
    try:
        summarized = shap.kmeans(background, min(_BACKGROUND_KMEANS_K, len(background)))
    except Exception:
        summarized = background  # kmeans is an optimization only — the raw sample still works

    def _f(X):
        return delay_prediction.ensemble_predict_batch(model, np.asarray(X, dtype=float))

    _explainer = shap.KernelExplainer(_f, summarized)
    _explainer_model_name = current_name
    return _explainer


@dataclass
class AttributionLine:
    key: str
    label: str
    minutes: float          # signed — positive = adds delay, negative = reduces it
    pct_of_total: int = 0
    is_shap: bool = True    # False only for the weather line (added post-model, not SHAP-attributed)


@dataclass
class DelayExplanation:
    prediction: "delay_prediction.DelayPrediction"
    attributions: List[AttributionLine] = field(default_factory=list)
    historical_headline: Optional[str] = None
    explainer_method: str = "SHAP KernelExplainer (model-agnostic) over the full blended ensemble"
    narrative: List[str] = field(default_factory=list)   # ready-to-render "40% due to X" lines
    shap_error: Optional[str] = None  # set (not raised) if SHAP itself failed — prediction still returned


def explain_delay(
    distance_km: Optional[float] = None,
    date_ddmmyyyy: Optional[str] = None,
    time_hhmm: Optional[str] = None,
    route_progress_ratio: Optional[float] = None,
    current_delay_minutes: Optional[int] = None,
    travel_class: Optional[str] = None,
    recent_delay_trend_per_stop: Optional[float] = None,
    avg_speed_kmph: Optional[float] = None,
    recent_delay_basis: Optional[str] = None,
    avg_speed_basis: Optional[str] = None,
    weather_component_minutes: float = 0.0,
    weather_basis: Optional[str] = None,
    historical_headline: Optional[str] = None,
) -> DelayExplanation:
    """
    Same inputs as delay_prediction.predict_delay(), plus the weather
    component (already computed by the caller — see weather.py) and an
    optional pre-computed historical headline string. Returns the same
    headline prediction PLUS a ranked, percentage-attributed "why" — the
    single-figure prediction is guaranteed to still come back even if SHAP
    itself throws (shap_error is set instead, attributions stays empty).
    """
    model = delay_prediction.get_model()
    resolved = delay_prediction.resolve_features(
        distance_km=distance_km, date_ddmmyyyy=date_ddmmyyyy, time_hhmm=time_hhmm,
        route_progress_ratio=route_progress_ratio, current_delay_minutes=current_delay_minutes,
        travel_class=travel_class, recent_delay_trend_per_stop=recent_delay_trend_per_stop,
        avg_speed_kmph=avg_speed_kmph, recent_delay_basis=recent_delay_basis, avg_speed_basis=avg_speed_basis,
    )

    base_predicted = delay_prediction.ensemble_predict_batch(model, resolved.X)[0]
    total_predicted = max(0, round(float(base_predicted) + weather_component_minutes))

    confidence = "High" if resolved.real_signal_count >= 4 else ("Moderate" if resolved.real_signal_count >= 2 else "Low")
    low_minutes, high_minutes = delay_prediction._confidence_band(total_predicted, confidence)

    basis = list(resolved.basis)
    if weather_component_minutes:
        basis.append(f"weather: {weather_basis}" if weather_basis else f"weather adds ~{weather_component_minutes:.0f} min")

    prediction = delay_prediction.DelayPrediction(
        predicted_delay_minutes=total_predicted, confidence=confidence, basis=basis,
        low_minutes=low_minutes, high_minutes=high_minutes,
        model_name=delay_prediction._model_name or "RandomForestRegressor (scikit-learn)",
    )

    shap_row = None
    shap_error = None
    try:
        explainer = _get_explainer()
        raw = explainer.shap_values(resolved.X, nsamples=_SHAP_NSAMPLES, silent=True)
        shap_row = np.asarray(raw, dtype=float).reshape(-1)
    except Exception as exc:
        # SHAP must never take down the prediction path — degrade to "no
        # per-feature breakdown available this time" instead of a 500.
        shap_error = f"{type(exc).__name__}: {exc}"

    attributions: List[AttributionLine] = []
    if shap_row is not None and len(shap_row) == len(delay_prediction.FEATURE_NAMES):
        for name, shap_val in zip(delay_prediction.FEATURE_NAMES, shap_row):
            attributions.append(AttributionLine(
                key=name, label=_dynamic_label(name, resolved.values.get(name, 0.0)),
                minutes=float(shap_val), is_shap=True,
            ))
    if weather_component_minutes:
        attributions.append(AttributionLine(
            key="weather", label="weather at current position",
            minutes=float(weather_component_minutes), is_shap=False,
        ))

    total_abs = sum(abs(a.minutes) for a in attributions) or 1.0
    for a in attributions:
        a.pct_of_total = round(100 * abs(a.minutes) / total_abs)
    attributions.sort(key=lambda a: abs(a.minutes), reverse=True)

    narrative = [f"{a.pct_of_total}% due to {a.label}" for a in attributions if a.pct_of_total >= 5]

    return DelayExplanation(
        prediction=prediction, attributions=attributions,
        historical_headline=historical_headline, narrative=narrative, shap_error=shap_error,
    )
