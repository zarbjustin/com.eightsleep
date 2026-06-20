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

## Current state (2026-06-20, updated evening)
- Version **1.0.1**. App **validates at `publish`**. **27 unit tests pass** (`npm test`).
- **v1.0.1 = presence-detection bug fix** (commit `448de1c`): the `presence_started` /
  `presence_stopped` Flow triggers were firing spuriously / being missed. Three root causes in
  `lib/EightSleepClient.ts` were fixed:
  1. `getSideMetrics` read the last trend day even when it was an empty placeholder (API returns
     yesterday→tomorrow) → now `pickActiveDay()` selects the most recent day with real data.
  2. `computePresence` returned false whenever `presenceEnd` existed, ignoring a newer
     `presenceStart` (got back into bed) → now the most recent marker wins.
  3. 15-min heart-rate fallback extracted to `PRESENCE_HR_FALLBACK_MS`.
  New tests cover return-to-bed and trailing-empty-day cases.
- **PUBLISHED via CI as Build 2** (`com.eightsleep@1.0.1`, uploaded draft, NOT yet promoted):
  https://tools.developer.homey.app/apps/app/com.eightsleep/build/2
- **CI publishing now works**: repo secret `HOMEY_PAT` IS set. Release flow is two dispatches:
  `gh workflow run homey-app-version.yml -R zarbjustin/com.eightsleep -f version=patch -f changelog="..."`
  then `gh workflow run homey-app-publish.yml -R zarbjustin/com.eightsleep`.
- **Deployed to "Justin's Homey Pro" for testing**: v1.0.1 installed via `homey app install`
  (origin devkit_install, state running) — verified via Homey Web API. (Docker not needed; do NOT
  use `homey app run`.) This is the devkit install, separate from the App Store Test channel.

## Outstanding / next steps
1. **Promote Build 2 to Test, then Submit for certification** — dashboard-only UI action (no CLI /
   public API; the available athom OAuth token is Homey-Pro-scoped, not App-Store-scoped). Build 2
   page above → "Promote to Test" → "Submit for certification". Reviewer note (guideline 3.2)
   drafted in chat: explains log-in flow and that bed presence is the core live feature.
2. **Verify the presence fix in real use**: make a Flow with "The bed became empty" / "Someone got
   into the bed" and confirm reliable firing now that v1.0.1 is on the Homey Pro.
3. **Live verification (guideline 3.2):** only bed *presence* confirmed against a real account.
   Before/at review, exercise write actions (temperature, on/off, away, prime, alarms, base,
   scheduled temp) and confirm sleep/biometric fields populate; fix any that read blank.
4. **Duplicate app (2.1.1):** NOT a blocker — there is no Eight Sleep app in the Homey App Store
   (other Eight Sleep integrations are Home Assistant).

## Credits
Eight Sleep cloud API behaviour informed by the open-source
[`lukas-clarke/eight_sleep`](https://github.com/lukas-clarke/eight_sleep) Home Assistant
integration (no code copied). See `README.md`.
