/* Inline SVG charts for the mockups. No dependencies.
   Colours come from CSS custom properties, so the palette lives in styles.css.
   Marks are square, like every other shape of the brand. */

var NS = 'http://www.w3.org/2000/svg'
var renderers = []
var patternCount = 0
var tip

function node(tag, attrs, parent) {
  var n = document.createElementNS(NS, tag)
  Object.keys(attrs || {}).forEach((k) => {
    n.setAttribute(k, attrs[k])
  })
  if (parent) parent.appendChild(n)
  return n
}
function label(parent, text, attrs) {
  var t = node('text', attrs, parent)
  t.textContent = text
  return t
}
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

/* Round steps; the top tick always sits above the largest value. */
function ticks(max, count) {
  if (!(max > 0)) return [0, 1]
  var raw = max / (count || 4)
  var magnitude = 10 ** Math.floor(Math.log10(raw))
  var step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).filter((s) => s >= raw)[0]
  var out = []
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(+v.toFixed(6))
  return out
}

function pickLabels(count, width) {
  var cap = Math.max(2, Math.min(9, Math.floor(width / 96)))
  if (count <= cap) return range(count)
  var step = Math.ceil(count / cap)
  var out = []
  for (let i = count - 1; i >= 0; i -= step) out.unshift(i)
  return out
}
function range(n) {
  var a = []
  for (let i = 0; i < n; i++) a.push(i)
  return a
}

/* The tip is a manual popover so it also sits above a modal drawer. */
function showTip(event, html) {
  if (!tip) {
    tip = document.createElement('div')
    tip.className = 'chart-tip'
    if (tip.showPopover) tip.setAttribute('popover', 'manual')
    document.body.appendChild(tip)
  }
  tip.innerHTML = html
  if (tip.showPopover) {
    if (!tip.matches(':popover-open')) tip.showPopover()
  } else tip.hidden = false
  var box = tip.getBoundingClientRect()
  var x = event.clientX + 14
  if (x + box.width > window.innerWidth - 8) x = event.clientX - box.width - 14
  tip.style.left = x + 'px'
  tip.style.top = Math.max(8, event.clientY - box.height - 10) + 'px'
}
function hideTip() {
  if (!tip) return
  if (tip.hidePopover) {
    if (tip.matches(':popover-open')) tip.hidePopover()
  } else tip.hidden = true
}

function tipRows(title, rows) {
  return (
    '<div class="chart-tip-title">' +
    escapeHtml(title) +
    '</div>' +
    rows
      .map(
        (r) =>
          '<div class="chart-tip-row">' +
          (r.swatch || '<span></span>') +
          '<span>' +
          escapeHtml(r.name) +
          '</span><b>' +
          escapeHtml(r.value) +
          '</b></div>',
      )
      .join('')
  )
}

