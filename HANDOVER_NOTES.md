# Handover Notes

## Current App Store Candidate

Version 1.0.5 was deployed successfully to the local Homey Pro and uploaded as
the App Store candidate:

- Custom capability icons for the Eight Sleep bed-side driver metrics.
- Bed Presence based on fresh raw heart-rate recency:
  - heart-rate sample under 10 minutes old means present;
  - heart-rate sample 10-30 minutes old plus a `smart:*` side state extends presence;
  - older samples are treated as stale.
- Stale live heart-rate and sleep-stage values are cleared instead of showing old session data.
- Away Mode reads the per-user `/away-mode` endpoint instead of device-level `awaySides`.

The local Homey Pro test confirmed Bed Presence eventually changed correctly once Eight Sleep published fresh biometric/session data.

## Sprint Work Implemented In 1.0.6

- Separated raw live heart-rate samples from Eight Sleep's processed resting-heart-rate metric.
- Added `Resting heart rate` and `Resting heart rate (7-day avg)` capabilities.
- Added weekly HRV, breath-rate, sleep-quality, sleep-routine and time-slept capabilities.
- Disabled Insights for raw `Heart rate (live)` so long-term charts use processed sleep metrics.
- Added quiet presence diagnostics to device logs, including presence reason and latest heart-rate sample age.
- Refreshed the bedside widget to show presence, live HR, resting HR, room/bed temperature, sleep score, HRV, breath rate and maintenance state.

## Future Sprint Recommendations

### Sprint 1: Real-World Calibration

- Observe several nights of presence diagnostics from both bed sides.
- Tune the 10-minute fresh window and 30-minute smart-state fallback only if logs show false positives or false negatives.
- Compare Homey `Resting heart rate` with the Eight Sleep app's daily resting-heart-rate value after a completed night.

### Sprint 2: Insights Polish

- Decide whether the 7-day average capabilities should remain visible on the device card or be kept mainly for Insights and Flow.
- Add screenshots or notes showing which Homey Insights lines correspond to Eight Sleep's app charts.
- Confirm that existing paired devices receive all new capabilities cleanly via migration.

### Sprint 3: Diagnostics Surface

- Consider a repair/settings diagnostic view if log inspection is not convenient enough.
- Include selected trend day, latest heart-rate timestamp, side state type and computed presence reason.

### Sprint 4: Flow Enhancements

- Add optional Flow trigger cards for meaningful nightly metric changes, such as resting heart rate above a threshold or poor sleep score.
- Keep thresholds user-configurable in Flow rather than adding app-wide settings.

### Sprint 5: Release Hardening

- Validate migration behavior for existing paired devices.
- Run `npm test`, `npm run lint`, and `homey app validate --level verified`.
- Deploy 1.0.6 locally for several nights before deciding whether to submit to the App Store.
