import { invoke } from '@forge/bridge';
import { buildXlsx, toCsv } from './xlsx.js';

/**
 * The one thing UI Kit cannot do is hand the browser a file. This tiny
 * Custom UI resource lives inside a UI Kit <Frame> purely to turn the report
 * into a download, as CSV or Excel. It talks to the same resolvers as the page.
 */

const $ = (id) => document.getElementById(id);

const HEADER = ['Display name', 'Email', 'Last contribution', 'Can reclaim', 'Leaves groups', 'Reason', 'Account ID'];

/** Pure: report rows -> a table whose first row is the header. */
export const tableOf = (rows) => [
  HEADER,
  ...rows.map((r) => [
    r.displayName,
    r.email ?? '',
    r.label ?? '',
    r.lastAction?.status === 'reclaimed'
      ? 'Already reclaimed'
      : r.reclaimable && !r.isProtected
        ? r.lastAction?.status === 'partial'
          ? 'Yes (partly reclaimed)'
          : r.pending
            ? 'Yes (groups read at reclaim)'
            : 'Yes'
        : 'No',
    (r.removeGroups ?? []).join(' / '),
    r.isProtected ? 'On your protected list.' : (r.reason ?? ''),
    r.accountId,
  ]),
];

const today = () => new Date().toISOString().slice(0, 10);

function offerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function refreshCount() {
  try {
    const res = await invoke('getStatus');
    const n = res?.report?.dormantCount ?? 0;
    $('download').textContent = n ? `Download CSV (${n} inactive users)` : 'Download CSV';
    $('download').disabled = !n;
    $('excel').disabled = !n;
  } catch {
    $('status').textContent = 'Could not read the report.';
  }
}

async function loadTable() {
  const res = await invoke('getAllRows');
  if (res?.forbidden) throw new Error(res.error);
  const rows = res?.rows ?? [];
  const capped = res?.limit && rows.length >= res.limit ? ` (capped at ${res.limit})` : '';
  return { table: tableOf(rows), count: rows.length, capped };
}

async function download(kind) {
  const buttons = [$('download'), $('excel')];
  buttons.forEach((b) => (b.disabled = true));
  $('status').textContent = 'Preparing…';
  try {
    const { table, count, capped } = await loadTable();
    if (kind === 'xlsx') {
      const blob = new Blob([buildXlsx(table, 'Inactive users')], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      offerDownload(blob, `seat-reclaim-confluence-${today()}.xlsx`);
      $('status').textContent = `${count} rows${capped}.`;
      return;
    }
    const text = toCsv(table);
    // The BOM makes Excel open the CSV as UTF-8 without an import wizard.
    offerDownload(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }), `seat-reclaim-confluence-${today()}.csv`);
    $('status').textContent = `${count} rows${capped}. If nothing downloaded, use “Copy CSV” instead.`;
    $('copy').hidden = false;
    $('copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        $('status').textContent = 'Copied to the clipboard.';
      } catch {
        const ta = $('fallback');
        ta.hidden = false;
        ta.value = text;
        ta.focus();
        ta.select();
        $('status').textContent = 'Select the text below and copy it.';
      }
    };
  } catch (err) {
    $('status').textContent = `Could not build the export: ${err?.message ?? 'no response'}.`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

if (typeof document !== 'undefined' && $('download')) {
  $('download').addEventListener('click', () => download('csv'));
  $('excel').addEventListener('click', () => download('xlsx'));
  refreshCount();
}
