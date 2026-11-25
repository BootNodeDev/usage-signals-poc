# Check 08: passive capture of the Wallets Kit modal

> "The passive Wallets Kit capture works in a browser with a real wallet."

**Verdict: yes, with one stated condition.** A script loaded next to the tracker, with no access
to the tenant's kit instance, records modal opened, wallet option clicked and modal closed on a
page that uses Stellar Wallets Kit 2.8.0 with the kit's own modal. With the real Varial
(formerly Freighter) extension loaded in Chromium, the three events arrive in order when the
wallet is chosen and its request is declined. The condition: approval by a real account was not
run. That path was run only against a stand-in that answers the page as the extension does. The
manual steps below cover it in about two minutes.

Run on 2026-11-24 and 2026-11-25 in Chromium 156.0.8078.4 (the build Playwright 1.64.1 installs), headless, on
macOS. No other browser was run.

## Reproduce

```sh
npm ci --ignore-scripts
npx playwright install chromium   # only if this Chromium build is not on the machine yet
node run.mjs
```

About 30 seconds. It bundles the tenant pages with esbuild, serves them on a free localhost
port, runs thirteen cases, prints the request bodies the local collector received for each and
the verdict,
and exits non-zero if any case differs from the table below. The first line printed is a
temporary directory that holds the bundles, the downloaded extension and the browser profile,
about 85 MB per run. Nothing is written to the repository.

The last case downloads the wallet extension (11 MB) from its repository's release page and
checks its SHA-256. In that case the extension contacts its own services. In the other twelve
the browser can reach only the local server.

## What is in the folder

- `tenant/`: the tenant's page. It initialises the kit with its default modules, renders the
  kit's button and has one button of its own that calls `StellarWalletsKit.authModal()`. It
  shows the connected address and the last error on the page. It holds no analytics code.
- `capture.js`: the capture prototype, 212 lines of plain JavaScript, loaded as a separate
  classic script. It holds the observer and a `beforeSend` hook for the tracker.
- The tracker is the product's own file, `console/public/s/3.5.0-ac07551a/t.js`, served from
  its place in the repository and not edited. Its tag names the hook with `data-before-send`.
  It posts to a collector on another origin (`127.0.0.1` against `localhost`), as the gateway
  is for a tenant.
- `serve.mjs`: builds and serves the pages. `run.mjs`: the cases.

## How the capture works

Kit 2.x renders its modal with Preact into a plain `div` that it appends to `document.body`,
and removes that `div` when the modal closes. There is no custom element and no shadow root,
and the kit dispatches no DOM events. Its `on()` events are reachable only from the tenant's
own import of the kit.

The capture watches the direct children of `document.body` with one `MutationObserver`:

- A child is taken as the auth modal only if it is an attribute-less `div` whose single child
  is `section.stellar-wallets-kit`, with an empty backdrop `div` and a panel `section` that
  holds one `header` with one `h1` and a button, and exactly one `ul`. That is `modal_opened`.
- A click inside it on an `li` that is a direct child of that `ul` and holds one `p` is
  `wallet_option_clicked`. The structure is checked again at every click.
- Removal of that child from the body is `modal_closed`.

Anything that does not match records nothing. The kit's profile modal has no `ul`, so it is not
recorded.

Two decisions:

- **Stacked modals count once.** Each `authModal()` call appends another modal on top of the
  last, and all of them close together. The visitor sees one, so the capture sends
  `modal_opened` for the first and `modal_closed` when the last is removed (case D1). Before
  this change the same actions gave opened twice and closed twice.
- **A modal already open at load is counted.** When `capture.js` starts it looks at the body's
  children once, so a modal opened before the script loaded gives `modal_opened` at load time
  (case S1). Clicks made before the script loaded are lost.

## What the events contain

The capture calls `umami.track('wallet_funnel', { step })`, with `wallet` added for a click.
The tracker then adds the page title, the full URL and the referrer to every event. Sent like
that, an address in the path, the query, the fragment or the title leaves the page: the first
run through the real tracker failed eight cases on it.

The hook `usWalletFunnelBeforeSend` in `capture.js` therefore rebuilds every `wallet_funnel`
event before it is sent. This is a request body as the collector received it:

```json
{"type":"event","payload":{"website":"00000000-0000-4000-8000-000000000008","hostname":"localhost","screen":"1280x720","language":"en-US","url":"/kit/account/[strkey]/","name":"wallet_funnel","data":{"step":"wallet_option_clicked","wallet":"varial"}}}
```

- `data` is rebuilt from fixed values: `step` is one of three constants, and `wallet` is one
  of 20 names (the 19 wallets kit 2.8.0 ships, plus `freighter`) or `other`. A `wallet_funnel`
  event with any other data is not sent.
- `url` is the path only. Query and fragment are dropped. Strkeys, 64-character hashes, emails
  and federation addresses in the path are replaced by placeholders.
- Title, referrer, tag, distinct id and salt are left out.

