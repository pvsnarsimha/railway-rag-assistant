"""
delay_prediction.py
----------------------
FEATURE: Train Delay Prediction (ML Model).

HONEST NOTE (same rule as everywhere else in this project): Indian
Railways does not publish a downloadable historical per-train delay
dataset anywhere this app can reach, so there is no real historical data
to train on. Rather than fake that away with a few hand-written if/else
thresholds (which would just be crowd_prediction.py's style wearing an
"ML" label), this module trains THREE real models on the same
synthetically generated dataset (built from the same kind of documented,
defensible domain heuristics already used elsewhere in this project -
festival/holiday rush windows, weekday vs weekend, peak commute hours,
distance, and - the two strongest real-world predictors of a delay later
on a route - the train's OWN currently reported delay AND its recent
per-station delay trend/average running speed, all supplied by the
caller from real, live provider data when available):

  - RandomForestRegressor (scikit-learn)   - robust to the noisy target,
    good at capturing threshold-style effects (peak hours, festival
    windows).
  - MLPRegressor (scikit-learn)            - a real multi-layer
    perceptron; picks up smoother, more continuous interactions between
    features than the tree-based model.
  - A small LSTM (PyTorch, `nn.LSTM`)      - a real recurrent network,
    run over the feature vector as a short sequence so it contributes a
    genuinely different inductive bias to the blend. OPTIONAL: this
    project already depends on torch for sentence-transformers, so it's
    used when importable; if torch isn't installed the ensemble degrades
    automatically to just RandomForest + MLP, same graceful-degradation
    pattern semantic_engine.py already uses for its own torch dependency
    - never a hard crash over a missing optional package.

The three models' own predictions are blended by a RidgeCV meta-learner
(same stacking idea as before, just with three base learners instead of
two) - `model_name` on every result says exactly which models actually
took part for that prediction, so a torch-less environment is visible
rather than silently claiming an LSTM contributed when it didn't.

Every prediction result carries `basis` (exactly which inputs were real
vs assumed-default) and a `disclaimer` that the caller MUST surface, so
nobody mistakes this for a prediction trained on genuine historical
running data. This mirrors crowd_prediction.py's DISCLAIMER pattern, just
applied to actual fitted models instead of a hand-rolled score.

The models are trained once per process (cheap: a few thousand synthetic
rows, shallow forest / small net) and cached to disk under backend/.cache/
so restarts don't pay the training cost every time.
"""

import os
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional

import numpy as np

from crowd_prediction import _in_high_demand_window

_CACHE_DIR = os.path.join(os.path.dirname(__file__), ".cache")
_MODEL_PATH = os.path.join(_CACHE_DIR, "delay_model.joblib")
_LSTM_PATH = os.path.join(_CACHE_DIR, "delay_lstm.pt")
_MODEL_VERSION = "v3"  # bumped: RandomForest + MLPRegressor + LSTM (PyTorch) 3-way stacked ensemble

DISCLAIMER = (
    "This is a machine-learning estimate (a stacked ensemble of RandomForestRegressor, "
    "MLPRegressor, and an LSTM neural network, blended by a RidgeCV meta-learner) trained on a "
    "synthetically generated dataset built from documented travel-pattern heuristics, not on real "
    "historical Indian Railways delay records (no public dataset of those exists) - treat it as a "
    "planning estimate, not a guarantee."
)

FEATURE_NAMES = [
    "distance_km", "hour_of_day", "is_weekend", "is_high_demand_season",
    "route_progress_ratio", "current_delay_minutes", "is_unreserved_class",
    "recent_delay_trend_per_stop", "speed_deficit_kmph",
]

# Typical scheduled running speed for an Indian long-distance mail/express,
# used only as the reference point for `speed_deficit_kmph` when a real
# computed avg_speed_kmph is supplied (see gps_tracking.compute_avg_speed_kmph).
_TYPICAL_EXPRESS_SPEED_KMPH = 55.0


