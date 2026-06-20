# Project Status & Handoff — Eight Sleep for Homey

_Last updated: 2026-06-20. This file is dev documentation only (excluded from the Homey app bundle via `.homeyignore`)._

## What this is
An unofficial community Homey Pro app for the Eight Sleep Pod. Each bed side is a
separate Homey device. Built in TypeScript on Homey SDK v3.

- **GitHub:** https://github.com/zarbjustin/com.eightsleep (private, branch `master`)
- **App id:** `com.eightsleep` · **Author:** Justin Zarb
- **Not affiliated with / endorsed by Eight Sleep.** Cloud API; account + internet required.

## How to work on it (any machine)
```
git clone https://github.com/zarbjustin/com.eightsleep
cd com.eightsleep
npm install
npm run build      # tsc
npm test           # node --test against .homeybuild  (25 tests)
npm run lint       # eslint (athom config); use eslint --fix for CRLF->LF
homey app validate --level verified   # App Store level
homey app install  # install to the selected Homey Pro (no Docker needed)
# homey app run requires Docker Desktop running (live logs); install does not.
```
Newly created files are CRLF on Windows; run `npx eslint --ext .js,.ts --ignore-path .gitignore . --fix` before committing.

## Architecture
- `lib/EightSleepClient.ts` — OAuth password-grant cloud client (auth-api.8slp.net token,
  client-api.8slp.net + app-api.8slp.net). Shared per-account via `ClientManager` in `app.ts`.
  Token cache + refresh (120s buffer), 401 re-auth, 429 backoff, request timeout, RateLimiter.
  Methods: getMe, getDevice, discoverBedSides, getSideState, setSidePower, setSideLevel,
  getTrends, getSideMetrics, getNextAlarm/snooze/dismiss/setOneOffAlarm, setAwayMode,
  primePod, setBedSide, getDeviceStatus, getBase/setBaseAngle/setBasePreset, getWeeklyAverages.
- `lib/temperature.ts` — raw level (-100..100) <-> C/F maps. `lib/RateLimiter.ts`, `lib/types.ts`.
- `drivers/bed-side/` — device.ts (tiered polling, capabilities, flow triggers, widget state),
  driver.ts (login_credentials pairing + repair, flow registration), driver.compose.json,
  driver.flow.compose.json. Credentials stored in encrypted app settings (migrated from store).
- `.homeycompose/capabilities/*.json` — custom capabilities. `widgets/bedside/` — dashboard widget.

## Build / sprint history (all on `master`)
Sprints 1–12: foundation/auth, bed-side driver+pairing, temperature, biometrics, sleep metrics,
alarms, Flow cards, away/maintenance, adjustable base, widget, localization/polish, robustness.
Sprints 13–17 (post multi-model review): presence-bug fix + request-timeout + shared client +
error UX (13), high-value Flow triggers/base actions (14), tiered/efficient polling (15),
Insights & weekly history (16), reach & polish — Fahrenheit, scheduled temp, energy estimate,
multi-Pod naming, credential hardening (17). Then: Eight Sleep branding (icon + photography),
and App Store compliance fixes (description/README/flow titles/widget previews/translation/credit).
See `git log` for the full commit-by-commit story.

## Current state (2026-06-20)
- App **validates at `verified`** (App Store level). **25 unit tests pass.**
- **PUBLISHED to the developer account as Build 1** (Test stage, not public):
  https://tools.developer.homey.app/apps/app/com.eightsleep/build/1
- Installed and running on "Justin's Homey Pro".

## Outstanding / next steps
1. **Submit for review** in Homey Developer Tools (Build 1 page above) → Athom certification
   (~2 weeks) → Release. Reviewer notes drafted (see chat / paste into the submission).
2. **Live verification (guideline 3.2):** only bed *presence* has been confirmed against a real
   account. Before/at review, exercise write actions (temperature, on/off, away, prime, alarms,
   base, scheduled temp) and confirm sleep/biometric fields populate. Field paths are grounded in
   the lukas-clarke/eight_sleep HA integration but written fresh — fix any that read blank.
3. **CI publishing (optional):** add repo secret `HOMEY_PAT` (a Homey Personal Access Token from
   https://tools.developer.homey.app/me) then dispatch the "Publish Homey App" workflow
   (`gh workflow run "Publish Homey App" -R zarbjustin/com.eightsleep`). Not yet set.
4. **Duplicate app (2.1.1):** NOT a blocker — there is no Eight Sleep app in the Homey App Store
   (other Eight Sleep integrations are Home Assistant).

## Credits
Eight Sleep cloud API behaviour informed by the open-source
[`lukas-clarke/eight_sleep`](https://github.com/lukas-clarke/eight_sleep) Home Assistant
integration (no code copied). See `README.md`.