What is true after this change: with the hook attached, a `wallet_funnel` request body holds
no value read from the modal, the wallet's answer, the title, the query or the fragment. The
path is the one page-derived value, and it is as clean as the path rules. Without the hook the
tracker sends title and full URL (case L1). The capture never reads the kit's state,
`localStorage` or the wallet's answer.

## Cases

"Stand-in" is a script the test injects that answers the kit's Varial module over the same
window messages as the extension. Every page is opened at
`/<page>/account/<address>/?account=<address>&tx=<hash>#<address>` with a title that holds
another address. The test reads what left the page: it checks the fields, the data and the
path of every request body, searches bodies and request headers for strkey-shaped and 64-hex
strings, for parts of the addresses, the title, the query and the error texts, and fails on
any page exception.

| Case | Page and wallet | Actions | Events received | Pass |
|---|---|---|---|---|
| A1 | kit 2.8.0, stand-in grants | kit button, Varial, address returned; then profile modal opened and closed (it shows `GCHECK....AAAAAA`) | opened, clicked `varial`, closed | yes |
| A2 | kit 2.8.0, stand-in refuses | tenant button, Varial, wallet answers with an error, the page shows it | opened, clicked `varial`, closed | yes |
| A3 | kit 2.8.0 | modal opened, closed with its close button | opened, closed | yes |
| A4 | kit 2.8.0, no wallet | LOBSTR clicked while not installed (the kit opens its site), backdrop clicked | opened, clicked `lobstr`, closed | yes |
| A5 | kit 2.8.0 plus a tenant module named like a Stellar address, failing with a 64-hex string in its error | tenant button, that module | opened, clicked `other`, closed | yes |
| D1 | kit 2.8.0, stand-in grants | `authModal()` called twice, two modals in the page, Varial chosen | opened, clicked `varial`, closed | yes |
| S1 | kit 2.8.0, stand-in grants | modal opened first, `capture.js` added afterwards, Varial chosen | opened, clicked `varial`, closed | yes |
| L1 | kit 2.8.0, hook left off the tracker tag | Varial chosen, address returned | three events with title and full URL; the search finds both addresses, the hash and the query, which is what this control must show | yes |
| N1 | kit with its root class renamed | wallet connects | none, no exception | yes |
| N2 | kit with its `ul`/`li` list replaced by `div`s | wallet connects | none, no exception | yes |
| N3 | kit modal inside a closed shadow root | wallet connects | none, no exception | yes |
| N4 | no kit; a hand-made chooser with the same `ul`/`li`/`h1` layout | option chosen | none, no exception | yes |
| R1 | kit 2.8.0, Varial Wallet 5.53.0 extension | tenant button; the kit lists Varial as installed; Varial clicked; the extension opens its `#/grant-access` window; the window is closed; the page shows "-4: The user rejected this request." | opened, clicked `varial`, closed | yes |

N1 to N3 edit the kit's source at bundle time (`KIT_CHANGES` in `serve.mjs`). In each the
wallet still connects, so the silence is the capture's and not a broken page.

Before the hook existed, the same thirteen cases run through the real tracker gave 5 of 13:
A1 to A5, D1 and R1 failed on title and URL, and S1 on the missing open. With the earlier
tracker stub, the check was also run twice with `capture.js` broken on purpose (class test
removed, label passed through for unknown wallets); A5, N1 and N4 failed both times.

R1 passed in eight of nine full runs, counting the two after this change. In one it did not run to its end. That run printed
through a filter that dropped the error message, and a repeat under the same conditions
passed. The cause is not established.

## Limits

- **Structure.** The capture depends on markup the kit does not document. `stellar-wallets-kit`
  is the only fixed class name; the others are generated by Twind. Any change to the nesting
  above stops the capture, silently. Only 2.8.0 was tested, not 2.0.0 to 2.7.1.
- **Shadow DOM.** If a kit release puts the modal in a closed shadow root, nothing outside the
  kit can see the list or which option was clicked (N3). The prototype does not look into open
  shadow roots either. Kit 1.x used Lit custom elements (`stellar-wallets-modal`); it was not
  tested.
- **Container option.** `authModal({ container })` renders the kit inline in an element the
  tenant chooses. The capture watches only `document.body` and records nothing there.
- **The hook.** Umami's tracker takes one `beforeSend` function. In the product the wrapper
  owns it and has to call this one for `wallet_funnel` events. Page views sent by the same
  tracker are not touched here and carried the title and the full URL in this check; scrubbing
  them is the wrapper's work, which does not exist in the repository yet.
- **Path rules.** The four patterns in `capture.js` are a first cut, not the design's reference
  vectors. A strkey that is truncated, split or encoded in the path is not replaced. The
  hostname is sent as it is.
- **Referer header.** The browser sent only the page's origin to the collector on another
  origin. A collector on the page's own origin, or a tenant page with a looser referrer
  policy, would receive the full URL in that header.
- **Stacked modals.** Several `authModal()` calls before the visitor acts count as one open
  and one close.
