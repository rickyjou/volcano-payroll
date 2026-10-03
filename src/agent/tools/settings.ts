// Admin settings and integration tools, plus links to the screens chat doesn't cover.
import { newWebhookSecret } from '../../lib/random';
import { num, rows } from '../../server/db';
import { changed } from '../queries';
import { Refusal, type AgentTool } from '../types';
import { CONFIRM_CHOICES, DANGER_CHOICES } from './common';

const ADMIN = ['admin'] as const;
const EVENTS = ['payroll_run.finalized', 'payroll_run.voided'];

const SETTING_FIELDS = {
  company_name: { type: 'string', description: 'Company name' },
  week_starts_on: { type: 'number', description: 'First day of the workweek: 0 = Sunday … 6 = Saturday' },
  ot_weekly_threshold: { type: 'number', description: 'Weekly overtime after this many hours' },
  ot_daily_threshold: { type: 'number', description: 'Daily overtime after this many hours' },
  dt_daily_threshold: { type: 'number', description: 'Daily double time after this many hours' },
  ot_multiplier: { type: 'number', description: 'Overtime multiplier, e.g. 1.5' },
  dt_multiplier: { type: 'number', description: 'Double-time multiplier, e.g. 2' },
  ot_applies_to_daily: { type: 'boolean', description: 'Pay weekly overtime to daily-rate employees' },
} as const;

const after = (v: unknown) => (v == null ? 'off' : `after ${v}h`);

export const showSettings: AgentTool = {
  name: 'show_settings',
  roles: [...ADMIN],
  description: 'show company and overtime settings, API keys and webhooks',
  kind: 'read',
  args: {},
  async run(ctx) {
    const [s] = await rows<Record<string, unknown>>(ctx.db.from('settings').select(Object.keys(SETTING_FIELDS).join(',')));
    const keys = await rows<{ id: string; name: string; prefix: string; revoked_at: string | null }>(ctx.db.from('api_keys').select('id,name,prefix,revoked_at').order('created_at', { ascending: false }).limit(50));
    const hooks = await rows<{ id: string; url: string; active: boolean }>(ctx.db.from('webhook_endpoints').select('id,url,active').limit(50));
    const settings = Object.fromEntries(Object.keys(SETTING_FIELDS).map((k) => [k, typeof s?.[k] === 'string' && k !== 'company_name' ? num(s[k]) : s?.[k] ?? null]));
    return {
      text: `${settings.company_name}: weekly OT ${after(settings.ot_weekly_threshold)}, daily OT ${after(settings.ot_daily_threshold)}, double time ${after(settings.dt_daily_threshold)}. ${keys.filter((k) => !k.revoked_at).length} active API key(s), ${hooks.length} webhook(s).`,
      cards: [
        { kind: 'table', title: 'Settings', columns: ['Setting', 'Value'], rows: Object.entries(settings).map(([k, v]) => [k, String(v ?? '—')]) },
        { kind: 'table', title: 'API keys', columns: ['Name', 'Prefix', 'Status'], rows: keys.map((k) => [k.name, k.prefix, k.revoked_at ? 'revoked' : 'active']) },
        { kind: 'table', title: 'Webhooks', columns: ['URL', 'Status'], rows: hooks.map((h) => [h.url, h.active ? 'active' : 'paused']) },
      ],
      data: { settings, api_keys: keys, webhooks: hooks },
    };
  },
};

export const updateSettings: AgentTool = {
  name: 'update_settings',
  roles: [...ADMIN],
  description: 'change company or overtime settings',
  kind: 'write',
  args: { ...SETTING_FIELDS },
  async confirm(_ctx, a) {
    if (Object.keys(a).length === 0) throw new Refusal('Tell me which setting to change.');
    return { title: 'Change these settings?', lines: [...Object.entries(a).map(([k, v]) => `${k}: ${v}`), 'Draft payroll runs must be regenerated to use them.'], choices: CONFIRM_CHOICES };
  },
  async run(ctx, a) {
    await changed(ctx.db.update('settings', a as Record<string, string | number | boolean>).eq('id', true), 'the settings');
    return { text: `Settings updated: ${Object.entries(a).map(([k, v]) => `${k} = ${v}`).join(', ')}.`, changed: ['settings'] };
  },
};

export const createApiKey: AgentTool = {
  name: 'create_api_key',
  roles: [...ADMIN],
  description: 'create an API key a payroll provider can use to read finalized runs',
  kind: 'write',
  args: { name: { type: 'string', required: true, description: 'What the key is for, e.g. "Gusto connector"' } },
  async confirm(_ctx, a) {
    return { title: `Create an API key named "${a.name}"?`, lines: ['The key is shown once. Copy it straight away.'], choices: CONFIRM_CHOICES };
  },
  async run(ctx, a) {
    const k = await ctx.invoke<{ id: string; name: string; prefix: string; key: string }>('api-key-create', { name: a.name });
    return {
      text: `Created API key "${k.name}" (prefix ${k.prefix}). Copy it now; it won't be shown again.`,
      cards: [{ kind: 'secret', label: `API key "${k.name}"`, value: k.key }],
      changed: ['integrations'],
    };
  },
};

