# Eight Sleep for Homey

An independent community integration that brings each side of an Eight Sleep Pod
into Homey as its own device — temperature control, presence, live biometrics,
sleep scores, alarms, away mode, adjustable base and a bedside widget.

This project is **not affiliated with, authorised by, or endorsed by Eight Sleep**.
"Eight Sleep" and the Pod are trademarks of their respective owner. The app talks
to Eight Sleep's cloud service and requires an Eight Sleep account.

## Credits

The behaviour of the Eight Sleep cloud API (authentication flow, endpoints and
payload shapes) was informed by the open-source
[`lukas-clarke/eight_sleep`](https://github.com/lukas-clarke/eight_sleep) Home
Assistant integration. No source code was copied; the implementation here was
written independently in TypeScript. Thanks to that project and the wider
community for documenting the unofficial API.

## Data notes

- Bed Presence is based primarily on recent raw heart-rate samples. A sample less
  than 10 minutes old means the side is occupied; a 10-30 minute old sample can
  still count as occupied while the side is in a smart temperature state.
- `Heart rate (live)` is a freshness-gated raw sample used for current state and
  presence. It is not stored in Insights because sparse live samples can make a
  misleading long-term chart.
- `Resting heart rate`, HRV and breath rate come from Eight Sleep's processed
  sleep-quality data and are intended for Insights.
- Bed Presence can lag after someone gets into bed if Eight Sleep has not yet
  published fresh trend/session data. The app will update on the next successful
  poll once that data appears.

## Development

- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`
- Validate: `homey app validate --level verified`
