/* The single query seam of the Usage Signals consoles. Pages call the functions on
   window.LData and never fetch anything themselves. Everything here comes from our own API:
   there is no sample data in this file.

   A network read is not synchronous, so every page loads first and reads afterwards:
   boot(start)  Loads what the page needs to know who it is for, then /app.js, then calls start().
                On a tenant page that is the project named by the address; an operator page
                needs nothing before it starts. Never rejects: a failure is in status().

   Who am I (tenant console)
   -------------------------
   currentProjectSlug() -> slug | null
     The one place that decides which project a tenant page shows. Today it is the first
     segment of the path (/<slug>/web). With sign-in it reads the session instead, and no page
     changes. This is addressing, not access control.
   project() -> Project | null
     Project = { slug, name, domain, state ('pending_verification' | 'pending_approval' |
                 'active' | 'unverified' | 'suspended' | 'removed'), website_id }
   status() -> { state ('ok' | 'not_found' | 'error'), error | null, through | null }
     through = ISO time of the last figures read.
   meta() -> { product_name, tracker { version, path, integrity } | null,
               rounding { below, step } | null }   (rounding is set by loadOperator)

   Tenant web figures
   ------------------
   loadWeb(rangeDays) -> Promise. Reads the range for the current project and keeps it.
     Rejects with an Error whose message can be shown.
   web(rangeDays) -> { rows [WebDay], totals WebTotals | null, prior WebTotals | null }
     Answers from the last loadWeb() of that range; totals is null when there is no page view.
     WebDay = { day, pageviews, visitors }
     WebTotals = { pageviews, visitors (sum of daily; null in prior), visits, bounces,
                   bounce_rate, avg_visit_seconds }
     Traffic is not classified in this prototype, so there is no flagged or filtered figure.
   breakdown(dimension) -> [{ label, value }]   (distinct visitors in the period; [] when none)
     dimension = 'referrers' | 'countries' | 'devices' | 'browsers'

   Operator console
   ----------------
   loadOperator(rangeDays) -> Promise. One read for every project.
   operatorRows() -> [{ project { id, name, domain, state },
       totals { pageviews, visitors, visits, bounces, bounce_rate, avg_visit_seconds,
                flagged (always null: not classified) },
       daily [{ day, pageviews }], breakdowns { referrers, countries, devices, browsers } }]
     Aggregates only. Counts below meta().rounding.below are rounded by the API, not here. */
(function () {
  'use strict';

  var PRODUCT_NAME = 'Usage Signals';
  var BROWSER_NAMES = {
    ios: 'Safari (iOS)', crios: 'Chrome (iOS)', fxios: 'Firefox (iOS)', 'edge-chromium': 'Edge',
    'chromium-webview': 'Android WebView', 'ios-webview': 'iOS WebView', samsung: 'Samsung Internet'
  };

  var known = { project: null, tracker: null, rounding: null, state: 'ok', error: null, through: null };
  var webByRange = {};
  var latestWeb = null;
  var operator = [];

  function getJson(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) {
          var error = new Error(body.error || 'The server answered ' + response.status + '.');
          error.status = response.status;
          throw error;
        }
        return body;
      });
    });
  }

  /* Replace this body, and only this body, when a session says who the visitor is. */
  function currentProjectSlug() {
    var first = window.location.pathname.split('/')[1] || '';
    return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(first) ? first : null;
  }

  function tenantUrl(resource) {
    return '/api/tenant/' + encodeURIComponent(currentProjectSlug()) + '/' + resource;
  }

  function loadProject() {
    if (!currentProjectSlug()) {
      known.state = 'not_found';
      return Promise.resolve();
    }
    return getJson(tenantUrl('project')).then(function (body) {
      known.project = body.project;
      known.tracker = body.tracker;
    }, function (error) {
      known.state = error.status === 404 ? 'not_found' : 'error';
      known.error = error.message;
    });
  }

  function loadScript(src, done) {
    var script = document.createElement('script');
    script.src = src;
    script.onload = done;
    document.body.appendChild(script);
  }

  function boot(start) {
    var ready = document.body.dataset.audience === 'tenant' ? loadProject() : Promise.resolve();
    ready.then(function () { loadScript('/app.js', start); });
  }

  function totalsOf(t) {
    if (!t || !t.pageviews) return null;
    return {
      pageviews: t.pageviews, visitors: t.visitors, visits: t.visits, bounces: t.bounces,
      bounce_rate: t.visits ? t.bounces / t.visits : 0,
      avg_visit_seconds: t.visits ? t.total_seconds / t.visits : 0
    };
  }

  function loadWeb(rangeDays) {
    return getJson(tenantUrl('web?days=' + rangeDays)).then(function (body) {
      webByRange[rangeDays] = body;
      latestWeb = body;
      known.through = body.through;
    });
  }

  function web(rangeDays) {
    var body = webByRange[rangeDays];
    if (!body) return { rows: [], totals: null, prior: null };
    return { rows: body.daily, totals: totalsOf(body.totals), prior: totalsOf(body.prior) };
  }

  function label(dimension, value) {
    if (dimension === 'countries') {
      try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(value) || value; } catch (error) { return value; }
    }
    if (dimension === 'referrers') return value;
    return BROWSER_NAMES[value] || value.charAt(0).toUpperCase() + value.slice(1);
  }

  function labelled(dimension, rows) {
    return (rows || []).map(function (row) { return { label: label(dimension, row.label), value: row.value }; });
  }

  function loadOperator(rangeDays) {
    return getJson('/api/operator/projects?days=' + rangeDays).then(function (body) {
      known.rounding = body.rounding;
      known.through = body.through;
      operator = body.projects.map(function (row) {
        var breakdowns = {};
        Object.keys(row.breakdowns).forEach(function (dimension) {
          breakdowns[dimension] = labelled(dimension, row.breakdowns[dimension]);
        });
        return { project: row.project, totals: row.totals, daily: row.daily, breakdowns: breakdowns };
      });
    });
  }

  window.LData = {
    boot: boot,
    currentProjectSlug: currentProjectSlug,
    project: function () { return known.project; },
    status: function () { return { state: known.state, error: known.error, through: known.through }; },
    meta: function () { return { product_name: PRODUCT_NAME, tracker: known.tracker, rounding: known.rounding }; },
    loadWeb: loadWeb,
    web: web,
    breakdown: function (dimension) { return labelled(dimension, latestWeb && latestWeb.breakdowns[dimension]); },
    loadOperator: loadOperator,
    operatorRows: function () { return operator.slice(); }
  };
})();