export const revokeApiKey: AgentTool = {
  name: 'revoke_api_key',
  roles: [...ADMIN],
  description: 'revoke an API key so it stops working',
  kind: 'write',
  args: { key: { type: 'uuid', required: true, description: 'The API key id (from show_settings)' } },
  async confirm(ctx, a) {
    const [k] = await rows<{ name: string; prefix: string; revoked_at: string | null }>(ctx.db.from('api_keys').select('name,prefix,revoked_at').eq('id', a.key as string));
    if (!k) throw new Refusal('That API key does not exist.');
    if (k.revoked_at) throw new Refusal(`"${k.name}" is already revoked.`);
    return { title: `Revoke the API key "${k.name}" (${k.prefix})?`, lines: ['Anything using it stops working immediately.'], choices: DANGER_CHOICES };
  },
  async run(ctx, a) {
    await changed(ctx.db.update('api_keys', { revoked_at: new Date().toISOString() }).eq('id', a.key as string), 'that API key');
    return { text: 'API key revoked.', changed: ['integrations'] };
  },
};

function httpsOnly(url: unknown): void {
  if (!/^https:\/\//.test(String(url))) throw new Refusal('Webhook URLs must start with https://.');
}

export const addWebhook: AgentTool = {
  name: 'add_webhook',
  roles: [...ADMIN],
  description: 'add a webhook URL to be notified when payroll runs are finalized or voided',
  kind: 'write',
  args: { url: { type: 'string', required: true, description: 'An https:// URL' } },
  async confirm(_ctx, a) {
    httpsOnly(a.url);
    return { title: `Add a webhook to ${a.url}?`, lines: [`Events: ${EVENTS.join(', ')}`, 'Its signing secret is shown once.'], choices: CONFIRM_CHOICES };
  },
  async run(ctx, a) {
    httpsOnly(a.url);
    const secret = newWebhookSecret();
    await rows(ctx.db.insert('webhook_endpoints', { url: String(a.url), secret, events: JSON.stringify(EVENTS) }));
    return {
      text: `Webhook added for ${a.url}. Use the secret to verify the X-Payroll-Signature header.`,
      cards: [{ kind: 'secret', label: 'Webhook signing secret', value: secret }],
      changed: ['integrations'],
    };
  },
};

export const sendTestWebhook: AgentTool = {
  name: 'send_test_webhook',
  roles: [...ADMIN],
  description: 'send a test event to a webhook',
  kind: 'write',
  args: { endpoint: { type: 'uuid', required: true, description: 'The webhook id (from show_settings)' } },
  async confirm(ctx, a) {
    const [h] = await rows<{ url: string }>(ctx.db.from('webhook_endpoints').select('url').eq('id', a.endpoint as string));
    if (!h) throw new Refusal('That webhook does not exist.');
    return { title: `Send a test event to ${h.url}?`, lines: [], choices: CONFIRM_CHOICES };
  },
  async run(ctx, a) {
    const r = await ctx.invoke<{ delivered: number; retrying: number; failed: number }>('webhook-dispatch', { test_endpoint_id: a.endpoint });
    return { text: `Test sent: ${r.delivered} delivered, ${r.retrying} will retry, ${r.failed} failed.`, changed: ['integrations'] };
  },
};

const PAGES = {
  import_employees: { label: 'Import employees from CSV', href: '/admin/employees/import' },
  export_formats: { label: 'Edit export formats', href: '/admin/integrations' },
  employees: { label: 'Employees', href: '/admin/employees' },
  payroll_runs: { label: 'Payroll runs', href: '/admin/runs' },
  my_timesheet: { label: 'My timesheet', href: '/portal' },
} as const;

export const openPage: AgentTool = {
  name: 'open_page',
  roles: ['employee', 'manager', 'admin'],
  description: 'link to a screen for things done outside chat: CSV import, export format editor, timesheet grid',
  kind: 'read',
  args: { page: { type: { enum: Object.keys(PAGES) }, required: true, description: 'Which screen' } },
  async run(_ctx, a) {
    const p = PAGES[a.page as keyof typeof PAGES];
    return { text: `That's done on the ${p.label} screen.`, cards: [{ kind: 'link', label: p.label, href: p.href }] };
  },
};

export const SETTINGS_TOOLS = [showSettings, updateSettings, createApiKey, revokeApiKey, addWebhook, sendTestWebhook, openPage];
