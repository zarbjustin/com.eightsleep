# Handover Notes

## Current App Store Candidate

This candidate keeps the changes that were deployed successfully to the local Homey Pro:

- Custom capability icons for the Eight Sleep bed-side driver metrics.
- Bed Presence based on fresh raw heart-rate recency:
  - heart-rate sample under 10 minutes old means present;
  - heart-rate sample 10-30 minutes old plus a `smart:*` side state extends presence;
  - older samples are treated as stale.
- Stale live heart-rate and sleep-stage values are cleared instead of showing old session data.
- Away Mode reads the per-user `/away-mode` endpoint instead of device-level `awaySides`.

The local Homey Pro test confirmed Bed Presence eventually changed correctly once Eight Sleep published fresh biometric/session data.

## Future Sprint Recommendations

### Sprint 1: Data Semantics Cleanup

- Separate raw live heart-rate samples from Eight Sleep's processed resting-heart-rate metric.
- Add a future `Resting heart rate` capability from `sleepQualityScore.heartRate.current`.
- Add a future `Resting heart rate (7-day avg)` capability from `sleepQualityScore.heartRate.inclusive7DayAverage`.
- Keep raw `Heart rate` for presence/live state only, or clearly label it if retained on the main card.
- Keep HRV and breath rate aligned with Eight Sleep's processed nightly values.

### Sprint 2: Presence Diagnostics

- Keep the Home Assistant-style presence logic already implemented.
- Add structured diagnostic logging or a hidden diagnostic surface for:
  - selected trend day;
  - latest heart-rate timestamp;
  - heart-rate sample age;
  - side state type;
  - computed presence reason.
- Avoid using resting heart rate, sleep score, or processed nightly metrics for presence.

### Sprint 3: Insights Experience

- Use processed nightly metrics for long-term Insights charts:
  - resting heart rate;
  - resting heart rate 7-day average;
  - HRV;
  - breath rate;
  - sleep fitness score;
  - sleep quality score;
  - sleep routine score;
  - time slept.
- Consider disabling Insights for raw live heart rate if it remains sparse or freshness-gated.

### Sprint 4: Device Card UX

- Reorder capabilities around the user's mental model:
  - control and temperatures first;
  - Bed Presence near the top;
  - live biometrics only when fresh;
  - sleep summary metrics together;
  - maintenance and alarm state later.
- Keep icons aligned with the final metric semantics.

### Sprint 5: Documentation

- Document the difference between raw heart-rate samples and processed resting heart rate.
- Add troubleshooting notes for delayed Bed Presence:
  - Eight Sleep may take 20-30 minutes to publish fresh trend/session data;
  - scheduled temperature can be active before live biometrics are available.
- Credit the Home Assistant integration pattern where useful.

### Sprint 6: Release Hardening

- Validate migration behavior for existing paired devices.
- Run `npm test`, `npm run lint`, and `homey app validate --level verified`.
- Update changelog and app-store review notes before release.