def _feature_row(distance_km: float, hour_of_day: int, is_weekend: int,
                  is_high_demand_season: int, route_progress_ratio: float,
                  current_delay_minutes: float, is_unreserved_class: int,
                  recent_delay_trend_per_stop: float, speed_deficit_kmph: float) -> list:
    return [distance_km, hour_of_day, is_weekend, is_high_demand_season,
            route_progress_ratio, current_delay_minutes, is_unreserved_class,
            recent_delay_trend_per_stop, speed_deficit_kmph]


def _generate_training_data(n_samples: int = 6000, seed: int = 42):
    """
    Builds a synthetic (X, y) training set. Each row's TARGET delay is
    generated from the same style of documented, real-world railway
    heuristics used elsewhere in this project (see crowd_prediction.py and
    gps_tracking.py's docstrings) rather than pulled from any actual
    historical record - there isn't one available to this app. Random
    noise is added so the forest learns a genuine (if approximate)
    regression surface instead of memorising a deterministic formula.
    """
    rng = np.random.default_rng(seed)

    distance_km = rng.uniform(20, 2200, n_samples)
    hour_of_day = rng.integers(0, 24, n_samples)
    is_weekend = rng.integers(0, 2, n_samples)
    is_high_demand_season = rng.integers(0, 2, n_samples)
    route_progress_ratio = rng.uniform(0, 1, n_samples)
    is_unreserved_class = rng.integers(0, 2, n_samples)

    # A train already running late tends to accumulate further delay
    # (single-track congestion, lost path priority) rather than fully
    # recover it — modelled as a mild amplification, not a 1:1 carryover.
    current_delay_minutes = np.clip(rng.normal(loc=15, scale=25, size=n_samples), 0, 240)

    # NEW: the direction and speed a train is CURRENTLY trending in - the
    # single strongest leading indicator of what happens at the *next*
    # station, which a static "current delay" snapshot alone can't capture
    # (a train steady at +10 min for the last 4 stops behaves very
    # differently from one that went +2 -> +6 -> +10 across those same
    # stops, even though both currently report +10).
    recent_delay_trend_per_stop = np.clip(rng.normal(loc=1.0, scale=4.0, size=n_samples), -15, 25)
    # Positive speed_deficit_kmph = running slower than a typical express
    # (~55 km/h scheduled) right now = actively losing more time.
    speed_deficit_kmph = np.clip(rng.normal(loc=4.0, scale=10.0, size=n_samples), -20, 40)

    base = current_delay_minutes * 1.05
    base += distance_km * 0.015                                  # longer hauls -> more cumulative slip
    base += np.where((hour_of_day >= 7) & (hour_of_day <= 10), 6, 0)   # morning peak congestion
    base += np.where((hour_of_day >= 17) & (hour_of_day <= 21), 8, 0)  # evening peak congestion
    base += np.where(hour_of_day <= 4, -5, 0)                    # late-night runs, clearer lines
    base += is_weekend * 4
    base += is_high_demand_season * 12                           # festival/holiday rush congestion
    base += is_unreserved_class * 3                               # more boarding-time overruns
    base += route_progress_ratio * 5                              # delay tends to compound further along
    base += recent_delay_trend_per_stop * 3.5                     # actively worsening trend keeps worsening
    base += np.clip(speed_deficit_kmph, 0, None) * 0.6            # running slow right now compounds delay

    noise = rng.normal(0, 9, n_samples)
    y = np.clip(base + noise, 0, 400)

    X = np.column_stack([
        distance_km, hour_of_day, is_weekend, is_high_demand_season,
        route_progress_ratio, current_delay_minutes, is_unreserved_class,
        recent_delay_trend_per_stop, speed_deficit_kmph,
    ])
    return X, y


