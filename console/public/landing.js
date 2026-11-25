/* Start page: a role picker over a preview of each console, all read from the operator endpoint. */
(function () {
  'use strict';

  var D = window.LData;
  var RANGE_DAYS = 30;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var state = { role: 'tenant', slug: null, rows: [] };

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function below() { return D.meta().small_counts.below; }
  function isSmall(value) { return Boolean(value && value.small); }
  function drawn(value) { return typeof value === 'number' ? value : 0; }

  function count(value) {
    if (isSmall(value)) {
      return '<span class="small" title="More than zero and fewer than ' + value.below + '. The exact number is not shown.">&lt;' + value.below + '</span>';
    }
    return Math.round(value).toLocaleString('en-US');
  }

  function rate(value, format) {
    if (value === null || value === undefined) return '–';
    if (isSmall(value)) return '<span class="small" title="Not shown for fewer than ' + value.below + ' visits">Too few visits</span>';
    return format(value);
  }

  function pct(value) { return (value * 100).toFixed(1) + '%'; }
  function duration(seconds) {
    var s = Math.round(seconds);
    return Math.floor(s / 60) + ' m ' + String(s % 60).padStart(2, '0') + ' s';
  }
  function day(iso) { return Number(iso.slice(8)) + ' ' + MONTHS[Number(iso.slice(5, 7)) - 1]; }

  function bars(values, options) {
    var width = 1000;
    var height = options.height;
    var max = Math.max.apply(null, values.concat(1)) * 1.08;
    var step = width / values.length;
    var gap = step * options.gap;
    var last = values.length - 1;
    var rects = values.map(function (value, index) {
      var h = (value / max) * height;
      return '<rect x="' + (index * step + gap / 2).toFixed(2) + '" y="' + (height - h).toFixed(2) + '" width="' + (step - gap).toFixed(2) +
        '" height="' + h.toFixed(2) + '" fill="' + (index === last ? options.today : options.fill) + '"/>';
    }).join('');
    return '<svg viewBox="0 0 ' + width + ' ' + (height + 1) + '" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true">' + rects +
      '<line x1="0" x2="' + width + '" y1="' + height + '" y2="' + height + '" stroke="' + options.baseline + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>';
  }

  function consoleUrl(project) { return '/' + encodeURIComponent(project.slug) + '/web'; }
  function siteUrl(project) { return 'https://' + project.domain + '/demo/'; }

  function current() {
    return state.rows.filter(function (row) { return row.project.slug === state.slug; })[0] || state.rows[0];
  }

  /* "Demo site A", "Demo site B" split into the shared words "Demo site" and the tabs "A", "B". */
  function splitNames(rows) {
    var names = rows.map(function (row) { return row.project.name; });
    var shared = names.reduce(function (prefix, name) {
      while (name.indexOf(prefix) !== 0) prefix = prefix.slice(0, -1);
      return prefix;
    });
    var cut = names.length > 1 ? shared.lastIndexOf(' ') + 1 : 0;
    var labels = names.map(function (name) { return name.slice(cut) || name; });
    return { shared: names[0].slice(0, cut).trim(), labels: labels };
  }

  function head(title, note, action) {
    return '<div class="preview-head"><div><div class="preview-title">' + title + '</div><p class="preview-note">' + note + '</p></div>' + (action || '') + '</div>';
  }

  function figure(label, value, note) {
    return '<div><p class="figure-label">' + label + '<button class="info" type="button" aria-label="' + label + ': ' + note + '" data-tip="' + note +
      '">i</button></p><p class="figure-value">' + value + '</p></div>';
  }

  function ranked(list) {
    if (!list.length) return '<p class="status">No visits from another site yet.</p>';
    var most = Math.max.apply(null, list.map(function (entry) { return drawn(entry.value); }).concat(1));
    return '<ul class="ranked">' + list.map(function (entry) {
      return '<li><span>' + escapeHtml(entry.label) + '</span><b>' + count(entry.value) + '</b><div class="meter"><span style="width:' +
        (drawn(entry.value) / most * 100).toFixed(1) + '%"></span></div></li>';
    }).join('') + '</ul>';
  }

  function axis(daily) {
    var ticks = [0, 7, 14, 21].filter(function (index) { return index < daily.length - 1; });
    return ticks.map(function (index) { return '<span>' + day(daily[index].day) + '</span>'; }).join('') + '<span>Today so far</span>';
  }

  function tenantPreview() {
    var row = current();
    var project = row.project;
    var totals = row.totals;
    var names = splitNames(state.rows);
    var picker = state.rows.length > 1 ? '<div class="switch" role="group" aria-label="Project">' + state.rows.map(function (other, index) {
      return '<button type="button" data-slug="' + escapeHtml(other.project.slug) + '" aria-label="' + escapeHtml(other.project.name) + '" aria-pressed="' +
        (other === row) + '">' + escapeHtml(names.labels[index]) + '</button>';
    }).join('') + '</div>' : '';
    var smallDay = row.daily.some(function (entry) { return isSmall(entry.pageviews); });
    return head('<h2>' + escapeHtml(names.shared || project.name) + '</h2>' + picker, 'Last ' + RANGE_DAYS + ' days',
      '<a class="button button-ink" href="' + consoleUrl(project) + '" target="_blank" rel="noopener">View the console</a>') +
      '<div class="figures">' +
        figure('Page views', count(totals.pageviews), 'Every page load the tracker saw') +
        figure('Visitors', count(totals.visitors), 'Each person counts once a day') +
        figure('Visit duration', rate(totals.avg_visit_seconds, duration), 'Average') +
        figure('Bounce rate', rate(totals.bounce_rate, pct), 'Visits with one page view') +
      '</div><div class="split"><div><h3 class="block-title">Page views per day</h3><div class="chart">' +
        bars(row.daily.map(function (entry) { return drawn(entry.pageviews); }), { height: 200, gap: 0.26, fill: '#474d8c', today: '#b9bcdb', baseline: '#cfcde0' }) +
        '</div><div class="axis">' + axis(row.daily) + '</div>' +
        (smallDay ? '<p class="figure-note">Days with fewer than ' + below() + ' page views are not shown.</p>' : '') +
      '</div><div><h3 class="block-title">Where visitors came from</h3>' + ranked(row.breakdowns.referrers.slice(0, 5)) + '</div></div>';
  }

  function operatorPreview() {
    var rows = D.sortRows(state.rows, function (row) { return row.totals.pageviews; }, true);
    return head('<h2>All projects</h2>', rows.length + ' projects, last ' + RANGE_DAYS + ' days',
      '<a class="button button-ink" href="/operator/projects" target="_blank" rel="noopener">View the console</a>') +
      '<div class="table-wrap"><table><thead><tr><th>Project</th><th class="num">Page views</th><th class="num">Visitors</th><th class="num">Visits</th>' +
      '<th class="num">Bounce rate</th><th class="num">Visit duration</th></tr></thead><tbody>' + rows.map(function (row) {
        var t = row.totals;
        return '<tr><td class="name"><b>' + escapeHtml(row.project.name) + '</b><span>' + escapeHtml(row.project.domain) + '</span></td>' +
          '<td class="num">' + count(t.pageviews) + '</td><td class="num">' + count(t.visitors) + '</td><td class="num">' + count(t.visits) + '</td>' +
          '<td class="num">' + rate(t.bounce_rate, pct) + '</td><td class="num">' + rate(t.avg_visit_seconds, duration) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function publicPreview() {
    var rows = D.sortRows(state.rows, function (row) { return row.totals.visitors; }, true);
    return head('<h2>Totals per project</h2>', 'What anyone can see, last ' + RANGE_DAYS + ' days') +
      '<div class="table-wrap"><table><thead><tr><th class="rank">#</th><th>Project</th><th class="num">Visitors</th><th class="num">Page views</th></tr></thead><tbody>' +
      rows.map(function (row, index) {
        return '<tr><td class="rank">' + (index + 1) + '</td><td class="name"><b>' + escapeHtml(row.project.name) + '</b><span>' + escapeHtml(row.project.domain) + '</span></td>' +
          '<td class="num">' + count(row.totals.visitors) + '</td><td class="num">' + count(row.totals.pageviews) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function render() {
    var preview = byId('preview');
    preview.setAttribute('aria-labelledby', 'role-' + state.role);
    if (!state.rows.length) {
      preview.innerHTML = '<p class="status">No project is enrolled yet.</p>';
      return;
    }
    preview.innerHTML = state.role === 'operator' ? operatorPreview() : state.role === 'public' ? publicPreview() : tenantPreview();
    var project = current().project;
    byId('visit-name').textContent = project.name;
    byId('visit-link').textContent = 'Open ' + project.name;
    byId('visit-link').href = siteUrl(project);
    byId('visit-text-link').href = siteUrl(project);
    byId('visit').hidden = false;
  }

  function selectRole(tab) {
    var tabs = document.querySelectorAll('.role');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('aria-selected', String(tabs[i] === tab));
      tabs[i].tabIndex = tabs[i] === tab ? 0 : -1;
    }
    state.role = tab.dataset.role;
    if (state.rows.length) render();
  }

  document.querySelector('.roles').addEventListener('click', function (event) {
    var tab = event.target.closest('.role');
    if (tab) selectRole(tab);
  });

  document.querySelector('.roles').addEventListener('keydown', function (event) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.role'));
    var next = tabs[(tabs.indexOf(document.activeElement) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    selectRole(next);
  });

  byId('preview').addEventListener('click', function (event) {
    var button = event.target.closest('[data-slug]');
    if (!button) return;
    state.slug = button.dataset.slug;
    render();
    byId('preview').querySelector('[data-slug="' + state.slug + '"]').focus();
  });

  var dialog = byId('video-dialog');
  var player = dialog.querySelector('iframe');

  document.querySelector('.video').addEventListener('click', function (event) {
    if (typeof dialog.showModal !== 'function') return;
    event.preventDefault();
    player.src = player.dataset.src;
    dialog.showModal();
  });

  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) dialog.close();
  });

  // Unloading the player is what stops the sound.
  dialog.addEventListener('close', function () { player.removeAttribute('src'); });

  D.loadOperator(RANGE_DAYS).then(function () {
    state.rows = D.operatorRows();
    render();
  }, function (error) {
    byId('preview').innerHTML = '<p class="status">The figures could not be read: ' + escapeHtml(error.message) +
      ' The <a href="/operator/projects">operator console</a> may say more.</p>';
  });
})();
