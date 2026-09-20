import { REGIONS } from './lib/locations.js';
import { TEMPLATE_VARS } from './lib/template.js';

// Tabs the front end shows in the workspace. "builtin" tabs have hand-built screens.
// Anything else with an `endpoint` and `columns` is rendered by the front end's generic table view, so a new
// backend feature can ship as: one route + one entry here → a new tab appears with no front-end code.
export const TABS = [
  { id: 'overview', label: 'Overview', icon: '◈', builtin: true },
  { id: 'events', label: 'Events', icon: '◇', builtin: true },
  { id: 'guests', label: 'Guests', icon: '◻', builtin: true },
  { id: 'checkin', label: 'Check-in', icon: '✓', builtin: true },
  { id: 'messaging', label: 'Messaging', icon: '◉', builtin: true },
  {
    id: 'messages', label: 'Messages', icon: '✉', builtin: false,
    title: 'Message log', sub: 'Every SMS and WhatsApp invitation sent from your account',
    endpoint: '/api/messaging/log',
    columns: [
      { key: 'ts', label: 'Sent', type: 'time' },
      { key: 'guest_name', label: 'Guest' },
      { key: 'channel', label: 'Channel', type: 'channel' },
      { key: 'to_phone', label: 'To', type: 'mono' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'error', label: 'Detail' },
    ],
    empty: 'Nothing sent yet. Invitations you send appear here.',
  },
  { id: 'account', label: 'Account', icon: '☺', builtin: true },
];

export { REGIONS, TEMPLATE_VARS };