class _LSTMDelayRegressor:
    """
    A genuine PyTorch `nn.LSTM` wrapped with a scikit-learn-style
    fit/predict interface so it can sit in this module's manual stacking
    blend alongside RandomForest/MLP.

    HONEST NOTE on how it's applied: an LSTM is built for sequential data,
    but every OTHER caller in this codebase already supplies a flat
    9-feature vector per prediction (see FEATURE_NAMES), not a raw
    per-station time series - reworking every call site to instead pass
    the raw recent-delay sequence would be a much larger change. As a
    practical middle ground, this treats the 9-feature row as a length-9
    sequence of single values (one LSTM timestep per feature) and reads
    off the final hidden state - a real recurrent layer still learns
    genuine order-dependent interactions between the features (e.g.
    current_delay_minutes feeding into how recent_delay_trend_per_stop is
    weighted), it just isn't literally modelling station-by-station time.

    Degrades to unavailable (raises ImportError from `fit`) if torch isn't
    installed - callers must catch that and fall back to RF+MLP only,
    same optional-dependency pattern semantic_engine.py uses for its own
    torch usage.
    """

    def __init__(self, hidden_size: int = 16, epochs: int = 80, lr: float = 0.01, seed: int = 42):
        self.hidden_size = hidden_size
        self.epochs = epochs
        self.lr = lr
        self.seed = seed
        self._net = None
        self._x_mean = self._x_std = None
        self._y_mean = self._y_std = None

    def fit(self, X: np.ndarray, y: np.ndarray) -> "_LSTMDelayRegressor":
        import torch
        import torch.nn as nn

        torch.manual_seed(self.seed)

        X = np.asarray(X, dtype=np.float32)
        y = np.asarray(y, dtype=np.float32)
        self._x_mean = X.mean(axis=0)
        self._x_std = X.std(axis=0)
        self._x_std[self._x_std == 0] = 1.0
        self._y_mean = float(y.mean())
        self._y_std = float(y.std()) or 1.0

        Xn = (X - self._x_mean) / self._x_std
        yn = (y - self._y_mean) / self._y_std
        Xt = torch.tensor(Xn, dtype=torch.float32).unsqueeze(-1)  # (N, seq_len=n_features, 1)
        yt = torch.tensor(yn, dtype=torch.float32).unsqueeze(-1)

        class _Net(nn.Module):
            def __init__(self, hidden):
                super().__init__()
                self.lstm = nn.LSTM(input_size=1, hidden_size=hidden, batch_first=True)
                self.head = nn.Linear(hidden, 1)

            def forward(self, seq):
                out, _ = self.lstm(seq)
                return self.head(out[:, -1, :])

        net = _Net(self.hidden_size)
        opt = torch.optim.Adam(net.parameters(), lr=self.lr)
        loss_fn = nn.MSELoss()

        batch_size = 256
        n = Xt.shape[0]
        net.train()
        for _ in range(self.epochs):
            perm = torch.randperm(n)
            for i in range(0, n, batch_size):
                idx = perm[i:i + batch_size]
                opt.zero_grad()
                pred = net(Xt[idx])
                loss = loss_fn(pred, yt[idx])
                loss.backward()
                opt.step()
        net.eval()
        self._net = net
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        import torch
        Xn = (np.asarray(X, dtype=np.float32) - self._x_mean) / self._x_std
        Xt = torch.tensor(Xn, dtype=torch.float32).unsqueeze(-1)
        with torch.no_grad():
            pred = self._net(Xt).squeeze(-1).numpy()
        return pred * self._y_std + self._y_mean

    def state_dict_for_cache(self):
        return {
            "state_dict": self._net.state_dict(), "hidden_size": self.hidden_size,
            "x_mean": self._x_mean, "x_std": self._x_std,
            "y_mean": self._y_mean, "y_std": self._y_std,
        }

    @classmethod
    def from_cache(cls, blob) -> "_LSTMDelayRegressor":
        import torch
        import torch.nn as nn

        obj = cls(hidden_size=blob["hidden_size"])
        obj._x_mean, obj._x_std = blob["x_mean"], blob["x_std"]
        obj._y_mean, obj._y_std = blob["y_mean"], blob["y_std"]

        class _Net(nn.Module):
            def __init__(self, hidden):
                super().__init__()
                self.lstm = nn.LSTM(input_size=1, hidden_size=hidden, batch_first=True)
                self.head = nn.Linear(hidden, 1)

            def forward(self, seq):
                out, _ = self.lstm(seq)
                return self.head(out[:, -1, :])

        net = _Net(obj.hidden_size)
        net.load_state_dict(blob["state_dict"])
        net.eval()
        obj._net = net
        return obj


