/* Start page: a role picker over a preview of each view, each read from the operator or public endpoint when first shown. */
(function () {
  'use strict';

  var D = window.LData;
  var RANGE_DAYS = 30;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var state = { role: 'tenant', slug: null, rows: [], visited: {} };
  var views = {};

  function byId(id) { return document.getElementById(id); }

  var LOADING = byId('preview').innerHTML;

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

  function bars(values) {
    var width = 1000;
    var height = 200;
    var max = Math.max.apply(null, values.concat(1)) * 1.08;
    var step = width / values.length;
    var gap = step * 0.26;
    var last = values.length - 1;
    var rects = values.map(function (value, index) {
      var h = (value / max) * height;
      return '<rect x="' + (index * step + gap / 2).toFixed(2) + '" y="' + (height - h).toFixed(2) + '" width="' + (step - gap).toFixed(2) +
        '" height="' + h.toFixed(2) + '"' + (index === last ? ' class="today"' : '') + '/>';
    }).join('');
    return '<svg viewBox="0 0 ' + width + ' ' + (height + 1) + '" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true">' + rects +
      '<line x1="0" x2="' + width + '" y1="' + height + '" y2="' + height + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>';
  }

  function consoleUrl(project) { return '/' + encodeURIComponent(project.slug) + '/web'; }
  function siteUrl(project) { return '//' + project.domain + '/demo/'; }

  /* Only an active project serves its demo site, so only active ones are offered while any exist. */
  function tenantRows() {
    var active = state.rows.filter(function (row) { return row.project.state === 'active'; });
    return active.length ? active : state.rows;
  }

  function current() {
    return state.rows.filter(function (row) { return row.project.slug === state.slug; })[0] || tenantRows()[0];
  }

  var DEMO_PREFIX = 'Demo site ';
  var EXTERNAL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>';
  var REFRESH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';

  function optionLabel(name) {
    return name.indexOf(DEMO_PREFIX) === 0 ? name.slice(DEMO_PREFIX.length) : name;
  }

  function tenantActions(project) {
    var openConsole = '<a class="button button-line" href="' + consoleUrl(project) + '" target="_blank" rel="noopener">Open console</a>';
    if (project.state !== 'active') return openConsole;
    return '<div class="head-actions">' + openConsole + '<div class="visit-split"><a id="visit-site" href="' + escapeHtml(siteUrl(project)) + '" target="_blank" rel="noopener">View site' +
      EXTERNAL_ICON + '</a><button id="refresh" type="button" aria-label="Refresh the figures" title="Refresh the figures"' +
      (state.visited[project.slug] ? '' : ' disabled') + '>' + REFRESH_ICON + '</button></div>' +
      '<p class="visit-note">Viewing the site counts a page view. Refresh to see it.</p></div>';
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
    var rows = tenantRows();
    var picker = rows.length > 1 ? '<div class="project-menu"><button class="project-button" id="project-button" type="button" ' +
      'aria-expanded="false" aria-controls="project-list" aria-label="Project: ' + escapeHtml(project.name) + '">' + escapeHtml(optionLabel(project.name)) +
      '</button><ul class="project-list" id="project-list" hidden>' + rows.map(function (other) {
        return '<li><button type="button" data-slug="' + escapeHtml(other.project.slug) + '" aria-label="' + escapeHtml(other.project.name) + '"' +
          (other === row ? ' aria-current="true"' : '') + '>' + escapeHtml(optionLabel(other.project.name)) + '</button></li>';
      }).join('') + '</ul></div>' : '';
    var smallDay = row.daily.some(function (entry) { return isSmall(entry.pageviews); });
    return head('<h2>Stats for site</h2>' + picker, 'Last ' + RANGE_DAYS + ' days', tenantActions(project)) +
      '<div class="figures">' +
        figure('Page views', count(totals.pageviews), 'Flagged traffic left out') +
        figure('Visitors', count(totals.visitors), 'Each person counts once a day') +
        figure('Visit duration', rate(totals.avg_visit_seconds, duration), 'Average') +
        figure('Bounce rate', rate(totals.bounce_rate, pct), 'Visits with one page view') +
      '</div><div class="split"><div><h3 class="block-title">Page views per day</h3><div class="chart">' +
        bars(row.daily.map(function (entry) { return drawn(entry.pageviews); })) +
        '</div><div class="axis">' + axis(row.daily) + '</div>' +
        (smallDay ? '<p class="figure-note">Days with fewer than ' + below() + ' page views are not shown.</p>' : '') +
      '</div><div><h3 class="block-title">Where visitors came from</h3>' + ranked(row.breakdowns.referrers.slice(0, 5)) + '</div></div>';
  }

  function operatorPreview() {
    var rows = D.sortRows(state.rows, function (row) { return row.totals.pageviews; }, true);
    return head('<h2>All projects</h2>', rows.length + ' projects, last ' + RANGE_DAYS + ' days',
      '<a class="button button-line" href="/operator/projects" target="_blank" rel="noopener">Open console</a>') +
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
    return head('<h2>Totals per project</h2>', 'What anyone can see, last ' + RANGE_DAYS + ' days',
      '<a class="button button-line" href="/public" target="_blank" rel="noopener">Open public page</a>') +
      '<div class="table-wrap"><table><thead><tr><th class="rank">#</th><th>Project</th><th class="num">Visitors</th><th class="num">Page views</th></tr></thead><tbody>' +
      rows.map(function (row, index) {
        return '<tr><td class="rank">' + (index + 1) + '</td><td class="name"><b>' + escapeHtml(row.project.name) + '</b></td>' +
          '<td class="num">' + count(row.totals.visitors) + '</td><td class="num">' + count(row.totals.pageviews) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function render() {
    var preview = byId('preview');
    if (!state.rows.length) {
      preview.innerHTML = '<p class="status">' + (state.role === 'public' ? 'No project is active yet.' : 'No project is enrolled yet.') + '</p>';
      return;
    }
    preview.innerHTML = state.role === 'operator' ? operatorPreview() : state.role === 'public' ? publicPreview() : tenantPreview();
  }

  function viewQuery() {
    return state.role === 'tenant' ? { figures: 'one', project: state.slug } : { figures: 'totals' };
  }

  function viewKey() {
    if (state.role === 'public') return 'public';
    var query = viewQuery();
    return query.figures + ':' + (query.project || '');
  }

  function readView() {
    return state.role === 'public' ? D.loadPublic(RANGE_DAYS) : D.loadOperator(RANGE_DAYS, viewQuery());
  }

  function show() {
    var key = viewKey();
    var preview = byId('preview');
    preview.setAttribute('aria-labelledby', 'role-' + state.role);
    preview.innerHTML = LOADING;
    if (!views[key]) {
      views[key] = readView();
      views[key].catch(function () { delete views[key]; });
    }
    return views[key].then(function (rows) {
      if (key !== viewKey()) return false;
      var read = rows.filter(function (row) { return row.totals; })[0];
      if (state.role === 'tenant' && read) {
        state.slug = read.project.slug;
        views[viewKey()] = views[key];
      }
      state.rows = rows;
      render();
      return true;
    }, function (error) {
      if (key !== viewKey()) return false;
      if (state.role === 'tenant') state.slug = null;
      preview.innerHTML = '<p class="status">The figures could not be read: ' + escapeHtml(error.message) +
        (state.role === 'public' ? '' : ' The <a href="/operator/projects">operator console</a> may say more.') + '</p>';
      return false;
    });
  }

  function selectRole(tab) {
    var tabs = document.querySelectorAll('.role');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('aria-selected', String(tabs[i] === tab));
      tabs[i].tabIndex = tabs[i] === tab ? 0 : -1;
    }
    state.role = tab.dataset.role;
    byId('role-select').value = state.role;
    show();
  }

  byId('role-select').addEventListener('change', function (event) {
    selectRole(byId('role-' + event.target.value));
  });

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

  function toggleProjects(open) {
    var button = byId('project-button');
    if (!button) return;
    button.setAttribute('aria-expanded', String(open));
    byId('project-list').hidden = !open;
  }

  byId('preview').addEventListener('click', function (event) {
    if (event.target.closest('#project-button')) {
      toggleProjects(byId('project-list').hidden);
      return;
    }
    if (event.target.closest('#visit-site')) {
      state.visited[current().project.slug] = true;
      byId('refresh').disabled = false;
      return;
    }
    if (event.target.closest('#refresh')) {
      delete state.visited[current().project.slug];
      views = {};
      show().then(function (shown) {
        if (shown) byId('visit-site').focus();
      });
      return;
    }
    var choice = event.target.closest('[data-slug]');
    if (!choice) return;
    state.slug = choice.dataset.slug;
    show().then(function (shown) {
      if (shown) byId('project-button').focus();
    });
  });

  document.addEventListener('click', function (event) {
    if (!event.target.closest('.project-menu')) toggleProjects(false);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !byId('project-list') || byId('project-list').hidden) return;
    toggleProjects(false);
    byId('project-button').focus();
  });

  var dialog = byId('video-dialog');
  var player = dialog.querySelector('iframe');

  document.querySelector('.video').addEventListener('click', function (event) {
    if (typeof dialog.showModal !== 'function' || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    player.src = player.dataset.src;
    dialog.showModal();
  });

  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) dialog.close();
  });

  // Unloading the player is what stops the sound.
  dialog.addEventListener('close', function () { player.removeAttribute('src'); });

  show();
})();
