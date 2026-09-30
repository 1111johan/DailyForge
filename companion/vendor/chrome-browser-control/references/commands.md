# Command reference

Run these commands from the installed Skill directory (the directory containing `SKILL.md`). Every command writes one JSON object to stdout; errors use a non-zero exit code and include a stable `error_code` when available.

```text
python scripts/setup.py <setup-command>
python scripts/browser.py [global-options] <command> [command-options]
```

## Setup commands

```text
python scripts/setup.py prepare       # start/reuse 127.0.0.1:16881
python scripts/setup.py extension-path
python scripts/setup.py enroll        # open a short-lived pairing URL in Chrome
python scripts/setup.py rotate-token  # invalidate old pairing and require re-enroll
python scripts/setup.py allow-upload-root PATH
python scripts/setup.py doctor
```

`prepare` does not launch or close Chrome. Load the printed extension directory through `chrome://extensions` → Developer mode → Load unpacked before `enroll`. Pairing codes are single-use and expire quickly; never paste a long-lived token into a page or issue.
If Chrome is not detected, use `enroll --chrome-path /path/to/chrome` or set `CHROME_BROWSER_CONTROL_CHROME`.
`rotate-token` atomically replaces the local bridge token while the persistent
server is running; it never prints the replacement. Existing extension
pairings stop working immediately. Run `enroll` again after rotating. Prefer
this command over manually deleting `bridge-token`, because it keeps the
running server and its token file synchronized.

## Global options

The CLI accepts these options before the command:

```text
--port PORT                 # default 16881
--client-id ID              # identify the paired extension client
--page-id PAGE_ID           # pin commands to a stable page
--lease-owner ID            # stable automation owner identity
--lease-ttl SECONDS         # page lease lifetime
--takeover-lease            # explicitly take an occupied lease
```

Read-only discovery commands should be run before mutating commands. A lease takeover is a deliberate coordination action and should be used only when the previous owner is known to be gone.

`allow-upload-root` enables image uploads from one existing directory. Configure the narrowest directory that contains the intended assets; never configure a home directory, drive root, repository root, or system directory.

## Discovery and navigation

```text
browser.py doctor
browser.py capabilities
browser.py state
browser.py pages
browser.py windows
browser.py open https://example.com [--mode new_tab|current_tab|new_window]
browser.py switch PAGE_ID
browser.py close PAGE_ID --confirmation "user approved closing this tab"
browser.py switch-window WINDOW_ID
browser.py close-window WINDOW_ID --confirmation "user approved closing this window"
browser.py goto https://example.com
browser.py reload
browser.py back
browser.py forward
```

`open` and `goto` accept `http`/`https` URLs only. The CLI removes query strings and fragments from diagnostic URLs. A `page_id` is stable across ordinary DOM updates but can change when a tab is closed/recreated; always re-read `pages` after that event.

## Inspecting a page

```text
browser.py snapshot [--scope viewport|full] [--within CSS] [--limit N]
browser.py find --text TEXT [--exact] [--role ROLE] [--tag TAG] [--attr NAME=VALUE]
browser.py find --css CSS
browser.py inspect-point --x X --y Y
browser.py extract --css CSS [--fields visibleText,href,title,ariaLabel,role,tag,name]
browser.py wait --css CSS [--state attached|detached|visible|hidden] [--timeout SECONDS]
browser.py screenshot [--out PATH]
```

Screenshots are PNG files and never overwrite an existing path. Omit `--out`
to create a unique file under the private runtime evidence directory.

Use a `snapshot` result as the observation boundary. Its `snapshot_id` and element `ref` are valid only for that page state. If an action reports `stale_ref` or the page navigated, obtain a fresh snapshot rather than guessing a replacement selector.

## Interacting with visible elements

```text
browser.py click --ref REF --snapshot-id SNAPSHOT_ID
browser.py click-text --text TEXT [--css CSS] [--contains]
browser.py click --css CSS
browser.py fill --css CSS --text TEXT
browser.py type --css CSS --text TEXT [--delay-ms N]
browser.py clear --css CSS
browser.py focus --css CSS
browser.py check --css CSS [--unchecked]
browser.py select --css CSS [--value VALUE|--label LABEL|--index N]
browser.py hover --css CSS
browser.py double-click --css CSS
browser.py context-menu --css CSS
browser.py drag --source CSS --target CSS
browser.py press KEY [--css CSS] [--ctrl] [--alt] [--shift] [--meta]
browser.py scroll [--css CSS] [--x N] [--y N] [--behavior auto|smooth] [--block center]
browser.py highlight --ref REF --snapshot-id SNAPSHOT_ID [--duration MS]
browser.py upload --css 'input[type="file"]' --file IMAGE [--file IMAGE ...] [--timeout SECONDS]
```

`fill` and `type` return an acknowledgement and safe metadata (for example, accepted/length), never the entered text. Password/OTP inputs are blocked; ask the user to enter secrets manually. Do not use a field's value as a verification channel. Verify by checking visible page state, a success message, navigation, or a fresh snapshot.

`upload` accepts one or more PNG, JPEG, or WebP files under configured roots. It targets an explicit `<input type="file">` selector, returns only the number of selected files, and never prints their paths. Chrome may display a short-lived debugging notice while the files are assigned. Verify the website's visible thumbnail/file count before continuing. Upload does not authorize publishing or submitting content.

`inspect-point` is a read-only troubleshooting command. It returns a safe element summary and selector for the element under viewport coordinates, without clicking it or exposing input values. Use coordinates in browser CSS pixels; the returned viewport size helps account for browser zoom or display scaling.

## Result and failure handling

Success responses normally contain `ok: true`, `command`, and command-specific data. Failure responses contain `ok: false`, `error_code`, `error`, and may include safe `details`.

For mutating commands:

- `unknown_outcome` means the request may have reached Chrome even though the client did not receive a final response. Inspect `state`/`pages`/`snapshot`, then ask the user before retrying.
- `stale_ref` or `page_refreshed` means the page state changed. Re-observe and retry only if the requested action is still intended.
- `lease_conflict` means another client owns the page. Do not force takeover without explicit coordination.

The CLI deliberately has no `value`, arbitrary `js`, download-monitoring, or dialog commands. Upload is the only scoped local-file operation and is restricted by the configured root policy.
