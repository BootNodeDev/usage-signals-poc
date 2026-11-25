// Prototype of the passive wallet funnel capture for Stellar Wallets Kit v2 (checked on 2.8.0).
// Loaded as a classic script next to the tracker. It has no access to the tenant's kit instance:
// it watches document.body for the kit's modal and reports three steps through umami.track.
// The tracker adds the page's title, URL and referrer to every event, so this file also holds
// the beforeSend hook that rebuilds a wallet funnel event from fixed values and a scrubbed path.
(function () {
  'use strict';

  var EVENT_NAME = 'wallet_funnel';
  var KIT_ROOT_CLASS = 'stellar-wallets-kit';
  var OPENED = 'modal_opened';
  var CLICKED = 'wallet_option_clicked';
  var CLOSED = 'modal_closed';
  var OTHER = 'other';

  // Display names the kit shows in its modal (productName of each module), lower-cased.
  var WALLETS = new Map([
    ['albedo', 'albedo'],
    ['bitget wallet', 'bitget'],
    ['cactus link', 'cactus-link'],
    ["d'cent wallet", 'dcent'],
    ['fordefi', 'fordefi'],
    ['freighter', 'freighter'],
    ['ghostsig', 'ghostsig'],
    ['hana wallet', 'hana'],
    ['hot wallet', 'hot-wallet'],
    ['klever wallet', 'klever'],
    ['ledger', 'ledger'],
    ['lobstr', 'lobstr'],
    ['metamask', 'metamask'],
    ['onekey wallet', 'onekey'],
    ['rabet', 'rabet'],
    ['scopuly', 'scopuly'],
    ['trezor', 'trezor'],
    ['varial', 'varial'],
    ['walletconnect', 'walletconnect'],
    ['xbull', 'xbull'],
  ]);
  var WALLET_VALUES = new Set(WALLETS.values()).add(OTHER);

  // A first cut of the design's path rules; the reference vector file does not exist yet.
  var PATH_RULES = [
    [/[GCMWLBTXPS][A-Z2-7]{55,}/g, '[strkey]'],
    [/[0-9a-fA-F]{64}/g, '[hash]'],
    [/[^/]+@[^/]+\.[a-z]{2,}/gi, '[email]'],
    [/[^/*]+\*[^/*]+\.[a-z]{2,}/gi, '[federation]'],
  ];

  var openModals = [];
  var sending = Promise.resolve();

  function scrubbedPath(url) {
    var pathname = '/';
    try {
      pathname = new URL(url, window.location.href).pathname;
    } catch (error) {
      void error;
    }
    for (var i = 0; i < PATH_RULES.length; i += 1) {
      pathname = pathname.replace(PATH_RULES[i][0], PATH_RULES[i][1]);
    }
    return pathname;
  }

  function funnelData(data) {
    if (!data) return null;
    if (data.step === OPENED || data.step === CLOSED) return { step: data.step };
    if (data.step !== CLICKED || !WALLET_VALUES.has(data.wallet)) return null;
    return { step: CLICKED, wallet: data.wallet };
  }

  /**
   * The tracker's beforeSend hook for wallet funnel events. It returns a new payload that holds
   * only fixed values and the scrubbed path, or false, which makes the tracker send nothing.
   * Other events pass through unchanged: scrubbing them is the wrapper's work.
   */
  function beforeSend(type, payload) {
    if (type !== 'event' || !payload || payload.name !== EVENT_NAME) return payload;
    var data = funnelData(payload.data);
    if (!data) return false;
    return {
      website: payload.website,
      hostname: payload.hostname,
      screen: payload.screen,
      language: payload.language,
      url: scrubbedPath(payload.url),
      name: EVENT_NAME,
      data: data,
    };
  }

  function emit(step, wallet) {
    var data = { step: step };
    if (wallet) data.wallet = wallet;
    // One request at a time keeps the steps in order at the gateway. A failing tracker must
    // not break the tenant's page.
    sending = sending
      .then(function () {
        var tracker = window.umami;
        if (tracker && typeof tracker.track === 'function') return tracker.track(EVENT_NAME, data);
        return undefined;
      })
      .catch(function (error) {
        void error;
      });
  }

  /**
   * Returns the wallet list of the kit's auth modal when `wrapper` has exactly the structure
   * kit 2.x renders, and null for anything else, including the kit's profile modal.
   */
  function authModalList(wrapper) {
    if (wrapper.nodeType !== 1 || wrapper.tagName !== 'DIV') return null;
    if (wrapper.parentNode !== document.body) return null;
    if (wrapper.attributes.length !== 0 || wrapper.children.length !== 1) return null;

    var root = wrapper.children[0];
    if (root.tagName !== 'SECTION' || !root.classList.contains(KIT_ROOT_CLASS)) return null;
    if (root.children.length !== 2) return null;

    var backdrop = root.children[0];
    var panel = root.children[1];
    if (backdrop.tagName !== 'DIV' || backdrop.children.length !== 0) return null;
    if (panel.tagName !== 'SECTION') return null;

    var headers = panel.querySelectorAll('header');
    if (headers.length !== 1) return null;
    if (headers[0].querySelectorAll('h1').length !== 1) return null;
    if (headers[0].querySelectorAll('button').length < 1) return null;

    var lists = panel.querySelectorAll('ul');
    if (lists.length !== 1) return null;
    return lists[0];
  }

  function walletFrom(option) {
    var labels = option.querySelectorAll('p');
    if (labels.length !== 1) return null;
    var name = (labels[0].textContent || '').trim().toLowerCase();
    return WALLETS.get(name) || OTHER;
  }

  function onClick(event) {
    try {
      var wrapper = event.currentTarget;
      var target = event.target;
      if (!target || target.nodeType !== 1 || openModals.indexOf(wrapper) === -1) return;
      var list = authModalList(wrapper);
      if (!list) return;
      var option = target.closest('li');
      if (!option || option.parentNode !== list) return;
      var wallet = walletFrom(option);
      if (wallet) emit(CLICKED, wallet);
    } catch (error) {
      void error;
    }
  }

  // The kit stacks one modal per authModal() call. The visitor sees one, so the stack counts
  // as one: opened with its first modal, closed with its last.
  function adopt(node) {
    if (openModals.indexOf(node) !== -1 || !authModalList(node)) return;
    openModals.push(node);
    node.addEventListener('click', onClick, true);
    if (openModals.length === 1) emit(OPENED);
  }

  function release(node) {
    var index = openModals.indexOf(node);
    if (index === -1) return;
    openModals.splice(index, 1);
    node.removeEventListener('click', onClick, true);
    if (openModals.length === 0) emit(CLOSED);
  }

  function onMutations(records) {
    try {
      for (var i = 0; i < records.length; i += 1) {
        records[i].addedNodes.forEach(adopt);
        records[i].removedNodes.forEach(release);
      }
    } catch (error) {
      void error;
    }
  }

  function start() {
    if (!document.body) return;
    new MutationObserver(onMutations).observe(document.body, { childList: true });
    // A modal opened before this script loaded is counted from now.
    try {
      Array.prototype.forEach.call(document.body.children, adopt);
    } catch (error) {
      void error;
    }
  }

  var supported =
    typeof MutationObserver === 'function' &&
    typeof Promise === 'function' &&
    typeof Map === 'function' &&
    typeof Set === 'function' &&
    typeof URL === 'function' &&
    typeof Element === 'function' &&
    typeof Element.prototype.closest === 'function';
  if (!supported) return;

  window.usWalletFunnelBeforeSend = beforeSend;

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
