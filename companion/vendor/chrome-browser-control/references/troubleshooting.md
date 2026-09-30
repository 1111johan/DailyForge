# Troubleshooting

## `bridge_unavailable`, connection refused, or `doctor` is blocked

Run `python scripts/setup.py prepare` and check that a process is listening on `127.0.0.1:16881`. A different local service may already own the port; choose the configured alternate port consistently for `prepare`, `enroll`, `doctor`, and `browser.py`. Do not expose the bridge on a public or LAN address as a workaround.

If `doctor` reports an incompatible bridge version/runtime contract, an older
detached bridge still owns the port. Stop that older local Python process (or
restart the OS login session), then run `prepare` again. The Skill deliberately
refuses to reuse a server whose security contract does not match its bundled
client.

## No pages or no responsive client

Confirm that the unpacked extension is loaded and enabled in `chrome://extensions`. After editing extension files, click Reload. Open a normal `http`/`https` page (Chrome internal pages such as `chrome://extensions`, the Chrome Web Store, and some PDF viewers restrict content scripts). Run `enroll` again if the extension service worker lost its pairing state.

## Pairing code invalid or expired

Pairing codes are single-use and short-lived. Generate a new code with `enroll` and complete the bootstrap page promptly. Do not reuse a code from terminal history or an old browser tab. If the token is suspected to be exposed, run `python scripts/setup.py rotate-token` and then `enroll` again; do not remove `bridge-token` while the persistent bridge is running.

## `stale_ref`, `page_refreshed`, or the wrong tab was targeted

Run `pages`, select the intended stable `page_id`, and take a fresh `snapshot`. A ref belongs to one page and one snapshot state; navigation, refresh, and many SPA updates invalidate it. Use `click --ref ... --snapshot-id ...` only with values from the latest observation.

## `lease_conflict`

Another automation client currently owns the page lease. Coordinate with that client or wait for it to finish. Use `--takeover-lease` only when the previous owner is definitely stopped and the user has authorized takeover; a forced takeover can race with an in-flight write.

## `unknown_outcome`

The bridge could not confirm whether a mutating request reached Chrome. Treat the action as possibly applied. Inspect visible state, `pages`, or a fresh snapshot, and ask the user before retrying a click/submit/navigation that could have side effects.

## Output appears redacted

This is expected for password-like fields, input values, query strings, local paths, HTML, cookies, and tokens. Use a visible success indicator, title, URL path, count, or screenshot as verification. The V0.2 bridge does not provide a read-back value command.

## Chrome extension warnings

The extension is intentionally loaded unpacked for V0.2. Review the manifest permissions and source before loading. Do not install a copy sent by an unknown party. On a shared or high-risk machine, use a disposable Chrome profile with test accounts and synthetic data.