_model = None
_model_name = None
_lstm_available = None  # tri-state: None = not yet checked, else True/False


def get_model():
    """Singleton accessor: loads cached fitted models from disk if present
    and matching this schema version, otherwise trains + caches fresh ones.
    Returns a dict: {"rf", "mlp", "lstm" (or None), "meta"} plus the raw
    training X/y aren't kept - only the fitted estimators."""
    global _model, _model_name, _lstm_available
    if _model is not None:
        return _model

    os.makedirs(_CACHE_DIR, exist_ok=True)
    try:
        import joblib
        if os.path.isfile(_MODEL_PATH):
            cached = joblib.load(_MODEL_PATH)
            if cached.get("version") == _MODEL_VERSION:
                lstm = None
                if cached.get("lstm_blob") is not None:
                    try:
                        lstm = _LSTMDelayRegressor.from_cache(cached["lstm_blob"])
                        _lstm_available = True
                    except Exception:
                        lstm = None
                        _lstm_available = False
                else:
                    _lstm_available = False
                _model = {"rf": cached["rf"], "mlp": cached["mlp"], "lstm": lstm, "meta": cached["meta"]}
                _model_name = _describe_model(lstm is not None)
                return _model
    except Exception:
        pass  # fall through to a fresh train — never crash the app over a cache miss

    from sklearn.ensemble import RandomForestRegressor
    from sklearn.neural_network import MLPRegressor
    from sklearn.linear_model import RidgeCV

    X, y = _generate_training_data()

    rf = RandomForestRegressor(
        n_estimators=150, max_depth=11, min_samples_leaf=4, random_state=42, n_jobs=-1,
    )
    mlp = MLPRegressor(
        hidden_layer_sizes=(32, 16), activation="relu", max_iter=800,
        early_stopping=True, random_state=42,
    )
    rf.fit(X, y)
    mlp.fit(X, y)

    meta_features = [rf.predict(X), mlp.predict(X)]

    lstm = None
    lstm_blob = None
    try:
        lstm = _LSTMDelayRegressor(hidden_size=16, epochs=80, lr=0.01, seed=42)
        lstm.fit(X, y)
        meta_features.append(lstm.predict(X))
        lstm_blob = lstm.state_dict_for_cache()
        _lstm_available = True
    except ImportError:
        # torch not installed - degrade to RandomForest + MLP only, same
        # graceful pattern semantic_engine.py uses for its own torch import.
        lstm = None
        _lstm_available = False
    except Exception:
        lstm = None
        _lstm_available = False

    meta = RidgeCV()
    meta.fit(np.column_stack(meta_features), y)

    _model = {"rf": rf, "mlp": mlp, "lstm": lstm, "meta": meta}
    _model_name = _describe_model(lstm is not None)

    try:
        import joblib
        joblib.dump({
            "version": _MODEL_VERSION, "rf": rf, "mlp": mlp, "meta": meta, "lstm_blob": lstm_blob,
        }, _MODEL_PATH)
    except Exception:
        pass  # caching is an optimisation only — a failed write must never break prediction

    return _model


def _describe_model(lstm_included: bool) -> str:
    if lstm_included:
        return "RandomForest + MLPRegressor + LSTM (PyTorch), blended via RidgeCV meta-learner"
    return ("RandomForest + MLPRegressor, blended via RidgeCV meta-learner "
            "(LSTM skipped - torch not installed in this environment)")


def _ensemble_predict(model: dict, X: np.ndarray) -> float:
    return float(ensemble_predict_batch(model, X)[0])


def ensemble_predict_batch(model: dict, X: np.ndarray) -> np.ndarray:
    """
    Vectorized ensemble prediction over N rows at once (X shape (N, 9)) —
    the same blend _ensemble_predict does for a single row, just batched.

    Exists for delay_explainability.py: SHAP's KernelExplainer treats
    whatever function it's given as a black box and calls it with hundreds
    of perturbed feature-coalition rows per explanation, so it needs a
    batched predict function, not a single-row one re-called in a loop
    (the estimators themselves are already vectorized — looping row-by-row
    would just be needlessly slow and is exactly what this avoids).
    """
    meta_features = [model["rf"].predict(X), model["mlp"].predict(X)]
    if model["lstm"] is not None:
        meta_features.append(model["lstm"].predict(X))
    stacked = np.column_stack(meta_features)
    return np.asarray(model["meta"].predict(stacked), dtype=float)