- **Late load.** A modal already open when `capture.js` loads is counted as opened at load
  time. A click on an option before that moment is not recorded.
- **Order.** Events are sent one request at a time. An event still waiting when the page
  unloads is lost.
- **Meaning of the steps.** `modal_closed` fires on every close: connected, declined, wallet
  error or dismissed. From outside these look the same. `wallet_option_clicked` also fires for
  a wallet that is not installed, where the kit opens the wallet's site and stays open.
- **Wallet names.** The name comes from the label the kit shows. A tenant module that reuses a
  listed name is recorded under that name.
- **Real wallet.** The extension was loaded unpacked from the release archive into a new
  profile with no account, not installed from a browser store. Creating an account means
  accepting the wallet's terms of use and holding a seed phrase, so it was not done.
- **Browser.** Chromium only, headless. Firefox and Safari were not run.
- **Wrapper.** The tracker file is the real one; the wrapper around it is not. The planned
  wrapper sends nothing when the browser reports automation, so an end-to-end test of it under
  Playwright needs that rule switched off.

## Corrections for the document

- "Stellar Wallets Kit v2" is still the current major: 2.8.0, published 2026-10-28. No newer
  major exists on npm or JSR.
- Freighter was renamed Varial on 2026-10-29. Kit 2.8.0 lists it as "Varial"; earlier 2.x
  releases list "Freighter". The fixed list needs both names.
- Wallet funnel events go through the same tracker as page views, so "never carry an address"
  holds only if their title, referrer, query and fragment are removed and their path is
  scrubbed in `beforeSend`. The document does not say this.
- The onboarding tier could say that the wallet funnel needs the kit's modal in its default
  place (appended to the body), and that "modal closed" does not say whether a wallet was
  connected.

## Manual run with a real account

For a person with Varial (or Freighter) installed in their own Chromium-based browser:

1. `npm ci --ignore-scripts && node serve.mjs`. It prints `open http://localhost:8808/kit/`.
   `PORT=9000 node serve.mjs` uses another port.
2. Open that address. Click "Connect with my own button", click "Varial" in the kit's modal,
   and approve the connection in the wallet. Nothing is signed.
3. The page shows the account's address after "Account:". The terminal shows three lines that
   end as below (`website`, `hostname`, `screen` and `language` come first), and no line holds
   the address:

```
event {... "url":"/kit/","name":"wallet_funnel","data":{"step":"modal_opened"}}}
event {... "url":"/kit/","name":"wallet_funnel","data":{"step":"wallet_option_clicked","wallet":"varial"}}}
event {... "url":"/kit/","name":"wallet_funnel","data":{"step":"modal_closed"}}}
```

## Packages

Pinned in `package.json`, resolved with `npm install --ignore-scripts --before=2026-11-22`,
so no package in the lockfile is newer than that date. No install script is needed.
`node_modules` is 533 MB, almost all of it the kit's wallet dependencies.

| Package | Version | Published |
|---|---|---|
| `@creit.tech/stellar-wallets-kit` | 2.8.0 | 2026-10-28 |
| `esbuild` | 0.28.2 | 2026-08-08 |
| `playwright` | 1.64.1 | 2026-10-14 |

Versions and dates were read from the npm registry (`npm view <package> time`) and, for the
kit, from https://www.npmjs.com/package/@creit.tech/stellar-wallets-kit. Playwright 1.64.1 was
chosen over 1.65.1 because its Chromium build was already on the machine. The kit's guide
installs it from JSR as `@creit-tech/stellar-wallets-kit`; JSR also lists 2.8.0 as latest.

Wallet extension: `build-5.53.0.zip`, published 2026-11-16 at
https://github.com/stellar/freighter/releases/tag/5.53.0, SHA-256
`44e8aab2e68ca4b2c4f4af56a81e1e37632b06e2ee115962dc61f931e71bb71a`, the digest GitHub reports
for the asset. Its manifest names it "Varial Wallet".

## Sources

All read on 2026-11-24.

- Kit repository and README: https://github.com/Creit-Tech/Stellar-Wallets-Kit
- Kit releases (2.8.0, "Migrate FreighterModule to VarialModule"):
  https://github.com/Creit-Tech/Stellar-Wallets-Kit/releases
- Kit guide: https://stellarwalletskit.dev/how-to/authenticate.html,
  https://stellarwalletskit.dev/how-to/kit-events.html,
  https://stellarwalletskit.dev/wallets/supported-wallets.html,
  https://stellarwalletskit.dev/installation.html
- Kit source as published, read from the npm package: `esm/sdk/kit.js` (`authModal`),
  `esm/components/app.js`, `esm/components/pages/auth-options.page.js`,
  `esm/sdk/modules/varial.module.js`
- JSR versions: https://jsr.io/@creit-tech/stellar-wallets-kit/meta.json
- Rename: https://stellar.org/blog/foundation-news/freighter-is-now-varial,
  https://varialwallet.com/changelog, https://docs.varialwallet.com/
- Extension releases: https://github.com/stellar/freighter/releases