function hatch(svg, color) {
  var id = 'hatch-' + ++patternCount
  var defs = node('defs', {}, svg)
  var p = node(
    'pattern',
    { id: id, width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    defs,
  )
  node('rect', { width: 5, height: 5, style: 'fill:var(--gold-tint)' }, p)
  node('rect', { width: 2.5, height: 5, style: 'fill:' + color }, p)
  return 'url(#' + id + ')'
}

/* The legend swatch is the mark itself, scaled down. */
function swatch(series) {
  if (series.line) {
    return (
      '<svg class="swatch" width="14" height="10" aria-hidden="true"><line x1="0" y1="5" x2="14" y2="5" style="stroke:' +
      series.color +
      ';stroke-width:2"' +
      (series.dash ? ' stroke-dasharray="4 3"' : '') +
      '/></svg>'
    )
  }
  if (series.hatch) {
    const id = 'sw-' + ++patternCount
    return (
      '<svg class="swatch" width="10" height="10" aria-hidden="true"><defs><pattern id="' +
      id +
      '" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" style="fill:var(--gold-tint)"/>' +
      '<rect width="2.5" height="5" style="fill:' +
      series.color +
      '"/></pattern></defs><rect width="10" height="10" fill="url(#' +
      id +
      ')"/></svg>'
    )
  }
  return (
    '<svg class="swatch" width="10" height="10" aria-hidden="true"><rect width="10" height="10" style="fill:' +
    series.color +
    '"/></svg>'
  )
}

function legend(series) {
  return series
    .map((s) => '<span class="legend-item">' + swatch(s) + escapeHtml(s.name) + '</span>')
    .join('')
}

function frame(el, config, draw) {
  function render() {
    var width = Math.max(140, Math.floor(el.clientWidth))
    var height = config.height || 240
    el.innerHTML = ''
    if (!config.labels.length) {
      const note = document.createElement('p')
      note.className = 'empty chart-empty'
      note.style.height = height + 'px'
      note.textContent = config.emptyText || 'No data in this period.'
      el.appendChild(note)
      return
    }
    var svg = node(
      'svg',
      {
        width: width,
        height: height,
        viewBox: '0 0 ' + width + ' ' + height,
        role: 'img',
        'aria-label': config.label || 'Chart',
      },
      el,
    )
    draw(svg, width, height)
  }
  el.chartRender = render
  if (renderers.indexOf(el) < 0) renderers.push(el)
  render()
}

function axes(svg, box, yTicks, labels, format, slotCenter) {
  var top = yTicks[yTicks.length - 1]
  yTicks.forEach((value, index) => {
    var y = box.bottom - (value / top) * (box.bottom - box.top)
    node(
      'line',
      {
        x1: box.left,
        x2: box.right,
        y1: y,
        y2: y,
        class: index === 0 ? 'chart-baseline' : 'chart-grid',
      },
      svg,
    )
    label(svg, format(value), {
      x: box.left - 8,
      y: y + 4,
      'text-anchor': 'end',
      class: 'chart-tick',
    })
  })
  pickLabels(labels.length, box.right - box.left).forEach((index) => {
    var x = slotCenter(index)
    var nearEnd = x > box.right - 24
    label(svg, labels[index], {
      x: nearEnd ? box.right : x,
      y: box.bottom + 18,
      'text-anchor': nearEnd ? 'end' : 'middle',
      class: 'chart-tick',
    })
  })
  return (value) => box.bottom - (value / top) * (box.bottom - box.top)
}

/* Stacked columns: one question (how much per day), the flagged band on top. */
function columns(el, config) {
  frame(el, config, (svg, width, height) => {
    var annotations = config.annotations || []
    var box = { left: 52, right: width - 8, top: annotations.length ? 30 : 10, bottom: height - 28 }
    var count = config.labels.length
    var slot = (box.right - box.left) / count
    var barWidth = Math.max(2, Math.min(22, Math.floor(slot * 0.64)))
    /* A null value is unknown, not zero: it is not drawn, and its day has no total. */
    var drawnHeights = config.labels.map((_, i) =>
      config.series.reduce((acc, s) => acc + (s.values[i] || 0), 0),
    )
    var totals = config.labels.map((_, i) =>
      config.series.some((s) => s.values[i] === null) ? null : drawnHeights[i],
    )
    var fixedMax = config.max || Math.max.apply(null, drawnHeights)
    var center = (i) => box.left + slot * (i + 0.5)
    var y = axes(
      svg,
      box,
      ticks(fixedMax, 4),
      config.labels,
      config.tickFormat || config.format,
      center,
    )
    var fills = config.series.map((s) => (s.hatch ? hatch(svg, s.color) : null))
    var seam = barWidth >= 6 ? 2 : 1
    var bands = []

    /* Days with no export are drawn as a gap, so a missing bar is not read as zero. */
    if (config.gap) {
      const gapLeft = box.left + slot * config.gap.from
      node(
        'rect',
        {
          x: gapLeft,
          y: box.top,
          width: slot * (config.gap.to - config.gap.from + 1),
          height: box.bottom - box.top,
          class: 'chart-gap',
        },
        svg,
      )
      const gapEnd = gapLeft > width - 260
      label(svg, config.gap.label, {
        x: gapEnd ? box.right - 8 : gapLeft + 8,
        y: box.top + 18,
        'text-anchor': gapEnd ? 'end' : 'start',
        class: 'chart-note',
      })
    }

    config.labels.forEach((_, i) => {
      var x = Math.round(center(i) - barWidth / 2)
      var base = 0
      bands.push(
        node(
          'rect',
          {
            x: box.left + slot * i,
            y: box.top,
            width: slot,
            height: box.bottom - box.top,
            class: 'chart-band',
          },
          svg,
        ),
      )
      config.series.forEach((s, index) => {
        var value = s.values[i]
        if (!value) return
        var yTop = y(base + value)
        var yBottom = y(base) - (index > 0 ? seam : 0)
        base += value
        if (yBottom - yTop < 1) return
        var bar = node('rect', { x: x, y: yTop, width: barWidth, height: yBottom - yTop }, svg)
        if (fills[index]) bar.setAttribute('fill', fills[index])
        else bar.style.fill = s.color
      })
    })

    annotations.forEach((a) => {
      var x = center(a.at)
      node(
        'line',
        { x1: x, x2: x, y1: 20, y2: y(totals[a.at]) - 4, class: 'chart-annotation' },
        svg,
      )
      var anchorEnd = x > width - 220
      label(svg, a.label, {
        x: anchorEnd ? x + 4 : x - 4,
        y: 14,
        'text-anchor': anchorEnd ? 'end' : 'start',
        class: 'chart-note',
      })
    })

    var overlay = node(
      'rect',
      {
        x: box.left,
        y: box.top,
        width: box.right - box.left,
        height: box.bottom - box.top,
        fill: 'transparent',
      },
      svg,
    )
    var active = -1
    overlay.addEventListener('mousemove', (event) => {
      var rect = svg.getBoundingClientRect()
      var i = Math.max(
        0,
        Math.min(count - 1, Math.floor((event.clientX - rect.left - box.left) / slot)),
      )
      if (i !== active) {
        if (active >= 0) bands[active].classList.remove('is-active')
        bands[i].classList.add('is-active')
        active = i
      }
      var inGap = config.gap && i >= config.gap.from && i <= config.gap.to
      var rows = inGap
        ? [{ name: config.gap.tip || 'No data', value: '\u2013' }]
        : config.series
            .map((s) => ({ swatch: swatch(s), name: s.name, value: config.format(s.values[i]) }))
            .reverse()
      if (!inGap && totals[i] !== null && config.series.length > 1)
        rows.push({ name: config.totalName || 'Total', value: config.format(totals[i]) })
      showTip(event, tipRows(config.tipTitles ? config.tipTitles[i] : config.labels[i], rows))
    })
    overlay.addEventListener('mouseleave', () => {
      if (active >= 0) bands[active].classList.remove('is-active')
      active = -1
      hideTip()
    })
  })
}

/* Lines on one axis and one unit. The last value is labelled at the line end. */
function lines(el, config) {
  frame(el, config, (svg, width, height) => {
    var box = { left: 52, right: width - 64, top: 10, bottom: height - 28 }
    var count = config.labels.length
    var step = count > 1 ? (box.right - box.left) / (count - 1) : 0
    var x = (i) => box.left + step * i
    var max = Math.max.apply(
      null,
      config.series.map((s) => Math.max.apply(null, s.values)),
    )
    var y = axes(svg, box, ticks(max, 4), config.labels, config.tickFormat || config.format, x)

    config.series.forEach((s) => {
      var points = s.values.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ')
      var line = node('polyline', { points: points, class: 'chart-line' }, svg)
      line.style.stroke = s.color
      if (s.dash) line.setAttribute('stroke-dasharray', '5 4')
      var last = s.values[count - 1]
      var dot = node(
        'rect',
        { x: x(count - 1) - 4, y: y(last) - 4, width: 8, height: 8, class: 'chart-dot' },
        svg,
      )
      dot.style.fill = s.color
      label(svg, config.format(last), { x: box.right + 10, y: y(last) + 4, class: 'chart-end' })
    })

    var cursor = node(
      'line',
      { y1: box.top, y2: box.bottom, class: 'chart-cursor', visibility: 'hidden' },
      svg,
    )
    var dots = config.series.map((s) => {
      var c = node('rect', { width: 8, height: 8, class: 'chart-dot', visibility: 'hidden' }, svg)
      c.style.fill = s.color
      return c
    })
    var overlay = node(
      'rect',
      {
        x: box.left,
        y: box.top,
        width: box.right - box.left,
        height: box.bottom - box.top,
        fill: 'transparent',
      },
      svg,
    )
    overlay.addEventListener('mousemove', (event) => {
      var rect = svg.getBoundingClientRect()
      var i = Math.max(
        0,
        Math.min(count - 1, Math.round((event.clientX - rect.left - box.left) / (step || 1))),
      )
      cursor.setAttribute('x1', x(i))
      cursor.setAttribute('x2', x(i))
      cursor.setAttribute('visibility', 'visible')
      config.series.forEach((s, index) => {
        dots[index].setAttribute('x', x(i) - 4)
        dots[index].setAttribute('y', y(s.values[i]) - 4)
        dots[index].setAttribute('visibility', 'visible')
      })
      showTip(
        event,
        tipRows(
          config.tipTitles ? config.tipTitles[i] : config.labels[i],
          config.series.map((s) => ({
            swatch: swatch(Object.assign({ line: true }, s)),
            name: s.name,
            value: config.format(s.values[i]),
          })),
        ),
      )
    })
    overlay.addEventListener('mouseleave', () => {
      cursor.setAttribute('visibility', 'hidden')
      dots.forEach((d) => {
        d.setAttribute('visibility', 'hidden')
      })
      hideTip()
    })
  })
}

var resizeTimer
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    renderers = renderers.filter((el) => el.isConnected)
    renderers.forEach((el) => {
      if (!el.hidden) el.chartRender()
    })
  }, 120)
})

/* A row-sized trend with no axes: shape only, the exact values live in the detail.
     A null value breaks the line, so a day without data is a gap and not a zero. */
function spark(values, title) {
  var w = 72
  var h = 20
  if (values.length < 2) return ''
  var max =
    Math.max.apply(
      null,
      values.map((v) => v || 0),
    ) || 1
  var runs = [[]]
  values.forEach((v, i) => {
    if (v === null) {
      runs.push([])
      return
    }
    runs[runs.length - 1].push(
      ((i / (values.length - 1)) * w).toFixed(1) + ',' + (h - 2 - (v / max) * (h - 4)).toFixed(1),
    )
  })
  return (
    '<svg class="spark" width="' +
    w +
    '" height="' +
    h +
    '" viewBox="0 0 ' +
    w +
    ' ' +
    h +
    '" role="img" aria-label="' +
    escapeHtml(title) +
    '"><title>' +
    escapeHtml(title) +
    '</title>' +
    runs
      .map((points) => (points.length > 1 ? '<polyline points="' + points.join(' ') + '"/>' : ''))
      .join('') +
    '</svg>'
  )
}

window.Charts = {
  columns: columns,
  lines: lines,
  legend: legend,
  swatch: swatch,
  spark: spark,
}