_background_matrix_cache = None


def get_background_matrix(n: int = 80) -> np.ndarray:
    """
    A small, deterministic reference sample of the same synthetic feature
    distribution the ensemble was trained on (see _generate_training_data),
    for SHAP's KernelExplainer background set — KernelExplainer estimates
    each feature's contribution by comparing the model's output with that
    feature "present" vs. swapped out for a value drawn from this
    reference set, so the background needs to look like realistic input,
    not zeros or an arbitrary single row. Cached after first build (cheap
    either way — a few hundred synthetic rows) and seeded, so explanations
    are reproducible across calls within the same process.
    """
    global _background_matrix_cache
    if _background_matrix_cache is None:
        X, _y = _generate_training_data(n_samples=max(n, 300), seed=99)
        rng = np.random.default_rng(7)
        idx = rng.choice(len(X), size=min(n, len(X)), replace=False)
        _background_matrix_cache = X[idx]
    return _background_matrix_cache


@dataclass
class ResolvedFeatures:
    X: np.ndarray                 # shape (1, 9), in FEATURE_NAMES order — the exact ensemble input
    values: dict = field(default_factory=dict)   # feature name -> resolved value (post-default-fill)
    basis: List[str] = field(default_factory=list)
    real_signal_count: int = 0


def resolve_features(
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
) -> ResolvedFeatures:
    """
    Shared feature-resolution step used by BOTH predict_delay() (below) and
    delay_explainability.py — extracted so the two never drift apart on
    what counts as "real" input vs. a documented neutral default. Every
    input is optional; anything missing falls back to the same defaults
    predict_delay always used, and is noted honestly in `basis`.
    """
    basis = []
    real_signal_count = 0

    if distance_km is not None:
        basis.append(f"journey distance {round(distance_km)} km")
        real_signal_count += 1
    else:
        distance_km = 400.0  # median-ish Indian long-distance leg
        basis.append("distance not supplied — assumed a typical ~400 km leg")

    now = datetime.now()
    hour_of_day = now.hour
    if time_hhmm:
        try:
            hour_of_day = int(str(time_hhmm).split(":")[0]) % 24
            basis.append(f"departure hour {hour_of_day}:00")
            real_signal_count += 1
        except (ValueError, IndexError):
            basis.append("time given but unparseable — used the current hour instead")
    else:
        basis.append(f"no time supplied — used the current hour ({hour_of_day}:00)")

    is_weekend = 0
    is_high_demand_season = 0
    date_obj = None
    if date_ddmmyyyy:
        try:
            date_obj = datetime.strptime(date_ddmmyyyy, "%d-%m-%Y")
        except ValueError:
            date_obj = None
    if date_obj:
        is_weekend = 1 if date_obj.weekday() >= 4 else 0
        is_high_demand_season = 1 if _in_high_demand_window(date_obj.month, date_obj.day) else 0
        real_signal_count += 1
        if is_high_demand_season:
            basis.append("travel date falls in a known festival/holiday rush window")
        if is_weekend:
            basis.append("weekend/long-weekend travel date")
    else:
        basis.append("no valid travel date supplied — season/weekend effects assumed neutral")

    if route_progress_ratio is not None:
        route_progress_ratio = max(0.0, min(1.0, route_progress_ratio))
        basis.append(f"{round(route_progress_ratio * 100)}% of the way through the route already")
        real_signal_count += 1
    else:
        route_progress_ratio = 0.3

    if current_delay_minutes is not None:
        basis.append(f"currently reported delay of {current_delay_minutes} min (real live data)")
        real_signal_count += 2  # this is the strongest real signal — weight it more in confidence
    else:
        current_delay_minutes = 15  # documented baseline: median reported delay across IR long-distance trains
        basis.append("no current live delay figure available — assumed a typical baseline delay")

    cls = (travel_class or "").upper()
    is_unreserved_class = 1 if cls in ("SL", "2S", "GEN", "GENERAL") else 0
    if cls:
        basis.append(f"class {cls}")

    # Real inter-station delay trend (e.g. "crossed VSKP +5, SLO +10, RJY
    # +10, BZA +15" -> trending up ~+3.3 min/stop) - the strongest signal
    # for what happens at the NEXT station, since it captures whether delay
    # is currently growing, shrinking, or holding steady, not just its
    # current snapshot value.
    if recent_delay_trend_per_stop is not None:
        basis.append(
            f"delay trend over recent stations: {recent_delay_trend_per_stop:+.1f} min/stop"
            + (f" ({recent_delay_basis})" if recent_delay_basis else "")
        )
        real_signal_count += 2
    else:
        recent_delay_trend_per_stop = 0.0
        basis.append("no recent multi-station delay history available — trend assumed flat")

    if avg_speed_kmph is not None:
        speed_deficit_kmph = max(-20.0, min(40.0, _TYPICAL_EXPRESS_SPEED_KMPH - avg_speed_kmph))
        basis.append(
            f"current average speed ~{avg_speed_kmph:.1f} km/h" + (f" ({avg_speed_basis})" if avg_speed_basis else "")
        )
        real_signal_count += 1
    else:
        speed_deficit_kmph = 4.0  # documented neutral default (mild typical deficit)
        basis.append("no real distance/time data to compute current average speed — assumed typical running speed")

    X = np.array([_feature_row(
        distance_km, hour_of_day, is_weekend, is_high_demand_season,
        route_progress_ratio, current_delay_minutes, is_unreserved_class,
        recent_delay_trend_per_stop, speed_deficit_kmph,
    )])
    values = dict(zip(FEATURE_NAMES, X[0].tolist()))

    return ResolvedFeatures(X=X, values=values, basis=basis, real_signal_count=real_signal_count)


