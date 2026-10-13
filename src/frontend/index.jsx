import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  Checkbox,
  DynamicTable,
  Frame,
  Heading,
  Inline,
  Label,
  Link,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  ProgressBar,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Strong,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
} from '@forge/react';
import { invoke, view } from '@forge/bridge';
import { licenseGate, licenseMessage } from '../lib/scan.js';
import { bandOptions, filterRows, fmtMoney, normaliseSeatCosts, scanProgress, showReviewPrompt, yearlySaving } from '../lib/ui.js';

const REVIEW_URL = 'https://marketplace.atlassian.com/search?query=Seat%20Reclaim%20for%20Confluence';

// The one product this app prices. Seat prices are stored by product name.
const PRODUCT = 'Confluence';

// Must match RECLAIM_BATCH in src/index.js; the backend caps it anyway.
const BATCH = 5;

const PERIODS = [30, 60, 90, 180, 365].map((d) => ({
  label: `No contribution in ${d} days`,
  value: String(d),
}));

/**
 * One-time request for a Marketplace review, shown only after the app has
 * done something useful. Closing it hides it for the whole site.
 */
function ReviewPrompt({ onHide }) {
  return (
    <SectionMessage appearance="discovery" title="Did this save you money?">
      <Stack space="space.100">
        <Text>
          A short review on the Atlassian Marketplace helps other admins find this app. It takes a
          minute, and we read every one.
        </Text>
        <Inline space="space.100" alignBlock="center">
          <Link href={REVIEW_URL} openNewTab>
            Write a review
          </Link>
          <Button appearance="subtle" onClick={onHide}>
            Not now
          </Button>
        </Inline>
      </Stack>
    </SectionMessage>
  );
}

const phaseText = (s) => {
  switch (s?.phase) {
    case 'directory':
      return `Listing licensed users — ${s.usersFound ?? 0} found`;
    case 'content':
      return `Scanning recent contributions — ${s.itemsScanned ?? 0} pages, posts, comments and files`;
    case 'verify':
      return `Checking candidates — ${s.verified ?? 0} checked, ${s.dormantFound ?? 0} inactive so far`;
    case 'finalize':
      return 'Building the list';
    default:
      return 'Working';
  }
};

const fmtDate = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '—');
const fmtTime = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : '—');
const join = (xs) => (xs ?? []).join(', ') || '—';

/** Status shown for a row: what happened last, or whether it can be reclaimed. */
function rowStatus(u) {
  const last = u.lastAction?.status;
  if (last === 'reclaimed') return { text: 'Reclaimed', appearance: 'success' };
  if (last === 'partial') return { text: 'Partly reclaimed', appearance: 'moved' };
  if (u.isProtected) return { text: 'Protected', appearance: 'default' };
  if (!u.reclaimable) return { text: 'Can’t reclaim', appearance: 'default' };
  return { text: 'Ready', appearance: 'inprogress' };
}

// A partly reclaimed user still has groups to leave, so they stay selectable.
const canSelect = (u) => u.reclaimable && !u.isProtected && u.lastAction?.status !== 'reclaimed';

// ---------------------------------------------------------------------------
// Inactive users tab
// ---------------------------------------------------------------------------

const ALL_BANDS = { label: 'Any inactivity', value: '' };
const STATUS_FILTERS = [
  { label: 'Everyone', value: '' },
  { label: 'Ready to reclaim', value: 'ready' },
  { label: 'Can’t reclaim', value: 'blocked' },
  { label: 'Already reclaimed', value: 'done' },
];

const statusGroup = (u) => (u.lastAction?.status === 'reclaimed' ? 'done' : canSelect(u) ? 'ready' : 'blocked');

const HowItWorks = ({ compact, onToggle }) =>
  compact ? (
    <SectionMessage>
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Text>
          Finds licensed users who contributed nothing in Confluence in the period, then frees their seats after you
          confirm. Every change can be undone from History.
        </Text>
        <Button appearance="subtle" spacing="compact" onClick={onToggle}>
          How it works
        </Button>
      </Inline>
    </SectionMessage>
  ) : (
    <SectionMessage title="How it works">
      <Stack space="space.100">
        <Text>
          Run a scan to find licensed users who <Strong>created or edited nothing in Confluence</Strong> in the period:
          no page, blog post, comment or file. Every candidate is checked against all content on the site. Confluence
          does not record who <Strong>views</Strong> a page, so someone who only reads will appear here; if in doubt,
          check their last-active date in Atlassian Administration. Then pick who to reclaim. The app takes them out
          of the groups that grant Confluence, which frees the seat, and asks Confluence to confirm. Admins and you
          are never touched, and you can <Strong>Protect</Strong> anyone else you want left alone. Nothing changes
          until you confirm; each person's activity and groups are re-checked live first, and every change can be
          undone from the History tab.
        </Text>
        {onToggle && (
          <Box>
            <Button appearance="subtle" spacing="compact" onClick={onToggle}>
              Hide
            </Button>
          </Box>
        )}
      </Stack>
    </SectionMessage>
  );

