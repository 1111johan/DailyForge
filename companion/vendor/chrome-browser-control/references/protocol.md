# Bridge protocol (V0.2)

The extension and local Python client communicate with protocol version `4`. Users and Skills should call `scripts/browser.py`; this document is for contributors maintaining the two ends of the bridge.

## Transport

- Server: `http://127.0.0.1:16881` by default.
- Setup: `POST /api/pairing/start` returns a short-lived pairing code. The bootstrap page passes that code to the extension; the extension claims it once with `POST /api/pairing/claim`.
- Runtime: the service worker keeps the bridge token and proxies poll/result/lease requests. Page content scripts never receive the long-lived token.
- Handshake: the server reports an exact runtime-contract marker in addition to protocol and package versions. The bundled client refuses to reuse a detached server from an incompatible build.
- Requests and responses are JSON. Command metadata is posted in the body, not placed in a URL query string.
- `request_id` is used for mutating request de-duplication. The client must preserve it when recovering a transport error.

## Safe action surface

The V0.2 protocol covers:

```text
get_state          list_pages          list_windows
open_url           switch_page         close_page
switch_window      close_window        navigate
scan_elements      find_elements       extract_elements
snapshot           click               click_ref
inspect_point
highlight          highlight_ref       input
type_text          clear               focus
check              drag_and_drop       hover
wait_selector      scroll               press_key
select             dblclick             contextmenu
screenshot
upload_file
```

The exact parameter names are defined in `assets/chrome-extension/bridge_protocol.json`. A protocol action may have a corresponding Python controller method, but callers should not assume that every backend implementation supports every optional locator field.

## Deliberate exclusions

The default protocol must not expose:

```text
arbitrary JavaScript / executeScript
get_value or input value reads
cookies, localStorage, access tokens, passwords
download monitoring or general local file browsing
native dialog handling
arbitrary debugger/CDP commands
```

The sole upload action accepts validated paths below configured roots and maps to `DOM.setFileInputFiles`; no general debugger command is accepted from clients. These exclusions are security properties, not missing documentation. Adding another high-risk capability requires a separate threat-model review, permission review, tests with synthetic data, and a versioned protocol change.

## Page and snapshot identity

`page_id` identifies a Chrome tab through the bridge's stable tab identity. `snapshot_id` identifies the observed DOM state. A `ref` is scoped to its `snapshot_id` and page. Before a mutating action, the client should include the page lease metadata and, for ref-based actions, both `ref` and `snapshot_id`. The extension rejects stale or fenced writes instead of silently targeting a different tab.

## Safe metadata

Responses may include public URL origin/path, title, visible text, role, tag, safe element state, and upload file count. Query strings and fragments are removed from diagnostic URLs. Input values, password content, raw HTML, cookies, tokens, local paths, and arbitrary page-origin data are omitted or redacted before crossing the bridge.
