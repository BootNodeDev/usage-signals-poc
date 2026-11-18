/* Sample data and the single query seam for the four Usage Signals mockups.
   Pages call the functions on window.LData and never read the raw rows, so
   wiring a real API means replacing the bodies of these functions only.
   Every total on screen is computed from the rows below.

   Query functions and their return shapes
   ---------------------------------------
   meta() -> {
     product_name, last_complete_day, rule_set_version, tracker_version, tracker_url,
     tracker_sri, npm_package, otlp_endpoint, enrollment_mode ('open' | 'approval_required'),
     histogram_bounds_ms [14 numbers], token_lifetime_months, series_cap, series_cap_days,
     small_count_below, small_count_step, operator_account, default_project_id }
   flagRules() / apiFlagRules() -> { rule_key: label }
   projects() -> [Project]
   project(idOrSlug) -> Project | null
     Project = { id, slug, name, fictional, domain, account | null,
       state ('pending_verification' | 'pending_approval' | 'active' | 'unverified' |
              'suspended' | 'removed'),
       enrolled_at, notification_channel { type ('email' | 'webhook'), address } | null,
       sites [{ id, domain, proof { method ('page' | 'dns_txt' | 'stellar_toml'),
                verified_at, last_checked_at } | null, first_event_at | null }],
       evidence [{ kind, label, status ('checked' | 'to_review' | 'unconfirmed' | 'confirmed') }],
       dpa_accepted_at | null, services [string], api_flags [rule_key] }
   web(projectId, rangeDays) -> { rows [WebDay], totals WebTotals | null, prior WebTotals | null }
     WebDay = { day, pageviews_raw, pageviews_flagged, visitors_raw, visitors_flagged,
                visits, bounces, visit_seconds, flagged_by_rule { rule_key: count } }
     WebTotals = { pageviews_raw, pageviews_flagged, pageviews_filtered, visitors_raw,
                   visitors_flagged, visitors_filtered (all visitor figures are sums of daily),
                   visits, bounces, bounce_rate, avg_visit_seconds, flagged_share,
                   flagged_by_rule, top_rule | null }
   breakdown(projectId, dimension, total) -> [{ label, value }]   ([] when there is none)
     dimension = 'referrers' | 'countries' | 'devices' | 'browsers'
   api(projectId, rangeDays, service?) -> {
     totals ApiTotals | null, prior ApiTotals | null,
     daily [ApiTotals + { day }], routes [ApiTotals + { service, method | null, route, kind }],
     incident { at, day, rate, route } | null, series { seen_30d | null, cap, window_days } }
     ApiTotals = { requests, status_codes { code: count }, status_classes { '2xx'..'5xx': count },
                   client_error_rate, server_error_rate, p50_ms, p95_ms }
     kind = 'route' | 'overflow' ("(other)") | 'unmatched' ("(unmatched)")
   tenantToken(projectId) -> { masked, issued_at, expires_at, expired, lifetime_months,
                               last_export_day | null, last_export_service | null } | null
   operatorRows(rangeDays) -> [{ project, web WebTotals | null, web_prior WebTotals | null,
       api ApiTotals | null, api_prior ApiTotals | null,
       token (as tenantToken) | null, breakdowns { referrers, countries, devices, browsers },
       daily [{ day, pageviews_filtered, pageviews_flagged }],
       api_daily [{ day, requests }] (only days with an export) }]
     Aggregates only. Counts below meta().small_count_below are rounded here, in the query layer.
   rangeDays(rangeDays) -> [day]   (ISO days of the range, oldest first, ending on last_complete_day)
   metricsApiKeys() -> [{ id, label, prefix, scope, created_at, last_used_at, status }]

   Live web figures (the tenant web screen only)
   ---------------------------------------------
   The functions above answer synchronously; a network read cannot. A page that wants real
   figures therefore loads first and reads afterwards, still only through this seam:
   connect() -> Promise (never rejects). Reads GET /api/sites and switches this page to live
     mode: projects() and project() then return the registered sites, as Projects whose id is
     the site id. Call it before app.js is loaded, because app.js picks the tenant on load.
   loadWeb(projectId, rangeDays) -> Promise. Reads GET /api/web for that range and keeps it.
     Rejects with an Error whose message can be shown when the figures cannot be read.
   status() -> { live, error | null, through | null }   (through = ISO time of the last read)
   In live mode web() and breakdown() answer from the last loadWeb() of that project, with
   the same shapes and these differences, because the prototype does not classify traffic:
     every *_flagged and *_filtered figure, flagged_share, flagged_by_rule and top_rule is
     null (unknown, not zero), totals.classified is false, and visitors_raw is the sum of
     the daily visitors. breakdown() values are distinct visitors in the period, not sums of
     daily. A page that never calls connect() gets the sample data, unchanged. */
