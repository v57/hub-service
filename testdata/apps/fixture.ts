import {
  badge, button, cell, chart, column, divider, gauge, grid, hstack, image, link, list, markdown, picker, progress,
  section, series, sheet, slider, spacer, stat, tab, table, tabs, text, textField, vstack, zstack,
  type AppInterface,
} from '../../app'

/** Every element and option once, with data for the bound ones */
export function appFixture(): AppInterface {
  const refresh = { path: 'demo/refresh' }
  return {
    header: { type: 'app', name: 'Demo', path: 'demo', icon: 'chart.bar', widget: { sizes: ['1x1', '2x2'] } },
    body: [
      'Plain text',
      text('$title', { style: 'title', color: 'blue', secondary: true }),
      markdown('**Bold** and [a link](https://example.com)'),
      image({ url: '$avatar' }, { width: 40, height: 40, mode: 'fill', cornerRadius: 20 }),
      image({ symbol: 'star.fill' }, { color: '#ffaa00' }),
      badge('$status', { color: '$statusColor' }),
      divider(),
      link('Docs', 'https://example.com', { icon: 'book' }),
      stat('Users', '$users', { unit: 'k', delta: '$usersDelta', deltaFormat: 'percent', positive: 'up', sparkline: '$usersHistory', icon: 'person.2', color: 'green' }),
      gauge('$cpu', { min: 0, max: 100, title: 'CPU', label: '$cpuLabel', style: 'semicircle', color: 'blue', thresholds: [{ value: 80, color: 'red' }] }),
      chart('line', [series('In', '$in', { color: 'blue' }), series('Out', [[1, 2], [2, 3]])], { title: 'Traffic', x: 'time', height: 160, legend: true, yMin: 0, yMax: 10, unit: 'MB/s' }),
      chart('bar', series('Signups', [{ x: 'Mon', y: 3 }, { x: 'Tue', y: 5 }]), { stacked: true, x: 'category' }),
      chart('area', series('Load', [1, 2, 3])),
      chart('donut', series('Platforms', [{ label: 'iOS', value: 3 }, { label: 'Android', value: 2 }])),
      table('$rows', ['name', column('Status', 'status', { align: 'trailing', style: 'badge' })]),
      grid([stat('A', 1), stat('B', 2)], { columns: 2, minWidth: 120, spacing: 8 }),
      section('Section', ['inside'], { subtitle: 'Subtitle', style: 'plain' }),
      tabs([tab('Day', ['day'], { icon: 'sun.max' }), tab('Week', ['week'])], { selected: 'range', style: 'segmented' }),
      sheet('Details', ['in a sheet'], { icon: 'info.circle' }),
      button('Delete', { path: 'demo/delete', body: 'id' }, { icon: 'trash', style: 'destructive', confirm: { title: 'Delete?', message: 'For good', button: 'Delete', destructive: true } }),
      button('Refresh', refresh),
      hstack([cell('$title', '$subtitle'), spacer(), progress('progress', { min: 0, max: 100 })], { spacing: 8 }),
      vstack([textField('name', { placeholder: 'Name' }), slider('volume', { min: 0, max: 10, step: 1 }), picker(['a', 'b'], 'choice')]),
      zstack(['back', 'front']),
      list('rows', cell('$name', '$status')),
    ],
    data: {
      title: 'Demo',
      avatar: 'https://example.com/a.png',
      status: 'Healthy',
      statusColor: 'green',
      users: 12.5,
      usersDelta: 0.12,
      usersHistory: [1, 3, 2, 5],
      cpu: 42,
      cpuLabel: '42%',
      in: [[1760000000000, 1], [1760000060000, 4]],
      rows: [{ name: 'api', status: 'up' }, { name: 'db', status: 'down' }],
      progress: 40,
      range: 'Day',
    },
    widget: { body: [stat('Users', '$users', { sparkline: '$usersHistory' })], '1x1': [gauge('$cpu', { max: 100 })] },
  }
}