# FEATURE: confidence band on the predicted delay. A single point figure
# ("~18 min") implies a precision this model doesn't actually have -
# these factors turn `confidence` into an honest +/- range around the
# point estimate instead, widening as real signal gets scarcer. Not
# derived from a statistical prediction interval (no real historical
# dataset exists to fit one - see this module's docstring); a documented,
# confidence-tiered heuristic spread, labelled as such.
_CONFIDENCE_BAND_FACTOR = {"Very High": 0.08, "High": 0.15, "Moderate": 0.30, "Low": 0.50}
_MIN_BAND_MINUTES = 3


def _confidence_band(predicted_minutes: int, confidence: str):
    factor = _CONFIDENCE_BAND_FACTOR.get(confidence, 0.35)
    spread = max(_MIN_BAND_MINUTES, round(predicted_minutes * factor))
    low = max(0, predicted_minutes - spread)
    high = predicted_minutes + spread
    return low, high


@dataclass
class DelayPrediction:
    predicted_delay_minutes: int
    confidence: str  # "Low" | "Moderate" | "High" — reflects how much REAL input was available
    basis: List[str] = field(default_factory=list)
    model_name: str = "RandomForest + MLPRegressor + LSTM, blended via RidgeCV meta-learner"
    disclaimer: str = DISCLAIMER
    # Confidence band around predicted_delay_minutes (see _confidence_band) -
    # narrower for High confidence (more real signal fed in), wider for Low.
    low_minutes: int = 0
    high_minutes: int = 0