const PermissionChecks = ({ checks, title }) => (
  <SectionMessage appearance="information" title={title}>
    <Stack space="space.050">
      {checks.map((c) => (
        <Text key={c.name}>
          {c.ok === true ? '✓' : c.ok === false ? '✗' : '–'} {c.name}
          {c.ok === false ? ` — refused${c.status ? ` (${c.status})` : ''}; needs ${c.scope}` : ''}
          {c.ok === null && c.note ? ` — ${c.note}` : ''}
        </Text>
      ))}
    </Stack>
  </SectionMessage>
);

function AuditPanel({ gate, onChanged, version }) {
  const [period, setPeriod] = useState(PERIODS[2]);
  const [status, setStatus] = useState(null);
  const [rows, setRows] = useState([]);
  const [rowsLimit, setRowsLimit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [showHow, setShowHow] = useState(false);
  const [checks, setChecks] = useState(null);
  const [manualChecks, setManualChecks] = useState(null);
  // Text boxes keep their own text (defaultValue); the page only listens.
  // Feeding the value back on every keystroke loses characters in UI Kit.
  const [price, setPrice] = useState('');
  const [savedPrice, setSavedPrice] = useState(null);
  const [priceVersion, setPriceVersion] = useState(0);
  const [searchVersion, setSearchVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [bandFilter, setBandFilter] = useState(ALL_BANDS);
  const [statusFilter, setStatusFilter] = useState(STATUS_FILTERS[0]);

  // Polled on a timer, so a transient failure must not throw into the interval
  // and must not blank out a report that is already on screen.
  const refresh = useCallback(async () => {
    try {
      const res = await invoke('getStatus');
      setStatus(res);
      return res;
    } catch {
      return null;
    }
  }, []);

  const [reviewHidden, setReviewHidden] = useState(true);
  const hideReview = () => {
    setReviewHidden(true);
    invoke('hideReviewPrompt').catch(() => {});
  };

  useEffect(() => {
    refresh();
    invoke('getSettings')
      .then((res) => {
        setReviewHidden(Boolean(res?.settings?.reviewPromptHiddenAt));
        const value = res?.settings?.seatCosts?.[PRODUCT] ?? null;
        setSavedPrice(value);
        setPrice(value ? String(value) : '');
        setPriceVersion((v) => v + 1);
      })
      .catch(() => {});
  }, [refresh]);

  const state = status?.state;
  const report = status?.report;
  const running = state?.status === 'running';
  const stale = Boolean(status?.stale);

  // A permission failure gets a self-test, so the admin sees WHICH call was
  // refused and which grant fixes it, instead of a bare status code.
  const failedError = state?.status === 'failed' ? state.error : null;
  const permissionFailure = Boolean(failedError && /\b(401|403)\b/.test(failedError));
  useEffect(() => {
    if (!permissionFailure) {
      setChecks(null);
      return;
    }
    invoke('diagnose')
      .then((res) => setChecks(res?.checks ?? []))
      .catch(() => setChecks([]));
  }, [permissionFailure, failedError]);

  // Poll only while a scan is actually in flight.
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [running, refresh]);

  // The whole list loads at once, so search, filters and "select all" cover
  // every inactive user, not just one page.
  const loadAll = useCallback(async () => {
    try {
      const res = await invoke('getAllRows');
      setRows(res?.rows ?? []);
      setRowsLimit(res?.limit ?? null);
    } catch (err) {
      setMessage(`Could not load the list: ${err?.message ?? 'no response'}.`);
    }
  }, []);

  const generatedAt = report?.generatedAt;
  useEffect(() => {
    if (generatedAt && !running) {
      setSelected(new Set());
      loadAll();
    }
  }, [generatedAt, running, loadAll]);

  // An undo in the History tab changes what this list should show.
  const [seenVersion, setSeenVersion] = useState(version);
  useEffect(() => {
    if (version === seenVersion) return;
    setSeenVersion(version);
    if (generatedAt && !running) loadAll();
  }, [version, seenVersion, generatedAt, running, loadAll]);

  // Listing who holds a seat runs as the admin, in short calls from this page,
  // until the resolver reports done and hands over to the background worker.
  const listUsers = useCallback(
    async (run) => {
      for (let i = 0; i < 200; i++) {
        const res = await invoke('listUsers', { run });
        await refresh();
        if (!res?.ok) {
          if (res?.error) setMessage(res.error);
          return;
        }
        if (res.done) return;
      }
    },
    [refresh]
  );

  // Reopened while users were still being listed: pick the listing up again.
  const resumeRun = running && !stale && state?.phase === 'directory' && !busy ? state.run : null;
  useEffect(() => {
    if (!resumeRun) return;
    listUsers(resumeRun).catch(() => {});
  }, [resumeRun, listUsers]);

  // Every invoke can reject — the network, a cold start, a backend fault. If we
  // let that escape, `busy` is never cleared and the button stays dead with no
  // explanation, which is the worst thing this page can do.
  const start = async () => {
    setBusy(true);
    setMessage(null);
    setOutcome(null);
    try {
      const res = await invoke('startScan', { days: Number(period.value) });
      if (!res?.ok) setMessage(res?.error ?? 'Could not start the scan.');
      await refresh();
      if (res?.ok && res.state?.run) await listUsers(res.state.run);
    } catch (err) {
      setMessage(
        `Could not start the scan: ${err?.message ?? 'the app did not respond'}. Try again, and if it keeps happening email support@telcomaglobal.com.`
      );
    } finally {
      setBusy(false);
    }
  };

  const savePrice = async () => {
    try {
      const res = await invoke('saveSettings', { seatCosts: { [PRODUCT]: price } });
      const value = res?.settings?.seatCosts?.[PRODUCT] ?? null;
      setSavedPrice(value);
      setPrice(value ? String(value) : '');
      setPriceVersion((v) => v + 1);
    } catch {
      setMessage('Could not save the seat price. Try again.');
    }
  };

  const toggle = (accountId, on) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(accountId);
      else next.delete(accountId);
      return next;
    });

  const protect = async (u, on) => {
    try {
      const res = await invoke('setProtected', { accountId: u.accountId, protected: on });
      if (!res?.ok) throw new Error(res?.error);
      toggle(u.accountId, false);
      setRows((prev) => prev.map((r) => (r.accountId === u.accountId ? { ...r, isProtected: on } : r)));
    } catch {
      setMessage('Could not update the protected list. Try again.');
    }
  };

  const liveCost = normaliseSeatCosts({ [PRODUCT]: price })[PRODUCT] ?? null;
  const priceDirty = (liveCost ?? null) !== (savedPrice ?? null);
  const saving = report ? yearlySaving({ [PRODUCT]: report.dormantCount }, { [PRODUCT]: liveCost }) : null;
  const bands = useMemo(() => [ALL_BANDS, ...bandOptions(rows)], [rows]);
  const visible = useMemo(
    () =>
      filterRows(rows, { query, band: bandFilter.value || null }).filter(
        (u) => !statusFilter.value || statusGroup(u) === statusFilter.value
      ),
    [rows, query, bandFilter, statusFilter]
  );
  const filtering = Boolean(query || bandFilter.value || statusFilter.value);
  const readyVisible = visible.filter(canSelect);
  const chosen = useMemo(() => rows.filter((u) => selected.has(u.accountId)), [rows, selected]);
  const chosenSaving = chosen.length ? yearlySaving({ [PRODUCT]: chosen.length }, { [PRODUCT]: liveCost }) : null;
  const scan = scanProgress(state);
  const hasEmails = rows.some((r) => r.email);
  const scanAgeDays = report?.generatedAt ? Math.floor((Date.now() - Date.parse(report.generatedAt)) / 86_400_000) : 0;
  const accessGroups = report?.accessGroups ?? [];
  const accessText = accessGroups.map((g) => (g.admin ? `${g.name} (admin, never removed)` : g.name)).join(', ');

  /** Reclaim in small batches; read Confluence's own user count before and after. */
  const runReclaim = async () => {
    setConfirmOpen(false);
    setOutcome(null);
    setMessage(null);
    const ids = chosen.map((u) => u.accountId);
    const results = [];
    let before = null;
    let after = null;
    try {
      before = await invoke('getSeatCount');
    } catch {
      /* the counts are a bonus; the reclaim does not depend on them */
    }
    for (let i = 0; i < ids.length; i += BATCH) {
      setProgress({ done: i, total: ids.length });
      try {
        const res = await invoke('reclaim', { accountIds: ids.slice(i, i + BATCH) });
        if (!res?.ok) {
          results.push(...ids.slice(i, i + BATCH).map((accountId) => ({ accountId, ok: false, error: res?.error })));
          if (res?.unlicensed || res?.forbidden) break;
        } else {
          results.push(...(res.results ?? []));
        }
      } catch (err) {
        results.push(
          ...ids.slice(i, i + BATCH).map((accountId) => ({ accountId, ok: false, error: err?.message ?? 'No response' }))
        );
      }
    }
    try {
      after = await invoke('getSeatCount');
    } catch {
      /* see above */
    }
    setProgress(null);
    setSelected(new Set());
    setOutcome({ results, before, after });
    await loadAll();
    onChanged?.();
  };

  return (
    <Stack space="space.200">
      <HowItWorks compact={Boolean(report) && !showHow} onToggle={report ? () => setShowHow((v) => !v) : null} />

      <Inline space="space.100" alignBlock="end" shouldWrap>
        <Box xcss={{ minWidth: '260px' }}>
          <Label labelFor="period">Period</Label>
          <Select
            id="period"
            options={PERIODS}
            value={period}
            onChange={setPeriod}
            isDisabled={(running && !stale) || !gate.allowed}
          />
        </Box>
        <Button appearance="primary" onClick={start} isDisabled={(running && !stale) || busy || !gate.allowed}>
          {running && !stale ? 'Scanning…' : stale ? 'Restart scan' : 'Find inactive users'}
        </Button>
        <Button
          appearance="subtle"
          onClick={() =>
            invoke('diagnose')
              .then((res) => setManualChecks(res?.checks ?? []))
              .catch((err) => setMessage(`Could not run the check: ${err?.message ?? 'no response'}.`))
          }
        >
          Check permissions
        </Button>
        {running && (
          <Button
            appearance="subtle"
            onClick={() =>
              invoke('cancelScan')
                .then(refresh)
                .catch(() => setMessage('Could not cancel the scan. It will stop on its own.'))
            }
          >
            Cancel
          </Button>
        )}
      </Inline>

      {message && (
        <SectionMessage appearance="warning">
          <Text>{message}</Text>
        </SectionMessage>
      )}

      {manualChecks && <PermissionChecks checks={manualChecks} title="Permission check" />}

      {running && !stale && (
        <Stack space="space.075">
          <ProgressBar ariaLabel="Scan progress" value={scan.value} isIndeterminate={scan.indeterminate} />
          <Text>
            {phaseText(state)}.{' '}
            {state?.phase === 'directory'
              ? 'Keep this page open for a moment while users are listed.'
              : 'You can leave this page — the scan continues.'}
          </Text>
        </Stack>
      )}

      {stale && (
        <SectionMessage appearance="warning" title="This scan appears to be stuck">
          <Text>It has not made progress for over 20 minutes. Restarting is safe — a scan changes nothing.</Text>
        </SectionMessage>
      )}

      {state?.status === 'failed' && (
        <SectionMessage appearance="error" title="Scan failed">
          <Text>{state.error}</Text>
          {permissionFailure && checks === null && <Text>Checking which permission is missing…</Text>}
          {permissionFailure && checks && checks.length > 0 && (
            <Stack space="space.050">
              <Text>
                <Strong>Permission check.</Strong> Reinstalling or updating the app from Manage apps re-grants every
                permission it needs.
              </Text>
              {checks.map((c) => (
                <Text key={c.name}>
                  {c.ok === true ? '✓' : c.ok === false ? '✗' : '–'} {c.name}
                  {c.ok === false ? ` — refused${c.status ? ` (${c.status})` : ''}; needs ${c.scope}` : ''}
                  {c.ok === null && c.note ? ` — ${c.note}` : ''}
                </Text>
              ))}
            </Stack>
          )}
        </SectionMessage>
      )}

      {progress && (
        <Stack space="space.075">
          <ProgressBar ariaLabel="Reclaim progress" value={progress.total ? progress.done / progress.total : 0} />
          <Text>
            Reclaiming seats — {Math.min(progress.done + BATCH, progress.total)} of {progress.total} users. Keep this
            page open.
          </Text>
        </Stack>
      )}

      {outcome && <Outcome outcome={outcome} />}
      {outcome && showReviewPrompt({ earned: outcome.results.some((r) => r.ok), hidden: reviewHidden }) && (
        <ReviewPrompt onHide={hideReview} />
      )}

      {report && (
        <Stack space="space.150">
          <Stack space="space.050">
            <Heading as="h2" size="medium">
              {report.dormantCount} inactive {report.dormantCount === 1 ? 'user' : 'users'}
              {saving !== null ? ` · about ${fmtMoney(saving)} a year` : ''}
            </Heading>
            <Text>
              {report.totalUsers} licensed · {report.activeUsers} active · {report.days}-day window · scanned{' '}
              {fmtDate(report.generatedAt)}
            </Text>
            {report.dormantCount > 0 && saving === null && (
              <Text>Enter the yearly price of a seat below to see what these seats cost.</Text>
            )}
          </Stack>

          <Text>
            Licensed users are the accounts Atlassian counts for Confluence on this site — the same figure as
            Atlassian Administration. Apps and deactivated accounts are excluded
            {report.guests > 0
              ? `, and ${report.guests} guest ${report.guests === 1 ? 'account holds' : 'accounts hold'} no seat and ${report.guests === 1 ? 'is' : 'are'} not listed.`
              : '.'}
            {accessGroups.length > 0 ? ` Confluence is granted through: ${accessText}.` : ''}
          </Text>

          <Inline space="space.100" alignBlock="end" shouldWrap>
            <Box xcss={{ maxWidth: '220px' }}>
              <Label labelFor="seat">Yearly price of one Confluence seat</Label>
              <Textfield
                key={`seat-${priceVersion}`}
                id="seat"
                name="seat"
                defaultValue={price}
                placeholder="e.g. 70"
                onChange={(e) => setPrice(e?.target?.value ?? '')}
              />
            </Box>
            <Button onClick={savePrice} isDisabled={!priceDirty}>
              Save price
            </Button>
            <Text>
              {saving !== null
                ? `${fmtMoney(saving)} a year across the ${report.dormantCount} inactive ${report.dormantCount === 1 ? 'seat' : 'seats'}. Saved for this site.`
                : 'Use what one seat costs you per year, in your billing currency. It is saved for this site.'}
            </Text>
          </Inline>

          {(report.warnings ?? []).map((w) => (
            <SectionMessage key={w} appearance="warning">
              <Text>{w}</Text>
            </SectionMessage>
          ))}

          {scanAgeDays >= 7 && !running && (
            <SectionMessage appearance="warning">
              <Text>
                This list is {scanAgeDays} days old. Run a new scan before reclaiming. Anyone who contributed since
                the scan is skipped at reclaim time, but the list itself is out of date.
              </Text>
            </SectionMessage>
          )}

          {report.dormantCount === 0 ? (
            <SectionMessage appearance="success" title="No inactive users">
              <Text>
                {report.totalUsers === 1
                  ? `The only licensed user contributed something in the last ${report.days} days.`
                  : `Every one of the ${report.totalUsers} licensed users contributed something in the last ${report.days} days.`}
              </Text>
            </SectionMessage>
          ) : (
            <Stack space="space.150">
              <Inline space="space.100" alignBlock="end" shouldWrap>
                <Box xcss={{ minWidth: '220px' }}>
                  <Label labelFor="search">Search</Label>
                  <Textfield
                    key={`search-${searchVersion}`}
                    id="search"
                    name="search"
                    defaultValue={query}
                    placeholder="Name or email"
                    onChange={(e) => setQuery(e?.target?.value ?? '')}
                  />
                </Box>
                <Box xcss={{ minWidth: '180px' }}>
                  <Label labelFor="band-filter">Inactive for</Label>
                  <Select id="band-filter" options={bands} value={bandFilter} onChange={(v) => setBandFilter(v ?? ALL_BANDS)} />
                </Box>
                <Box xcss={{ minWidth: '180px' }}>
                  <Label labelFor="status-filter">Show</Label>
                  <Select
                    id="status-filter"
                    options={STATUS_FILTERS}
                    value={statusFilter}
                    onChange={(v) => setStatusFilter(v ?? STATUS_FILTERS[0])}
                  />
                </Box>
                {filtering && (
                  <Button
                    appearance="subtle"
                    onClick={() => {
                      setQuery('');
                      setSearchVersion((v) => v + 1);
                      setBandFilter(ALL_BANDS);
                      setStatusFilter(STATUS_FILTERS[0]);
                    }}
                  >
                    Clear filters
                  </Button>
                )}
              </Inline>

              <Inline space="space.100" alignBlock="center" shouldWrap>
                <Button
                  onClick={() => setSelected((prev) => new Set([...prev, ...readyVisible.map((u) => u.accountId)]))}
                  isDisabled={!readyVisible.length || !gate.allowed}
                >
                  Select all ready ({readyVisible.length})
                </Button>
                <Button appearance="subtle" onClick={() => setSelected(new Set())} isDisabled={!selected.size}>
                  Clear selection
                </Button>
                <Button
                  appearance="danger"
                  onClick={() => setConfirmOpen(true)}
                  isDisabled={!chosen.length || Boolean(progress) || !gate.allowed || (running && !stale)}
                >
                  {chosen.length
                    ? `Reclaim seats for ${chosen.length} ${chosen.length === 1 ? 'user' : 'users'}`
                    : 'Reclaim seats'}
                </Button>
                {chosenSaving !== null && <Text>About {fmtMoney(chosenSaving)} a year for the selected.</Text>}
              </Inline>
              <Text>
                Showing {visible.length} of {rows.length}
                {selected.size ? ` · ${selected.size} selected` : ''}
                {rowsLimit && rows.length >= rowsLimit && report.dormantCount > rows.length
                  ? ` (the first ${rowsLimit} of ${report.dormantCount})`
                  : ''}
              </Text>

              <DynamicTable
                head={{
                  cells: [
                    { key: 'pick', content: '' },
                    { key: 'name', content: 'User', isSortable: true },
                    { key: 'last', content: 'Last contribution', isSortable: true },
                    { key: 'status', content: 'Reclaim', isSortable: true },
                    { key: 'protect', content: '' },
                  ],
                }}
                rows={visible.map((u) => {
                  const st = rowStatus(u);
                  return {
                    key: u.accountId,
                    cells: [
                      {
                        key: `pick-${selected.has(u.accountId) ? 'on' : 'off'}`,
                        content: (
                          <Checkbox
                            label=""
                            value={u.accountId}
                            isChecked={selected.has(u.accountId)}
                            isDisabled={!canSelect(u) || !gate.allowed}
                            onChange={() => toggle(u.accountId, !selected.has(u.accountId))}
                          />
                        ),
                      },
                      {
                        key: `name-${String(u.displayName).toLowerCase()}`,
                        content: (
                          <Stack space="space.0">
                            <Text>{u.displayName}</Text>
                            {u.email && <Text size="small">{u.email}</Text>}
                          </Stack>
                        ),
                      },
                      {
                        key: `last-${u.severity ?? 0}`,
                        content: (
                          <Lozenge appearance={String(u.bucket).startsWith('over-') ? 'removed' : 'moved'}>{u.label}</Lozenge>
                        ),
                      },
                      {
                        key: `status-${st.text}`,
                        content: (
                          <Stack space="space.050">
                            <Lozenge appearance={st.appearance}>{st.text}</Lozenge>
                            {(!u.reclaimable || u.pending) && u.reason && <Text size="small">{u.reason}</Text>}
                            {canSelect(u) && !u.pending && <Text size="small">Leaves: {join(u.removeGroups)}</Text>}
                          </Stack>
                        ),
                      },
                      {
                        key: `protect-${u.isProtected ? 'on' : 'off'}`,
                        content: (
                          <Button appearance="subtle" spacing="compact" onClick={() => protect(u, !u.isProtected)}>
                            {u.isProtected ? 'Unprotect' : 'Protect'}
                          </Button>
                        ),
                      },
                    ],
                  };
                })}
                rowsPerPage={25}
                defaultSortKey="last"
                defaultSortOrder="DESC"
                emptyView={<Text>No inactive users match these filters.</Text>}
              />

              {!hasEmails && (
                <Text>Emails are hidden because those users' profile privacy settings don't share them with apps.</Text>
              )}
              <Text size="small">
                Freeing a seat lowers the number of users Atlassian counts. What your bill does depends on your plan:
                Atlassian bills by user tier, usually from the next billing cycle, so the price may not drop until the
                count falls below a tier.
              </Text>

              {/* The download itself happens in a Custom UI frame; UI Kit cannot
                  hand the browser a file. Keyed on generatedAt so a new report
                  reloads the frame and its row count. */}
              <Frame key={generatedAt} resource="export-frame" />
            </Stack>
          )}
        </Stack>
      )}

      <ModalTransition>
        {confirmOpen && (
          <Modal onClose={() => setConfirmOpen(false)}>
            <ModalHeader>
              <ModalTitle appearance="danger">
                Reclaim seats for {chosen.length} {chosen.length === 1 ? 'user' : 'users'}?
              </ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Stack space="space.150">
                <Text>
                  Each person below is taken out of the listed groups, which removes their Confluence access and frees
                  the seat. Their Atlassian account stays active and their pages keep their name. Before each change
                  the app checks live that the person is still inactive and reads their groups again; anyone who has
                  contributed since the scan is skipped. Afterwards it asks Confluence to confirm the seat is free. You
                  can undo any of it from the History tab.
                </Text>
                <DynamicTable
                  head={{
                    cells: [
                      { key: 'u', content: 'User' },
                      { key: 'g', content: 'Leaves groups' },
                    ],
                  }}
                  rows={chosen.map((u) => ({
                    key: u.accountId,
                    cells: [
                      { key: 'u', content: u.displayName },
                      { key: 'g', content: u.pending ? 'Read live when reclaiming' : join(u.removeGroups) },
                    ],
                  }))}
                  rowsPerPage={10}
                />
              </Stack>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button appearance="danger" onClick={runReclaim}>
                Reclaim {chosen.length} {chosen.length === 1 ? 'seat' : 'seats'}
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </Stack>
  );
}

/** What a reclaim run did, with Confluence's own answers. */
function Outcome({ outcome }) {
  const { results, before, after } = outcome;
  const done = results.filter((r) => r.ok);
  const confirmed = done.filter((r) => r.seatFreed === true);
  const stillAccess = results.filter((r) => r.seatFreed === false);
  const skipped = results.filter((r) => !r.ok && r.skipped);
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const countsKnown = Boolean(before?.exact && after?.exact);

  return (
    <SectionMessage
      appearance={failed.length || stillAccess.length ? 'warning' : 'success'}
      title={`Reclaimed seats for ${done.length} of ${results.length} ${results.length === 1 ? 'user' : 'users'}`}
    >
      <Stack space="space.100">
        {confirmed.length > 0 && (
          <Text>
            Confluence confirms{' '}
            {confirmed.length === done.length
              ? done.length === 1
                ? 'this seat is'
                : `all ${done.length} seats are`
              : `${confirmed.length} of ${done.length} seats are`}{' '}
            free.
          </Text>
        )}
        {countsKnown && (
          <Text>
            Confluence now counts {after.count} {after.count === 1 ? 'account' : 'accounts'} that can use the site
            {before.count !== after.count ? ` (was ${before.count}).` : ' (unchanged so far; it usually updates within a minute).'}
          </Text>
        )}
        {stillAccess.map((r) => (
          <Text key={r.accountId}>
            {r.displayName} left {join(r.groupsLeft)} but Confluence still reports they can use the site
            {r.remainingGroups?.length ? ` — remaining groups: ${join(r.remainingGroups)}` : ''}. Check Atlassian
            Administration → Products → Confluence → Product access.
          </Text>
        ))}
        {skipped.map((r) => (
          <Text key={r.accountId}>
            Skipped {r.displayName}: {r.error}
          </Text>
        ))}
        {failed.map((r) => (
          <Text key={r.accountId}>
            Not done for {r.displayName ?? r.accountId}: {r.error}
          </Text>
        ))}
        {done.length > 0 && <Text>Every change is in the History tab, where you can undo it.</Text>}
      </Stack>
    </SectionMessage>
  );
}

// ---------------------------------------------------------------------------
// History tab
// ---------------------------------------------------------------------------

const STATUS = {
  reclaimed: { text: 'Reclaimed', appearance: 'success' },
  partial: { text: 'Partly reclaimed', appearance: 'moved' },
  restored: { text: 'Undone', appearance: 'default' },
};

function HistoryPanel({ version, onChanged }) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(0);
  const [working, setWorking] = useState(null);
  const [message, setMessage] = useState(null);

  const load = useCallback(async (p) => {
    try {
      const res = await invoke('getHistory', { page: p });
      setData(res);
      setPage(p);
    } catch (err) {
      setMessage(`Could not load the history: ${err?.message ?? 'no response'}.`);
    }
  }, []);

  useEffect(() => {
    load(0);
  }, [load, version]);

  const undo = async (entry) => {
    setWorking(entry.id);
    setMessage(null);
    try {
      const res = await invoke('undo', { entryId: entry.id });
      if (!res?.ok) setMessage(`Undo was not complete for ${entry.displayName}: ${res?.error ?? 'unknown error'}`);
      await load(page);
      onChanged?.();
    } catch (err) {
      setMessage(`Undo failed: ${err?.message ?? 'no response'}.`);
    } finally {
      setWorking(null);
    }
  };

  if (data?.forbidden) {
    return (
      <SectionMessage appearance="error" title="Access denied">
        <Text>{data.error}</Text>
      </SectionMessage>
    );
  }

  const entries = data?.entries ?? [];
  return (
    <Stack space="space.200">
      <Text>
        Every reclaim, who approved it and which groups each person left. Undo puts the person back in exactly those
        groups.
      </Text>
      {message && (
        <SectionMessage appearance="warning">
          <Text>{message}</Text>
        </SectionMessage>
      )}
      {!data ? (
        <Spinner />
      ) : entries.length === 0 ? (
        <Text>Nothing reclaimed yet.</Text>
      ) : (
        <DynamicTable
          head={{
            cells: [
              { key: 'when', content: 'When (UTC)' },
              { key: 'user', content: 'User' },
              { key: 'groups', content: 'Groups left' },
              { key: 'by', content: 'Approved by' },
              { key: 'status', content: 'Status' },
              { key: 'act', content: '' },
            ],
          }}
          rows={entries.map((e) => {
            const st = STATUS[e.status] ?? { text: e.status, appearance: 'default' };
            return {
              key: e.id,
              cells: [
                { key: 'when', content: fmtTime(e.at) },
                { key: 'user', content: e.displayName },
                { key: 'groups', content: join((e.groups ?? []).filter((g) => g.ok).map((g) => g.name)) },
                { key: 'by', content: e.byName ?? '—' },
                {
                  key: 'status',
                  content: (
                    <Stack space="space.050">
                      <Lozenge appearance={st.appearance}>{st.text}</Lozenge>
                      {e.status !== 'restored' && e.seatFreed === true && <Text size="small">Confluence confirmed the seat is free</Text>}
                      {e.status !== 'restored' && e.seatFreed === false && (
                        <Text size="small">Confluence still reported access afterwards</Text>
                      )}
                      {e.status === 'restored' && (
                        <Text size="small">
                          {fmtTime(e.restoredAt)} by {e.restoredByName ?? '—'}
                        </Text>
                      )}
                    </Stack>
                  ),
                },
                {
                  key: 'act',
                  content:
                    e.status === 'restored' ? null : (
                      <Button spacing="compact" onClick={() => undo(e)} isDisabled={Boolean(working)}>
                        {working === e.id ? 'Undoing…' : 'Undo'}
                      </Button>
                    ),
                },
              ],
            };
          })}
        />
      )}
      {data?.pages > 1 && (
        <Inline space="space.100" alignBlock="center">
          <Button isDisabled={page === 0} onClick={() => load(page - 1)}>
            Newer
          </Button>
          <Text>
            Page {page + 1} of {data.pages}
          </Text>
          <Button isDisabled={page >= data.pages - 1} onClick={() => load(page + 1)}>
            Older
          </Button>
        </Inline>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const App = () => {
  const [ctx, setCtx] = useState(null);
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [access, setAccess] = useState(null);

  useEffect(() => {
    view
      .getContext()
      .then(setCtx)
      .catch(() => setCtx({}));
    // One cheap call up front tells us whether this person may use the app.
    invoke('getStatus')
      .then(setAccess)
      .catch(() => setAccess({}));
  }, []);

  const gate = licenseGate(ctx?.license, ctx?.environmentType);
  const trialEnds =
    gate.reason === 'trial' && ctx?.license?.trialEndDate
      ? new Date(ctx.license.trialEndDate).toISOString().slice(0, 10)
      : null;

  if (access?.forbidden) {
    return (
      <SectionMessage appearance="error" title="Access denied">
        <Text>{access.error}</Text>
      </SectionMessage>
    );
  }

  return (
    <Stack space="space.200">
      {!gate.allowed && (
        <SectionMessage appearance="warning" title="Subscription needed">
          <Text>{licenseMessage(gate, ctx?.license)}</Text>
        </SectionMessage>
      )}
      {trialEnds && (
        <SectionMessage appearance="information">
          <Text>Your free trial runs until {trialEnds}.</Text>
        </SectionMessage>
      )}
      <Tabs id="seat-reclaim-tabs">
        <TabList>
          <Tab>Inactive users</Tab>
          <Tab>History</Tab>
        </TabList>
        <TabPanel>
          <Box xcss={{ paddingTop: 'space.200', width: '100%' }}>
            <AuditPanel gate={gate} version={version} onChanged={bump} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={{ paddingTop: 'space.200', width: '100%' }}>
            <HistoryPanel version={version} onChanged={bump} />
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