(function () {
  'use strict';

  var DAY_COUNT = 90;
  var LAST_DAY = '2026-11-17';
  var HISTOGRAM_BOUNDS_MS = [5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000];
  var INGEST_HOST = 'https://in.usagesignals.example';
  var TRACKER_BUILD = '1.0.0-9f2c41ab';

  var metaValues = {
    product_name: 'Usage Signals',
    last_complete_day: LAST_DAY,
    rule_set_version: '2026.11.0',
    tracker_version: '1.0.0',
    tracker_url: INGEST_HOST + '/s/' + TRACKER_BUILD + '/t.js',
    tracker_sri: 'sha384-pT4mW1kQx0cVb8Jr2uYhN6dZsE9aLfG3oKiX7wRtC5nMqB0yUvH1jSgDzOePlAc',
    npm_package: '@usage-signals/browser',
    otlp_endpoint: INGEST_HOST + '/v1/metrics',
    enrollment_mode: 'approval_required',
    histogram_bounds_ms: HISTOGRAM_BOUNDS_MS,
    token_lifetime_months: 13,
    series_cap: 500,
    series_cap_days: 30,
    small_count_below: 100,
    small_count_step: 10,
    operator_account: 'reviewer@fund.example',
    default_project_id: 'prj_trustlesswork'
  };

  var webFlagRules = {
    ip_visitor_values: 'Many visitor values from one IP',
    hosting_network: 'Hosting network'
  };
  var apiFlagRuleLabels = {
    no_client_errors: 'No client errors',
    flat_line: 'Flat request rate',
    sudden_jump: 'Sudden jump',
    identical_histograms: 'Identical histograms'
  };

  function seeded(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Not a valid address: one placeholder stands in for every signed-in wallet. */
  var SAMPLE_ACCOUNT = 'GSAMPLE' + new Array(46).join('A') + 'XMPL';

  function site(id, domain, method, verifiedAt, firstEventAt) {
    return {
      id: id, domain: domain,
      proof: method ? { method: method, verified_at: verifiedAt, last_checked_at: LAST_DAY } : null,
      first_event_at: firstEventAt || null
    };
  }

  /* A real project used as an example: active, no flags, no evidence claims. */
  function exampleProject(id, slug, name, domain, enrolledAt, siteId, services) {
    return {
      id: id, slug: slug, name: name, fictional: false, domain: domain, account: SAMPLE_ACCOUNT,
      state: 'active', enrolled_at: enrolledAt,
      notification_channel: { type: 'email', address: 'notices@example.org' },
      sites: [site(siteId, domain, 'dns_txt', enrolledAt, enrolledAt)],
      evidence: [], dpa_accepted_at: enrolledAt, services: services, api_flags: []
    };
  }

  var projectRows = [
    exampleProject('prj_trustlesswork', 'trustless-work', 'Trustless Work', 'trustlesswork.com', '2026-06-18', 'site_2c90be17', ['api']),
    exampleProject('prj_sorobanscan', 'soroban-scan', 'Soroban Scan', 'sorobanscan.com', '2026-06-24', 'site_b41d7705', ['api']),
    exampleProject('prj_stellaratlas', 'stellaratlas', 'StellarAtlas', 'stellaratlas.io', '2026-07-02', 'site_5e07a9d4', ['api']),
    exampleProject('prj_scopuly', 'scopuly', 'Scopuly', 'scopuly.com', '2026-07-09', 'site_d3368c0a', []),
    exampleProject('prj_brlp', 'brlp', 'BRLP', 'brlp.money', '2026-07-21', 'site_70aa1f3e', ['api']),
    exampleProject('prj_obsrvr', 'obsrvr-radar', 'OBSRVR Radar', 'radar.withobsrvr.com', '2026-08-04', 'site_19c4e2b7', ['api']),
    {
      id: 'prj_northwind', slug: 'northwind-tickets', name: 'Northwind Tickets', fictional: true,
      domain: 'northwind-tickets.example', account: SAMPLE_ACCOUNT, state: 'active', enrolled_at: '2025-09-28',
      notification_channel: { type: 'webhook', address: 'https://northwind-tickets.example/hooks/notices' },
      sites: [site('site_a6f0d913', 'northwind-tickets.example', 'page', '2025-09-28', '2025-09-28')],
      evidence: [{ kind: 'scf_record', label: 'SCF project record', status: 'to_review' }],
      dpa_accepted_at: '2025-09-28', services: ['tickets-api'], api_flags: []
    },
    {
      id: 'prj_anchorline', slug: 'anchorline', name: 'Anchorline', fictional: true,
      domain: 'anchorline.example', account: SAMPLE_ACCOUNT, state: 'active', enrolled_at: '2026-06-30',
      notification_channel: { type: 'email', address: 'ops@anchorline.example' },
      sites: [site('site_3b7c52ee', 'anchorline.example', 'stellar_toml', '2026-06-30', '2026-06-30')],
      evidence: [{ kind: 'stellar_toml_issuer', label: 'Issuer in stellar.toml', status: 'checked' }],
      dpa_accepted_at: '2026-06-30', services: ['anchor-api'], api_flags: ['no_client_errors', 'sudden_jump']
    },
    {
      id: 'prj_orbit', slug: 'orbit-remit', name: 'Orbit Remit', fictional: true,
      domain: 'orbit-remit.example', account: SAMPLE_ACCOUNT, state: 'pending_approval', enrolled_at: '2026-11-15',
      notification_channel: { type: 'email', address: 'team@orbit-remit.example' },
      sites: [site('site_e81b04c6', 'orbit-remit.example', 'dns_txt', '2026-11-15', null)],
      evidence: [], dpa_accepted_at: '2026-11-15', services: [], api_flags: []
    }
  ];

  var ingestTokens = {
    prj_trustlesswork: { issued_at: '2026-06-18', suffix: 'c2d1' },
    prj_sorobanscan: { issued_at: '2026-06-24', suffix: '07be' },
    prj_stellaratlas: { issued_at: '2026-07-02', suffix: 'a94f' },
    prj_brlp: { issued_at: '2026-07-21', suffix: '5e30' },
    prj_obsrvr: { issued_at: '2026-08-04', suffix: 'd7c8' },
    prj_northwind: { issued_at: '2025-10-01', suffix: '61ab' },
    prj_anchorline: { issued_at: '2026-06-30', suffix: 'f02c' }
  };

  var seriesSeen30d = { prj_northwind: 512 };

  var apiKeyRows = [
    { id: 'key_01', label: 'Reviewer dashboard export', prefix: 'usk_live_7f2c', scope: 'All projects', created_at: '2026-09-02', last_used_at: '2026-11-17', status: 'active' },
    { id: 'key_02', label: 'Quarterly report job', prefix: 'usk_live_c91e', scope: 'All projects', created_at: '2026-10-01', last_used_at: '2026-11-01', status: 'active' },
    { id: 'key_03', label: 'Anchorline status page', prefix: 'usk_live_04ab', scope: 'Anchorline', created_at: '2026-10-20', last_used_at: '2026-11-16', status: 'active' },
    { id: 'key_04', label: 'Load test client', prefix: 'usk_live_e6d0', scope: 'All projects', created_at: '2026-08-11', last_used_at: '2026-08-14', status: 'revoked' }
  ];

  /* ---------- generation ---------- */

  var days = [];
  (function () {
    var last = Date.parse(LAST_DAY + 'T00:00:00Z');
    for (var i = DAY_COUNT - 1; i >= 0; i--) {
      days.push(new Date(last - i * 86400000).toISOString().slice(0, 10));
    }
  })();

  function addMonths(iso, months) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + months);
    return d.toISOString().slice(0, 10);
  }

  function weekdayFactor(iso, weekendDip) {
    var d = new Date(iso + 'T00:00:00Z').getUTCDay();
    return d === 0 || d === 6 ? 1 - weekendDip : 1;
  }

  function quietWeb(seed, pageviews, growth, bounce, visitSeconds) {
    return {
      seed: seed, pageviews: pageviews, growth: growth, weekend: 0.14, views_per_visitor: 2.4,
      bounce: bounce, visit_s: visitSeconds,
      flag: { ip_visitor_values: 0.008, hosting_network: 0.012 }, bursts: []
    };
  }

  var webProfiles = {
    prj_trustlesswork: quietWeb(23, 2100, 0.08, 0.44, 138),
    prj_sorobanscan: quietWeb(37, 3400, 0.06, 0.42, 151),
    prj_stellaratlas: quietWeb(41, 2800, 0.09, 0.45, 129),
    prj_scopuly: quietWeb(53, 3000, 0.05, 0.43, 144),
    prj_brlp: quietWeb(67, 1700, 0.10, 0.46, 121),
    prj_obsrvr: quietWeb(71, 2300, 0.07, 0.41, 156),
    prj_northwind: {
      seed: 59, pageviews: 2600, growth: 0.04, weekend: 0.08, views_per_visitor: 1.9,
      bounce: 0.61, visit_s: 74,
      flag: { ip_visitor_values: 0.030, hosting_network: 0.028 },
      bursts: [
        { from: 58, to: 79, rule: 'ip_visitor_values', extra: 0.52 },
        { from: 64, to: 72, rule: 'hosting_network', extra: 0.14 }
      ]
    },
    prj_anchorline: {
      seed: 83, pageviews: 1240, growth: 0.06, weekend: 0.30, views_per_visitor: 2.4,
      bounce: 0.47, visit_s: 141,
      flag: { ip_visitor_values: 0.012, hosting_network: 0.018 }, bursts: []
    }
  };

  function buildWebDaily(profile) {
    var rand = seeded(profile.seed);
    return days.map(function (day, i) {
      var trend = 1 + profile.growth * (i / (DAY_COUNT - 1));
      var noise = 0.9 + rand() * 0.2;
      var filteredViews = Math.round(profile.pageviews * trend * weekdayFactor(day, profile.weekend) * noise);
      var flagged = {};
      var flaggedViews = 0;
      Object.keys(profile.flag).forEach(function (rule) {
        var rate = profile.flag[rule] * (0.7 + rand() * 0.6);
        profile.bursts.forEach(function (b) {
          if (b.rule === rule && i >= b.from && i <= b.to) rate += b.extra * (0.8 + rand() * 0.4);
        });
        flagged[rule] = Math.round(filteredViews * rate);
        flaggedViews += flagged[rule];
      });
      var filteredVisitors = Math.round(filteredViews / (profile.views_per_visitor * (0.94 + rand() * 0.12)));
      var flaggedVisitors = Math.round(flaggedViews / 1.3);
      var visits = Math.round(filteredVisitors * 1.12);
      var bounces = Math.round(visits * profile.bounce * (0.94 + rand() * 0.12));
      return {
        day: day,
        pageviews_raw: filteredViews + flaggedViews,
        pageviews_flagged: flaggedViews,
        visitors_raw: filteredVisitors + flaggedVisitors,
        visitors_flagged: flaggedVisitors,
        visits: visits,
        bounces: bounces,
        visit_seconds: Math.round(visits * profile.visit_s * (0.92 + rand() * 0.16)),
        flagged_by_rule: flagged
      };
    });
  }

  var webDaily = {};
  projectRows.forEach(function (p) {
    webDaily[p.id] = webProfiles[p.id] ? buildWebDaily(webProfiles[p.id]) : [];
  });

  /* Shares of filtered traffic: one generic table, varied a little per project. */
  var genericBreakdown = {
    referrers: [['Direct or unknown', 0.40], ['google.com', 0.16], ['x.com', 0.10], ['github.com', 0.08], ['stellar.org', 0.06], ['discord.com', 0.04]],
    countries: [['United States', 0.20], ['Brazil', 0.09], ['Germany', 0.08], ['India', 0.07], ['Nigeria', 0.06]],
    devices: [['Desktop', 0.58], ['Mobile', 0.37], ['Tablet', 0.05]],
    browsers: [['Chrome', 0.52], ['Safari', 0.21], ['Firefox', 0.11]]
  };

  function breakdownShares(projectId, dimension) {
    var template = genericBreakdown[dimension];
    if (!webProfiles[projectId] || !template) return [];
    var rand = seeded(webProfiles[projectId].seed * 7 + dimension.length);
    var varied = template.map(function (pair) { return [pair[0], pair[1] * (0.85 + rand() * 0.3)]; });
    if (dimension !== 'devices') return varied;
    var sumShares = varied.reduce(function (a, pair) { return a + pair[1]; }, 0);
    return varied.map(function (pair) { return [pair[0], pair[1] / sumShares]; });
  }

  /* ---------- API telemetry ---------- */

  function erf(x) {
    var sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    var t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return sign * y;
  }
  function logNormalCdf(x, median, sigma) {
    return 0.5 * (1 + erf(Math.log(x / median) / (sigma * Math.SQRT2)));
  }
  function bucketShares(median, sigma) {
    var shares = [];
    var previous = 0;
    HISTOGRAM_BOUNDS_MS.forEach(function (bound) {
      var c = logNormalCdf(bound, median, sigma);
      shares.push(c - previous);
      previous = c;
    });
    shares.push(1 - previous);
    return shares;
  }

  /* Generic normalized routes, the same for every project that reports API traffic. */
  function genericApi(seed, scale, service) {
    var speed = 0.8 + (seed % 9) * 0.06;
    var route = function (method, path, perDay, median, codes) {
      return {
        service: service, method: method, route: path, per_day: Math.round(perDay * scale),
        median: median * speed, sigma: 0.6 + (seed % 4) * 0.04, codes: codes
      };
    };
    return {
      seed: seed, growth: 0.07, weekend: 0.08, incidents: [],
      routes: [
        route('GET', '/items', 21000, 28, { 200: 0.958, 304: 0.030, 400: 0.006, 429: 0.004, 500: 0.002 }),
        route('GET', '/items/{id}', 16500, 34, { 200: 0.946, 304: 0.018, 404: 0.031, 429: 0.003, 500: 0.002 }),
        route('GET', '/accounts/{account}', 11800, 52, { 200: 0.931, 400: 0.012, 404: 0.052, 429: 0.003, 500: 0.002 }),
        route('POST', '/search', 6400, 120, { 200: 0.938, 400: 0.047, 422: 0.009, 429: 0.004, 500: 0.002 })
      ]
    };
  }

  var apiProfiles = {
    prj_trustlesswork: genericApi(131, 0.6, 'api'),
    prj_sorobanscan: genericApi(137, 1.3, 'api'),
    prj_stellaratlas: genericApi(149, 1.0, 'api'),
    prj_brlp: genericApi(157, 0.5, 'api'),
    prj_obsrvr: genericApi(163, 0.9, 'api'),
    prj_northwind: (function () {
      var profile = genericApi(173, 0.4, 'tickets-api');
      profile.until = '2026-11-01';
      profile.incidents = [{ day_index: 66, route: '/search', code: 503, share: 0.17, slowdown: 3.4 }];
      profile.routes.push(
        { service: 'tickets-api', method: null, route: '(unmatched)', kind: 'unmatched', per_day: 900, median: 44, sigma: 0.8, codes: { 200: 0.952, 404: 0.041, 500: 0.007 } },
        { service: 'tickets-api', method: null, route: '(other)', kind: 'overflow', per_day: 500, median: 37, sigma: 0.7, codes: { 200: 0.961, 404: 0.034, 500: 0.005 } }
      );
      return profile;
    })(),
    prj_anchorline: {
      seed: 151, growth: 0.03, weekend: 0.02, incidents: [], jump: { from: 68, factor: 2.6 },
      routes: [
        { service: 'anchor-api', method: 'GET', route: '/transactions/{id}', per_day: 26000, median: 40, sigma: 0.2, codes: { 200: 0.999, 500: 0.001 } },
        { service: 'anchor-api', method: 'POST', route: '/transactions', per_day: 13200, median: 120, sigma: 0.2, codes: { 200: 0.999, 500: 0.001 } },
        { service: 'anchor-api', method: 'GET', route: '/info', per_day: 8400, median: 35, sigma: 0.2, codes: { 200: 1 } }
      ]
    }
  };

  function splitByShare(total, shareByKey, rand) {
    var keys = Object.keys(shareByKey);
    var largest = keys.reduce(function (a, b) { return shareByKey[b] > shareByKey[a] ? b : a; });
    var out = {};
    var assigned = 0;
    keys.forEach(function (key) {
      if (key === largest) return;
      var jitter = rand ? 0.8 + rand() * 0.4 : 1;
      out[key] = Math.round(total * shareByKey[key] * jitter);
      assigned += out[key];
    });
    out[largest] = total - assigned;
    return out;
  }

  function buildApiDaily(profile) {
    var rand = seeded(profile.seed);
    var rows = [];
    days.forEach(function (day, i) {
      if (profile.until && day > profile.until) return;
      var trend = 1 + profile.growth * (i / (DAY_COUNT - 1));
      if (profile.jump && i >= profile.jump.from) trend *= profile.jump.factor;
      profile.routes.forEach(function (r) {
        var requests = Math.round(r.per_day * trend * weekdayFactor(day, profile.weekend) * (0.93 + rand() * 0.14));
        var codes = Object.assign({}, r.codes);
        var median = r.median * (0.95 + rand() * 0.1);
        profile.incidents.forEach(function (incident) {
          if (incident.day_index === i && incident.route === r.route) {
            codes[incident.code] = (codes[incident.code] || 0) + incident.share;
            median *= incident.slowdown;
          }
        });
        var shares = bucketShares(median, r.sigma);
        var bucketMap = {};
        shares.forEach(function (s, index) { bucketMap[index] = s; });
        var buckets = splitByShare(requests, bucketMap);
        rows.push({
          day: day, service: r.service, method: r.method, route: r.route, kind: r.kind || 'route',
          requests: requests,
          status_codes: splitByShare(requests, codes, rand),
          latency_buckets: shares.map(function (_, index) { return buckets[index]; })
        });
      });
    });
    return rows;
  }

  var apiDaily = {};
  projectRows.forEach(function (p) {
    apiDaily[p.id] = apiProfiles[p.id] ? buildApiDaily(apiProfiles[p.id]) : [];
  });

  /* ---------- queries ---------- */

  function sum(rows, pick) {
    return rows.reduce(function (acc, row) { return acc + pick(row); }, 0);
  }

  function webTotals(rows) {
    if (!rows.length) return null;
    var raw = sum(rows, function (r) { return r.pageviews_raw; });
    var flagged = sum(rows, function (r) { return r.pageviews_flagged; });
    var visitorsRaw = sum(rows, function (r) { return r.visitors_raw; });
    var visitorsFlagged = sum(rows, function (r) { return r.visitors_flagged; });
    var visits = sum(rows, function (r) { return r.visits; });
    var bounces = sum(rows, function (r) { return r.bounces; });
    var byRule = {};
    Object.keys(webFlagRules).forEach(function (rule) {
      byRule[rule] = sum(rows, function (r) { return r.flagged_by_rule[rule] || 0; });
    });
    var topRule = flagged ? Object.keys(byRule).sort(function (a, b) { return byRule[b] - byRule[a]; })[0] : null;
    return {
      pageviews_raw: raw, pageviews_flagged: flagged, pageviews_filtered: raw - flagged,
      visitors_raw: visitorsRaw, visitors_flagged: visitorsFlagged, visitors_filtered: visitorsRaw - visitorsFlagged,
      visits: visits, bounces: bounces,
      bounce_rate: visits ? bounces / visits : 0,
      avg_visit_seconds: visits ? sum(rows, function (r) { return r.visit_seconds; }) / visits : 0,
      flagged_share: raw ? flagged / raw : 0,
      flagged_by_rule: byRule, top_rule: topRule
    };
  }

  function web(projectId, rangeDays) {
    var all = webDaily[projectId] || [];
    var rows = all.slice(-rangeDays);
    var prior = all.slice(-2 * rangeDays, -rangeDays);
    return {
      rows: rows,
      totals: webTotals(rows),
      prior: prior.length === rangeDays ? webTotals(prior) : null
    };
  }

  /* Parts always add up to the total: the remainder is "Other", or rounding
     drift on the largest row when the shares already cover everything. */
  function breakdown(projectId, dimension, total) {
    var shares = breakdownShares(projectId, dimension);
    if (!shares.length || !(total > 0)) return [];
    var covered = sum(shares, function (pair) { return pair[1]; });
    var named = shares.map(function (pair) { return { label: pair[0], value: Math.round(total * pair[1]) }; });
    var rest = total - sum(named, function (r) { return r.value; });
    if (covered > 0.999) named[0].value += rest;
    else named.push({ label: 'Other', value: rest });
    return named.sort(function (a, b) { return (a.label === 'Other') - (b.label === 'Other') || b.value - a.value; });
  }

  function percentile(buckets, q) {
    var total = buckets.reduce(function (a, b) { return a + b; }, 0);
    if (!total) return null;
    var target = total * q;
    var seen = 0;
    for (var i = 0; i < buckets.length; i++) {
      if (seen + buckets[i] >= target) {
        var lower = i === 0 ? 0 : HISTOGRAM_BOUNDS_MS[i - 1];
        var upper = i < HISTOGRAM_BOUNDS_MS.length ? HISTOGRAM_BOUNDS_MS[i] : lower;
        return lower + (upper - lower) * ((target - seen) / buckets[i]);
      }
      seen += buckets[i];
    }
    return HISTOGRAM_BOUNDS_MS[HISTOGRAM_BOUNDS_MS.length - 1];
  }

  function apiTotals(rows) {
    if (!rows.length) return null;
    var codes = {};
    var buckets = HISTOGRAM_BOUNDS_MS.concat([0]).map(function () { return 0; });
    var requests = 0;
    rows.forEach(function (row) {
      requests += row.requests;
      Object.keys(row.status_codes).forEach(function (code) {
        codes[code] = (codes[code] || 0) + row.status_codes[code];
      });
      row.latency_buckets.forEach(function (count, index) { buckets[index] += count; });
    });
    var classes = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    Object.keys(codes).forEach(function (code) { classes[code.charAt(0) + 'xx'] += codes[code]; });
    return {
      requests: requests, status_codes: codes, status_classes: classes,
      client_error_rate: requests ? classes['4xx'] / requests : 0,
      server_error_rate: requests ? classes['5xx'] / requests : 0,
      p50_ms: percentile(buckets, 0.5), p95_ms: percentile(buckets, 0.95)
    };
  }

  function serverErrors(row) {
    return Object.keys(row.status_codes).reduce(function (a, code) {
      return a + (code.charAt(0) === '5' ? row.status_codes[code] : 0);
    }, 0);
  }

  /* The day whose 5xx share stands out, with the route that caused most of it. */
  function findIncident(daily, rows) {
    if (daily.length < 3) return null;
    var rates = daily.map(function (d) { return d.server_error_rate; });
    var sortedRates = rates.slice().sort(function (a, b) { return a - b; });
    var median = sortedRates[Math.floor(sortedRates.length / 2)];
    var peak = rates.indexOf(Math.max.apply(null, rates));
    if (!(rates[peak] > median * 3)) return null;
    var worst = null;
    rows.forEach(function (row) {
      if (row.day !== daily[peak].day) return;
      var errors = serverErrors(row);
      if (!worst || errors > worst.errors) worst = { errors: errors, name: (row.method ? row.method + ' ' : '') + row.route };
    });
    return { at: peak, day: daily[peak].day, rate: rates[peak], route: worst ? worst.name : null };
  }

  function api(projectId, rangeDays, service) {
    var all = (apiDaily[projectId] || []).filter(function (row) { return !service || row.service === service; });
    var firstDay = days[DAY_COUNT - rangeDays];
    var priorFirstDay = days[DAY_COUNT - 2 * rangeDays];
    var rows = all.filter(function (row) { return row.day >= firstDay; });
    var prior = priorFirstDay ? all.filter(function (row) { return row.day >= priorFirstDay && row.day < firstDay; }) : [];
    var byDay = {};
    var byRoute = {};
    rows.forEach(function (row) {
      (byDay[row.day] = byDay[row.day] || []).push(row);
      var key = row.service + ' ' + row.method + ' ' + row.route;
      (byRoute[key] = byRoute[key] || []).push(row);
    });
    var daily = Object.keys(byDay).sort().map(function (day) {
      return Object.assign({ day: day }, apiTotals(byDay[day]));
    });
    return {
      totals: apiTotals(rows),
      prior: prior.length ? apiTotals(prior) : null,
      daily: daily,
      routes: Object.keys(byRoute).map(function (key) {
        var first = byRoute[key][0];
        return Object.assign({ service: first.service, method: first.method, route: first.route, kind: first.kind }, apiTotals(byRoute[key]));
      }).sort(function (a, b) { return (a.kind !== 'route') - (b.kind !== 'route') || b.requests - a.requests; }),
      incident: findIncident(daily, rows),
      series: {
        seen_30d: seriesSeen30d[projectId] || null,
        cap: metaValues.series_cap, window_days: metaValues.series_cap_days
      }
    };
  }

  function findProject(idOrSlug) {
    return projectRows.filter(function (p) { return p.id === idOrSlug || p.slug === idOrSlug; })[0] || null;
  }

  function tenantToken(projectId) {
    var token = ingestTokens[projectId];
    if (!token) return null;
    var rows = apiDaily[projectId] || [];
    var last = rows.length ? rows[rows.length - 1] : null;
    var expiresAt = addMonths(token.issued_at, metaValues.token_lifetime_months);
    return {
      masked: 'ust_live_••••••••••••••••••••' + token.suffix,
      issued_at: token.issued_at, expires_at: expiresAt, expired: expiresAt <= LAST_DAY,
      lifetime_months: metaValues.token_lifetime_months,
      last_export_day: last ? last.day : null, last_export_service: last ? last.service : null
    };
  }

  /* ---------- operator view: aggregates, small counts rounded ---------- */

  function roundSmall(count) {
    if (count >= metaValues.small_count_below) return count;
    return Math.round(count / metaValues.small_count_step) * metaValues.small_count_step;
  }
  function roundCounts(map) {
    var out = {};
    Object.keys(map).forEach(function (key) { out[key] = roundSmall(map[key]); });
    return out;
  }
  function roundedWeb(totals) {
    if (!totals) return null;
    var out = Object.assign({}, totals);
    ['pageviews_raw', 'pageviews_flagged', 'pageviews_filtered', 'visitors_raw', 'visitors_flagged',
      'visitors_filtered', 'visits', 'bounces'].forEach(function (key) { out[key] = roundSmall(totals[key]); });
    out.flagged_by_rule = roundCounts(totals.flagged_by_rule);
    return out;
  }
  function roundedApi(totals) {
    if (!totals) return null;
    return Object.assign({}, totals, {
      requests: roundSmall(totals.requests),
      status_codes: roundCounts(totals.status_codes),
      status_classes: roundCounts(totals.status_classes)
    });
  }

  function operatorRows(rangeDays) {
    return projectRows.map(function (project) {
      var webResult = web(project.id, rangeDays);
      var totals = webResult.totals;
      var dimension = function (name, total) {
        return breakdown(project.id, name, total).map(function (row) {
          return { label: row.label, value: roundSmall(row.value) };
        });
      };
      var apiResult = api(project.id, rangeDays);
      return {
        project: project,
        web: roundedWeb(totals),
        web_prior: roundedWeb(webResult.prior),
        api: roundedApi(apiResult.totals),
        api_prior: roundedApi(apiResult.prior),
        api_daily: apiResult.daily.map(function (row) {
          return { day: row.day, requests: roundSmall(row.requests) };
        }),
        token: tenantToken(project.id),
        breakdowns: {
          referrers: totals ? dimension('referrers', totals.visits) : [],
          countries: totals ? dimension('countries', totals.visitors_filtered) : [],
          devices: totals ? dimension('devices', totals.visitors_filtered) : [],
          browsers: totals ? dimension('browsers', totals.visitors_filtered) : []
        },
        daily: webResult.rows.map(function (row) {
          return {
            day: row.day,
            pageviews_filtered: roundSmall(row.pageviews_raw - row.pageviews_flagged),
            pageviews_flagged: roundSmall(row.pageviews_flagged)
          };
        })
      };
    });
  }

  /* ---------- consistency checks ---------- */

  projectRows.forEach(function (p) {
    webDaily[p.id].forEach(function (row) {
      var ruleSum = Object.keys(row.flagged_by_rule).reduce(function (a, k) { return a + row.flagged_by_rule[k]; }, 0);
      console.assert(ruleSum === row.pageviews_flagged, 'flag rules must add up to flagged page views', p.id, row.day);
      console.assert(row.bounces <= row.visits, 'bounces cannot exceed visits', p.id, row.day);
    });
    apiDaily[p.id].forEach(function (row) {
      var codeSum = Object.keys(row.status_codes).reduce(function (a, k) { return a + row.status_codes[k]; }, 0);
      var bucketSum = row.latency_buckets.reduce(function (a, b) { return a + b; }, 0);
      console.assert(codeSum === row.requests, 'status codes must add up to requests', p.id, row.day, row.route);
      console.assert(bucketSum === row.requests, 'latency buckets must add up to requests', p.id, row.day, row.route);
    });
    console.assert(p.fictional === /\.example$/.test(p.domain), 'only fictional projects use an .example domain', p.id);
  });

  /* ---------- live web figures: see the header ---------- */

  var live = { on: false, error: null, through: null, projects: [], web: {}, latest: {} };
  var BROWSER_NAMES = {
    ios: 'Safari (iOS)', crios: 'Chrome (iOS)', fxios: 'Firefox (iOS)', 'edge-chromium': 'Edge',
    'chromium-webview': 'Android WebView', 'ios-webview': 'iOS WebView', samsung: 'Samsung Internet'
  };

  function getJson(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || 'The server answered ' + response.status + '.');
        return body;
      });
    });
  }

  function liveProject(row) {
    return {
      id: row.id, slug: row.id, name: row.name, fictional: false, domain: row.domain, account: null,
      state: row.state, enrolled_at: null, notification_channel: null,
      sites: [site(row.id, row.domain, null, null, null)],
      evidence: [], dpa_accepted_at: null, services: [], api_flags: []
    };
  }

  function connect() {
    live.on = true;
    return getJson('/api/sites').then(function (body) {
      live.projects = body.sites.map(liveProject);
    }, function (error) {
      live.error = error.message || 'The list of projects could not be read.';
    });
  }

  function loadWeb(projectId, rangeDays) {
    return getJson('/api/web?site=' + encodeURIComponent(projectId) + '&days=' + rangeDays).then(function (body) {
      live.web[projectId + '/' + rangeDays] = body;
      live.latest[projectId] = body;
      live.through = body.through;
    });
  }

  function liveTotals(t) {
    if (!t || !t.pageviews) return null;
    return {
      pageviews_raw: t.pageviews, pageviews_flagged: null, pageviews_filtered: null,
      visitors_raw: t.visitors, visitors_flagged: null, visitors_filtered: null,
      visits: t.visits, bounces: t.bounces,
      bounce_rate: t.visits ? t.bounces / t.visits : 0,
      avg_visit_seconds: t.visits ? t.total_seconds / t.visits : 0,
      flagged_share: null, flagged_by_rule: null, top_rule: null, classified: false
    };
  }

  function liveWeb(projectId, rangeDays) {
    var body = live.web[projectId + '/' + rangeDays];
    if (!body) return { rows: [], totals: null, prior: null };
    return {
      rows: body.daily.map(function (d) {
        return { day: d.day, pageviews_raw: d.pageviews, pageviews_flagged: null, visitors_raw: d.visitors,
          visitors_flagged: null, visits: null, bounces: null, visit_seconds: null, flagged_by_rule: null };
      }),
      totals: liveTotals(body.totals),
      prior: liveTotals(body.prior)
    };
  }

  function liveLabel(dimension, label) {
    if (dimension === 'countries') {
      try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(label) || label; } catch (error) { return label; }
    }
    if (dimension === 'referrers') return label;
    return BROWSER_NAMES[label] || label.charAt(0).toUpperCase() + label.slice(1);
  }

  function liveBreakdown(projectId, dimension) {
    var body = live.latest[projectId];
    return ((body && body.breakdowns[dimension]) || []).map(function (row) {
      return { label: liveLabel(dimension, row.label), value: row.value };
    });
  }

  function liveMeta() {
    var first = live.projects.filter(function (p) { return p.state === 'active'; })[0] || live.projects[0];
    var copy = {};
    Object.keys(metaValues).forEach(function (key) { copy[key] = metaValues[key]; });
    copy.default_project_id = first ? first.id : null;
    return copy;
  }

  function liveFind(idOrSlug) {
    return live.projects.filter(function (p) { return p.id === idOrSlug; })[0] || null;
  }

  window.LData = {
    connect: connect,
    loadWeb: loadWeb,
    status: function () { return { live: live.on, error: live.error, through: live.through }; },
    meta: function () { return live.on ? liveMeta() : metaValues; },
    flagRules: function () { return webFlagRules; },
    apiFlagRules: function () { return apiFlagRuleLabels; },
    projects: function () { return live.on ? live.projects.slice() : projectRows.slice(); },
    project: function (idOrSlug) { return live.on ? liveFind(idOrSlug) : findProject(idOrSlug); },
    web: function (projectId, rangeDays) { return live.on ? liveWeb(projectId, rangeDays) : web(projectId, rangeDays); },
    breakdown: function (projectId, dimension, total) {
      return live.on ? liveBreakdown(projectId, dimension) : breakdown(projectId, dimension, total);
    },
    api: api,
    tenantToken: tenantToken,
    operatorRows: operatorRows,
    rangeDays: function (rangeDays) { return days.slice(-rangeDays); },
    metricsApiKeys: function () { return apiKeyRows.slice(); }
  };
})();