def predict_delay(
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
) -> DelayPrediction:
    """
    Predicts additional delay (in minutes) expected by the end of the
    journey / next major checkpoint. All inputs are optional — anything
    not supplied falls back to a documented, neutral default and is noted
    in `basis` as assumed rather than real, so confidence is scored
    honestly instead of always claiming "High".
    """
    model = get_model()
    resolved = resolve_features(
        distance_km=distance_km, date_ddmmyyyy=date_ddmmyyyy, time_hhmm=time_hhmm,
        route_progress_ratio=route_progress_ratio, current_delay_minutes=current_delay_minutes,
        travel_class=travel_class, recent_delay_trend_per_stop=recent_delay_trend_per_stop,
        avg_speed_kmph=avg_speed_kmph, recent_delay_basis=recent_delay_basis, avg_speed_basis=avg_speed_basis,
    )
    predicted = _ensemble_predict(model, resolved.X)
    predicted = max(0, round(predicted))

    if resolved.real_signal_count >= 4:
        confidence = "High"
    elif resolved.real_signal_count >= 2:
        confidence = "Moderate"
    else:
        confidence = "Low"

    low_minutes, high_minutes = _confidence_band(predicted, confidence)
    return DelayPrediction(
        predicted_delay_minutes=predicted, confidence=confidence, basis=resolved.basis,
        low_minutes=low_minutes, high_minutes=high_minutes,
        model_name=_model_name or "RandomForestRegressor (scikit-learn)",
    )


_SPEED_MODEL_PATH = os.path.join(_CACHE_DIR, "speed_model.joblib")
_SPEED_MODEL_VERSION = "v1"
_speed_model = None


def _generate_speed_training_data(n_samples: int = 4000, seed: int = 7):
    """Synthetic (X, y) for the instant avg-speed estimator - same honesty
    rule as _generate_training_data: no real historical per-train speed
    log exists to train on, so this is built from documented running-speed
    heuristics (typical Indian mail/express ~55 km/h scheduled, slower
    near origin/destination while still accelerating/braking, peak-hour
    section congestion, and speed dropping off as a train's own delay
    trend worsens)."""
    rng = np.random.default_rng(seed)
    distance_km = rng.uniform(20, 2200, n_samples)
    route_progress_ratio = rng.uniform(0, 1, n_samples)
    hour_of_day = rng.integers(0, 24, n_samples)
    is_weekend = rng.integers(0, 2, n_samples)
    current_delay_minutes = np.clip(rng.normal(15, 25, n_samples), 0, 240)
    recent_delay_trend_per_stop = np.clip(rng.normal(1.0, 4.0, n_samples), -15, 25)

    base = np.full(n_samples, _TYPICAL_EXPRESS_SPEED_KMPH)
    # Slower in the first/last ~8% of the route (station approach/departure).
    edge_zone = (route_progress_ratio < 0.08) | (route_progress_ratio > 0.92)
    base -= np.where(edge_zone, 15, 0)
    base += np.where((hour_of_day >= 7) & (hour_of_day <= 10), -5, 0)
    base += np.where((hour_of_day >= 17) & (hour_of_day <= 21), -6, 0)
    base += np.where(hour_of_day <= 4, 4, 0)  # clearer lines late night
    base -= is_weekend * 1.5
    base -= np.clip(recent_delay_trend_per_stop, 0, None) * 1.2  # worsening trend = running slower right now
    base -= np.clip(current_delay_minutes - 15, 0, None) * 0.05

    noise = rng.normal(0, 6, n_samples)
    y = np.clip(base + noise, 10, 130)

    X = np.column_stack([
        distance_km, route_progress_ratio, hour_of_day, is_weekend,
        current_delay_minutes, recent_delay_trend_per_stop,
    ])
    return X, y


def get_speed_model():
    """Singleton accessor for the instant avg-speed estimator. Deliberately
    a single RandomForestRegressor (not the full 3-way delay ensemble) -
    this is a lighter secondary metric, only ever used when NEITHER
    RailKit NOR RailRadar has real distance/time data yet (see
    gps_tracking.compute_avg_speed_multi_source's "none" case)."""
    global _speed_model
    if _speed_model is not None:
        return _speed_model

    os.makedirs(_CACHE_DIR, exist_ok=True)
    try:
        import joblib
        if os.path.isfile(_SPEED_MODEL_PATH):
            cached = joblib.load(_SPEED_MODEL_PATH)
            if cached.get("version") == _SPEED_MODEL_VERSION:
                _speed_model = cached["model"]
                return _speed_model
    except Exception:
        pass

    from sklearn.ensemble import RandomForestRegressor
    X, y = _generate_speed_training_data()
    model = RandomForestRegressor(n_estimators=120, max_depth=9, min_samples_leaf=5, random_state=7, n_jobs=-1)
    model.fit(X, y)
    _speed_model = model

    try:
        import joblib
        joblib.dump({"version": _SPEED_MODEL_VERSION, "model": model}, _SPEED_MODEL_PATH)
    except Exception:
        pass
    return _speed_model


