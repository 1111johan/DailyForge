# Chrome Browser Control Bridge

This is the unpacked Chrome extension used by the `chrome-browser-control`
skill. It lets the local skill server operate ordinary `http` and `https`
pages in the user's existing Chrome profile.

## Install

1. Open Chrome at `chrome://extensions`, enable **Developer mode**, choose
   **Load unpacked**, and select this directory.
2. Start the local skill setup command and run `enroll` to create a short-lived
   pairing code and open its bootstrap URL.
3. If Chrome did not inject the extension into the bootstrap tab, refresh it.
   The code is single-use and expires
   quickly; after it is claimed, it is removed from the page URL.

The long-lived bridge token is stored only in the extension service worker's
extension storage. Content scripts never receive it, and page content never
makes direct requests to the local server.

## Scope and privacy

The extension has a `debugger` permission for one fixed operation:
`DOM.setFileInputFiles` on an explicitly selected file input. The local bridge
validates every image against configured roots before the command reaches
Chrome, and the extension detaches immediately after setting the files. It
does not expose generic debugger commands, arbitrary JavaScript, cookies,
passwords, returned file paths, downloads, or JavaScript-dialog control.
Snapshots and results omit input values, HTML, URL query strings, and URL
fragments.

Chrome requires the literal `<all_urls>` host permission for unattended
`captureVisibleTab`. This extension uses it only for visible-viewport
screenshots; content scripts still match only `http`/`https`, and runtime
checks reject screenshots and DOM commands for other schemes. Leave Chrome's
separate **Allow access to file URLs** toggle off.

Chrome internal pages (`chrome://`, extensions pages, and the Chrome Web Store)
cannot receive DOM commands. Browser-level commands such as opening a URL and
listing tabs still work while a Chrome internal page is active; open or switch
to an ordinary `http`/`https` tab before using DOM actions. Reload the extension
and refresh a target page after updating these files.
