# TV and mobile readiness

## Available now

- `/tv` provides a ten-minute, one-use short code for signing in on a shared TV without typing account credentials.
- `/pair` claims that code from an already authenticated phone or desktop browser.
- `?tv=1` enables spatial D-pad navigation, visible focus rings, remote-sized controls and persistent TV mode.
- The web manifest, standalone display mode, safe-area insets and touch target sizing provide an installable mobile web experience.
- Chromecast Web Sender is implemented behind `NEXT_PUBLIC_CAST_APP_ID`. It is intentionally hidden until a registered Cast receiver ID and HTTPS origin are configured.

## Native delivery sequence

1. Ship and validate the responsive TV web client on Android TV and Fire TV browsers.
2. Package the same authenticated flows in a native Android TV/Fire TV shell, with Media3 playback and Leanback/Compose for TV focus semantics.
3. Build the Android mobile client against the same API and device-pairing contract.
4. Register the Cast receiver and set `NEXT_PUBLIC_CAST_APP_ID` in the web production environment.
5. After remote, playback and pairing telemetry are stable, reuse the API contracts for iOS and tvOS.

Native store applications require signing identities, package identifiers, store accounts and physical-device validation; those release credentials are intentionally not committed to this repository.