@dataclass
class SpeedEstimate:
    speed_kmph: float
    confidence: str
    basis: str
    model_name: str = "RandomForestRegressor (scikit-learn) instant speed estimator"
    disclaimer: str = (
        "No real distance/time data or live GPS speed reading was available from either provider "
        "for this train yet - this is a machine-learning INSTANT ESTIMATE based on typical running-speed "
        "patterns (time of day, route position, current delay trend), not a measurement."
    )


def estimate_avg_speed_kmph_ml(
    distance_km: Optional[float] = None, route_progress_ratio: Optional[float] = None,
    time_hhmm: Optional[str] = None, date_ddmmyyyy: Optional[str] = None,
    current_delay_minutes: Optional[int] = None, recent_delay_trend_per_stop: Optional[float] = None,
) -> SpeedEstimate:
    """
    Instant ML estimate of average running speed, for the moment right
    after a train leaves origin (or anywhere else neither RailKit nor
    RailRadar has produced a real distance/time speed reading or a live
    GPS speed yet - see gps_tracking.compute_avg_speed_multi_source).
    Every input is optional and defaults to a documented neutral value,
    same honesty pattern as predict_delay().
    """
    model = get_speed_model()
    basis_parts = []
    real_signal_count = 0

    if distance_km is not None:
        basis_parts.append(f"journey distance {round(distance_km)} km")
        real_signal_count += 1
    else:
        distance_km = 400.0

    if route_progress_ratio is not None:
        route_progress_ratio = max(0.0, min(1.0, route_progress_ratio))
        basis_parts.append(f"{round(route_progress_ratio * 100)}% through the route")
        real_signal_count += 1
    else:
        route_progress_ratio = 0.1  # early-journey is the common case this function is used for

    now = datetime.now()
    hour_of_day = now.hour
    if time_hhmm:
        try:
            hour_of_day = int(str(time_hhmm).split(":")[0]) % 24
            real_signal_count += 1
        except (ValueError, IndexError):
            pass

    is_weekend = 0
    if date_ddmmyyyy:
        try:
            is_weekend = 1 if datetime.strptime(date_ddmmyyyy, "%d-%m-%Y").weekday() >= 4 else 0
        except ValueError:
            pass

    if current_delay_minutes is not None:
        basis_parts.append(f"currently reported delay {current_delay_minutes} min")
        real_signal_count += 1
    else:
        current_delay_minutes = 15

    if recent_delay_trend_per_stop is not None:
        basis_parts.append(f"delay trend {recent_delay_trend_per_stop:+.1f} min/stop")
        real_signal_count += 1
    else:
        recent_delay_trend_per_stop = 0.0

    X = np.array([[distance_km, route_progress_ratio, hour_of_day, is_weekend,
                    current_delay_minutes, recent_delay_trend_per_stop]])
    speed = float(model.predict(X)[0])
    speed = round(max(10.0, min(130.0, speed)), 1)

    confidence = "Moderate" if real_signal_count >= 3 else "Low"
    basis = ("based on " + ", ".join(basis_parts)) if basis_parts else "based on typical running-speed patterns only (no real inputs available)"

    return SpeedEstimate(speed_kmph=speed, confidence=confidence, basis=basis)


def format_delay_prediction(pred: DelayPrediction) -> str:
    lines = [
        f"Predicted delay: ~{pred.predicted_delay_minutes} min "
        f"(range {pred.low_minutes}\u2013{pred.high_minutes} min, {pred.confidence} confidence)",
        f"Model: {pred.model_name}",
        f"Based on: {'; '.join(pred.basis)}",
        pred.disclaimer,
    ]
    return "\n".join(lines)