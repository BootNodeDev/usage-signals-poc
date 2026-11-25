/* Shared shell, formatters and small components for the Pulse consoles. */
(function () {
  'use strict';

  var D = window.LData;
  var META = D.meta();
  var RANGES = [7, 30, 90];
  var NOT_IN_PROTOTYPE = 'Not in this prototype';
  var TENANT_NAV = [['web', 'Web'], ['requests', 'API'], ['setup', 'Setup']];
  var OPERATOR_NAV = [['/operator/projects', 'projects', 'Projects'], ['/operator/access', 'access', 'Access']];

  /* Session storage is a convenience: every read and write may fail in a sandboxed viewer. */
  var store = {
    get: function (key) {
      try { return sessionStorage.getItem('usage-signals-' + key); } catch (error) { return null; }
    },
    set: function (key, value) {
      try { sessionStorage.setItem('usage-signals-' + key, String(value)); } catch (error) { /* see above */ }
    }
  };

  /* The project of a tenant page, as the seam resolved it. Operator pages have none. */
  var tenant = D.project();

  var STATES = {
    pending_verification: ['Pending verification', 'pill pill-warning'],
    pending_approval: ['Pending approval', 'pill pill-warning'],
    active: ['Active', 'state'],
    unverified: ['Unverified', 'pill pill-warning'],
    suspended: ['Suspended', 'pill pill-negative'],
    removed: ['Removed', 'pill pill-removed']
  };

  var icons = {
    web: '<path d="M2 2.5h12v11H2zM2 6h12M6 6v7.5"/>',
    api: '<path d="M5 4.5 1.75 8 5 11.5M11 4.5 14.25 8 11 11.5M9.25 3 6.75 13"/>',
    requests: '<path d="M5 4.5 1.75 8 5 11.5M11 4.5 14.25 8 11 11.5M9.25 3 6.75 13"/>',
    setup: '<path d="M2 4.5h12M2 8h12M2 11.5h7"/>',
    projects: '<path d="M2 4h12M2 8h12M2 12h12"/>',
    access: '<path d="M2.5 7.5h11v6h-11zM5 7.5V5a3 3 0 0 1 6 0v2.5"/>',
    close: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>',
    chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
    back: '<path d="M9.5 3.5 5 8l4.5 4.5"/>',
    more: '<path d="M3 8h.01M8 8h.01M13 8h.01" stroke-width="2.5"/>'
  };
  function icon(name) {
    return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="square" aria-hidden="true">' + icons[name] + '</svg>';
  }

  var MARK = '<img class="mark" src="/favicon.svg?v=2" width="30" height="30" alt="">';

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Rule names sit mid-sentence; acronyms inside them keep their capitals. */
  function lowerFirst(text) { return text.charAt(0).toLowerCase() + text.slice(1); }

  /* ---------- formatters ---------- */

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var fmt = {
    int: function (v) { return Math.round(v).toLocaleString('en-US'); },
    /* Overview figures: 103.6K, 2.2M. Exact values stay in the detail and in the title. */
    compact: function (v) {
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
      return Math.round(v).toLocaleString('en-US');
    },
    tick: function (v) {
      if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
      if (v >= 1e4) return Math.round(v / 1e3) + 'K';
      return Math.round(v).toLocaleString('en-US');
    },
    pct: function (v, digits) { return (v * 100).toFixed(digits === undefined ? 1 : digits) + '%'; },
    ms: function (v) { return v === null ? '–' : Math.round(v).toLocaleString('en-US') + ' ms'; },
    duration: function (seconds) {
      var s = Math.round(seconds);
      return Math.floor(s / 60) + ' m ' + String(s % 60).padStart(2, '0') + ' s';
    },
    day: function (iso) { return Number(iso.slice(8)) + ' ' + MONTHS[Number(iso.slice(5, 7)) - 1]; },
    date: function (iso) { return fmt.day(iso) + ' ' + iso.slice(0, 4); },
    account: function (account) { return account ? account.slice(0, 4) + '…' + account.slice(-4) : 'No account'; }
  };

  /* A relative change always names its baseline; colour says good or bad, not up or down. */
  function delta(current, prior, options) {
    var windowLabel = 'vs prior ' + options.range + ' days';
    if (prior === null || prior === undefined) return '<span class="delta">No prior period</span>';
    var text;
    var change;
    if (options.points) {
      change = (current - prior) * 100;
      text = (change >= 0 ? '+' : '−') + Math.abs(change).toFixed(options.digits || 1) + ' pt';
    } else {
      change = prior ? (current - prior) / prior * 100 : 0;
      text = (change >= 0 ? '+' : '−') + Math.abs(change).toFixed(1) + '%';
    }
    var tone = '';
    if (Math.abs(change) >= 0.05 && options.good) {
      tone = (change > 0) === (options.good === 'up') ? ' is-good' : ' is-bad';
    }
    return '<span class="delta' + tone + '">' + text + '</span> ' + windowLabel;
  }

  /* ---------- components ---------- */

  function statePill(state) {
    var label = STATES[state] || [state, 'pill'];
    return '<span class="' + label[1] + '">' + escapeHtml(label[0]) + '</span>';
  }

  function projectName(project) {
    return escapeHtml(project.name);
  }

  function dash() { return '<span class="muted" aria-label="No data">–</span>'; }
  function empty(text) { return '<p class="empty">' + escapeHtml(text) + '</p>'; }
  function emptyState(title, text, action) {
    return '<div class="empty-state"><h2>' + escapeHtml(title) + '</h2><p>' + text + '</p>' + (action || '') + '</div>';
  }

  var uid = 0;
  function hatchDefs(id) {
    return '<defs><pattern id="' + id + '" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<rect width="5" height="5" style="fill:var(--gold-tint)"/><rect width="2.5" height="5" style="fill:var(--data-flagged)"/></pattern></defs>';
  }

  /* The count bar: filtered against flagged at the true ratio. The flagged part is hatched. */
  function qualityBar(filtered, flagged) {
    var total = filtered + flagged;
    var share = total ? flagged / total * 100 : 0;
    var id = 'q-hatch-' + (++uid);
    var label = fmt.pct(share / 100) + ' flagged, ' + fmt.int(flagged) + ' of ' + fmt.int(total) + ' raw';
    return '<span class="quality" role="img" aria-label="' + label + '" title="' + label + '">' +
      '<svg preserveAspectRatio="none">' + hatchDefs(id) +
      '<rect x="0" y="0" width="' + (100 - share) + '%" height="100%" style="fill:var(--data-filtered)"/>' +
      (share > 0 ? '<rect x="' + (100 - share) + '%" y="0" width="' + share + '%" height="100%" fill="url(#' + id + ')"/>' +
        '<rect x="' + (100 - share) + '%" y="0" width="2" height="100%" style="fill:var(--ground)"/>' : '') +
      '</svg></span>';
  }

  function barRows(rows, options) {
    options = options || {};
    var total = rows.reduce(function (a, r) { return a + r.value; }, 0);
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }));
    return rows.slice(0, options.limit || rows.length).map(function (r) {
      var width = max ? r.value / max * 100 : 0;
      var id = 'b-hatch-' + (++uid);
      var track = options.flag
        ? '<svg class="bar-track" preserveAspectRatio="none" aria-hidden="true">' + hatchDefs(id) + '<rect width="' + width + '%" height="100%" fill="url(#' + id + ')"/></svg>'
        : '<span class="bar-track"><span class="bar-fill" style="width:' + width + '%"></span></span>';
      return '<div class="bar-row' + (options.flag ? ' is-flag' : '') + '">' +
        '<span class="bar-label" title="' + escapeHtml(r.label) + '">' + escapeHtml(r.label) + '</span>' +
        '<span class="bar-value">' + fmt.int(r.value) + '</span>' +
        '<span class="bar-share">' + fmt.pct(total ? r.value / total : 0) + '</span>' + track + '</div>';
    }).join('');
  }
  function barList(el, rows, options) {
    el.innerHTML = rows.length ? barRows(rows, options) : empty((options && options.emptyText) || 'No data in this period.');
  }

  function dataTable(el, headers, rows) {
    if (!rows.length) {
      el.innerHTML = empty('No data in this period.');
      return;
    }
    el.innerHTML = '<table class="data data-compact"><thead><tr>' + headers.map(function (h, i) {
      return '<th' + (i ? ' class="num"' : '') + '>' + escapeHtml(h) + '</th>';
    }).join('') + '</tr></thead><tbody>' + rows.map(function (row) {
      return '<tr>' + row.map(function (cell, i) {
        return '<td' + (i ? ' class="num"' : '') + '>' + escapeHtml(cell) + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody></table>';
  }

  function csvCell(value) {
    if (typeof value === 'number') return String(value);
    var text = value === null || value === undefined ? '' : String(value);
    var formula = /^[\s=+\-@]/.test(text); /* spreadsheets run such text as a formula (OWASP, CSV injection) */
    return '"' + (formula ? "'" : '') + text.replace(/"/g, '""') + '"';
  }

  function downloadCsv(name, headers, rows) {
    var text = [headers].concat(rows).map(function (row) { return row.map(csvCell).join(',') + '\r\n'; }).join('');
    var link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' })); /* the byte order mark makes Excel read UTF-8 */
    link.download = name;
    link.click();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 40000); /* some browsers start the download after click() returns; FileSaver.js waits 40 s */
  }

  /* Chart or table: the same rows, so every value is reachable without hover. */
  function viewToggle(button, chartEl, tableEl) {
    button.addEventListener('click', function () {
      var showTable = tableEl.hidden;
      tableEl.hidden = !showTable;
      chartEl.hidden = showTable;
      button.textContent = showTable ? 'View chart' : 'View table';
      if (!showTable && chartEl.chartRender) chartEl.chartRender();
    });
  }

  /* A definition one step away: the label is the control, and it opens "How this is counted". */
  function info(id, label, html) {
    return '<button class="term" type="button" popovertarget="pop-' + id + '" title="How this is counted">' + escapeHtml(label) + '</button>' +
      '<div class="pop" popover id="pop-' + id + '"><h3>How this is counted</h3>' + html + '</div>';
  }

  /* Popovers open next to the control that invoked them and scale in from it. */
  var POPOVER_NATIVE = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;
  function placePopover(pop, invoker) {
    var anchor = invoker.getBoundingClientRect();
    var box = pop.getBoundingClientRect();
    /* A definition opens under its whole figure, so it never covers the value it explains. */
    var figure = invoker.classList.contains('term') && invoker.closest('.figure');
    if (figure) anchor = { left: anchor.left, width: anchor.width, top: anchor.top, bottom: figure.getBoundingClientRect().bottom };
    var left = Math.min(Math.max(8, anchor.left), window.innerWidth - box.width - 8);
    var below = anchor.bottom + 6 + box.height <= window.innerHeight - 8;
    pop.style.left = left + 'px';
    pop.style.top = (below ? anchor.bottom + 6 : Math.max(8, anchor.top - box.height - 6)) + 'px';
    pop.style.setProperty('--origin', (below ? 'top ' : 'bottom ') + Math.round(anchor.left - left + anchor.width / 2) + 'px');
  }
  function invokerOf(pop) { return document.querySelector('[popovertarget="' + pop.id + '"]'); }
  document.addEventListener('toggle', function (event) {
    var pop = event.target;
    if (!pop.classList || !pop.classList.contains('pop') || event.newState !== 'open') return;
    var invoker = invokerOf(pop);
    if (invoker) placePopover(pop, invoker);
  }, true);
  if (!POPOVER_NATIVE) {
    document.addEventListener('click', function (event) {
      var invoker = event.target.closest && event.target.closest('[popovertarget]');
      document.querySelectorAll('.pop.is-open').forEach(function (open) {
        if (!invoker || open.id !== invoker.getAttribute('popovertarget')) {
          if (!open.contains(event.target)) open.classList.remove('is-open');
        }
      });
      if (!invoker) return;
      var pop = document.getElementById(invoker.getAttribute('popovertarget'));
      if (pop && pop.classList.toggle('is-open')) placePopover(pop, invoker);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      document.querySelectorAll('.pop.is-open').forEach(function (open) {
        open.classList.remove('is-open');
        var invoker = invokerOf(open);
        if (invoker) invoker.focus();
      });
    });
    var style = document.createElement('style');
    style.textContent = '.pop:not(.is-open){display:none}';
    document.head.appendChild(style);
  }

  /* Tabs with roving focus: arrow keys move, the selected tab is the only tab stop. */
  function tabs(list, onSelect) {
    function select(tab, focus) {
      Array.prototype.forEach.call(list.querySelectorAll('[role="tab"]'), function (t) {
        t.setAttribute('aria-selected', String(t === tab));
        t.tabIndex = t === tab ? 0 : -1;
      });
      if (focus) tab.focus();
      onSelect(tab.dataset.tab);
    }
    list.addEventListener('click', function (event) {
      var tab = event.target.closest('[role="tab"]');
      if (tab) select(tab, false);
    });
    list.addEventListener('keydown', function (event) {
      var all = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
      var index = all.indexOf(document.activeElement);
      if (index < 0) return;
      var next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: all.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(all[(next + all.length) % all.length], true);
    });
    Array.prototype.forEach.call(list.querySelectorAll('[role="tab"]'), function (t) {
      t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1;
    });
  }

  function readRange() {
    var stored = Number(store.get('range'));
    return RANGES.indexOf(stored) >= 0 ? stored : 30;
  }
  function rangeControl(el, onChange) {
    var current = readRange();
    el.className = 'seg';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Time range');
    el.innerHTML = RANGES.map(function (days) {
      return '<button type="button" data-range="' + days + '" aria-pressed="' + (days === current) + '">' + days + ' days</button>';
    }).join('');
    el.addEventListener('click', function (event) {
      var button = event.target.closest('button');
      if (!button) return;
      current = Number(button.dataset.range);
      store.set('range', current);
      Array.prototype.forEach.call(el.children, function (b) { b.setAttribute('aria-pressed', String(b === button)); });
      onChange(current);
    });
    onChange(current);
  }

  function stamp() {
    var through = D.status().through;
    return through ? 'Through ' + fmt.date(through.slice(0, 10)) + ', ' + through.slice(11, 16) + ' UTC' : '';
  }

  /* Plot height follows the window so the first viewport holds the whole answer. */
  function plotHeight(reserved, min, max) {
    return Math.max(min, Math.min(max, window.innerHeight - reserved));
  }

  /* ---------- shell ---------- */

  function navLink(href, name, text, active) {
    return '<a href="' + href + '"' + (active === name ? ' aria-current="page"' : '') + '>' + icon(name) + text + '</a>';
  }

  /* The two consoles share nothing but this frame: each builds its navigation from its own
     list, and neither links to the other. */
  function tenantShell(active) {
    var slug = D.currentProjectSlug();
    var base = '/' + encodeURIComponent(slug || '');
    var scope = tenant
      ? '<div class="scope-name">' + projectName(tenant) + '</div><div class="scope-meta"><span>' + escapeHtml(tenant.domain) + '</span>' +
        statePill(tenant.state) + '</div>'
      : '<div class="scope-name">No project</div>';
    var nav = tenant ? TENANT_NAV.map(function (item) { return navLink(base + '/' + item[0], item[0], item[1], active); }).join('') : '';
    return '<a class="brand" href="' + (tenant ? base + '/web' : '#') + '">' + MARK + '<span>' + escapeHtml(META.product_name) + '</span></a>' +
      '<div class="scope">' + scope + '</div><nav class="nav" aria-label="Main">' + nav + '</nav>' +
      '<div class="sidebar-foot"><div class="account"><b>No sign-in</b>This prototype has no accounts: the address names the project.</div></div>';
  }

  function operatorShell(active) {
    return '<a class="brand" href="/operator/projects">' + MARK + '<span>' + escapeHtml(META.product_name) + '</span></a>' +
      '<div class="scope"><div class="scope-name">Stellar Community Fund</div><div class="scope-meta"><span>Operator console, all projects</span></div></div>' +
      '<nav class="nav" aria-label="Main">' + OPERATOR_NAV.map(function (item) { return navLink(item[0], item[1], item[2], active); }).join('') + '</nav>' +
      '<div class="sidebar-foot"><div class="account"><b>No sign-in</b>This prototype has no accounts: anyone with this address sees it.</div></div>';
  }

  function shell() {
    var active = document.body.dataset.active;
    var isOperator = document.body.dataset.audience === 'operator';
    document.getElementById('sidebar').innerHTML = isOperator ? operatorShell(active) : tenantShell(active);
  }

  /* Pages load this file after their first read, when the document is already parsed. */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', shell);
  else shell();

  window.App = {
    tenant: tenant, NOT_IN_PROTOTYPE: NOT_IN_PROTOTYPE, store: store,
    fmt: fmt, delta: delta, escapeHtml: escapeHtml, lowerFirst: lowerFirst, icon: icon,
    statePill: statePill, projectName: projectName, empty: empty, emptyState: emptyState, dash: dash,
    qualityBar: qualityBar, barRows: barRows, barList: barList, dataTable: dataTable, downloadCsv: downloadCsv, viewToggle: viewToggle,
    info: info, tabs: tabs, rangeControl: rangeControl, stamp: stamp, plotHeight: plotHeight
  };
})();
