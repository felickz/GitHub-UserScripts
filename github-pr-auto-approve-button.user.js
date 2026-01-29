// ==UserScript==
// @name         GitHub PR Auto Approve Button
// @author       felickz
// @namespace    https://github.com/felickz
// @version      1.3.1
// @license      MIT
// @description  Adds an "AUTO-APPROVE" button next to Merge/Auto-merge controls; on click, navigates to Files changed and submits an approve review with a comment.
// @match        https://github.com/*/*/pull/*
// @run-at       document-idle
// @grant        none
// @icon         https://github.githubassets.com/pinned-octocat.svg
// @updateURL    https://raw.githubusercontent.com/felickz/GitHub-UserScripts/main/github-pr-auto-approve-button.user.js
// @downloadURL  https://raw.githubusercontent.com/felickz/GitHub-UserScripts/main/github-pr-auto-approve-button.user.js
// ==/UserScript==

(function () {
  'use strict';

  const COMMENT_TEXT = ':dependabot: :+1:';
  const MAX_WAIT_MS = 30000;
  const BUTTON_ID = 'tm-auto-approve-btn';

  const DEBUG = true;
  const NS = '[AUTO-APPROVE]';

  function log(...args) { if (DEBUG) console.log(NS, ...args); }
  function info(...args) { if (DEBUG) console.info(NS, ...args); }
  function warn(...args) { if (DEBUG) console.warn(NS, ...args); }
  function err(...args) { if (DEBUG) console.error(NS, ...args); }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForSelector(selector, { timeoutMs = MAX_WAIT_MS, root = document } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = root.querySelector(selector);
      if (el) return el;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for selector: ${selector}`);
  }

  function getPrNumberFromUrl() {
    const m = location.pathname.match(/\/pull\/(\d+)(\/|$)/);
    return m ? m[1] : null;
  }

  function isPullRequestPage() {
    return /\/pull\/\d+/.test(location.pathname);
  }

  function isFilesChangedTab() {
    return /\/pull\/\d+\/files/.test(location.pathname);
  }

  function isDependabotAuthor() {
    const authorLink =
      document.querySelector('a.author') ||
      document.querySelector('a[href*="dependabot%5Bbot%5D"], a[href*="dependabot[bot]"]');
    const text = authorLink?.textContent?.trim() || '';
    return text.toLowerCase() === 'dependabot[bot]' || text.toLowerCase() === 'dependabot';
  }

  function setButtonState(btn, { busy, text } = {}) {
    if (!btn) return;
    if (typeof text === 'string') btn.textContent = text;
    btn.disabled = !!busy;
    btn.style.opacity = busy ? '0.7' : '1';
    btn.style.cursor = busy ? 'progress' : 'pointer';
  }

  // ===== Button color logic =====
  const COLORS = {
    gray:   { bg: '#9ca3af', border: '#6b7280', fg: '#111827' }, // default/unknown
    yellow: { bg: '#f59e0b', border: '#b45309', fg: '#111827' }, // neutral checks present
    red:    { bg: '#ef4444', border: '#991b1b', fg: '#111827' }, // failing checks present
  };

  function applyButtonColor(btn, kind, reasonText) {
    const c = COLORS[kind] || COLORS.gray;
    btn.style.background = c.bg;
    btn.style.border = `1px solid ${c.border}`;
    btn.style.color = c.fg;
    btn.dataset.tmColor = kind;
    btn.title = reasonText ? `AUTO-APPROVE (${reasonText})` : 'AUTO-APPROVE';
  }

  function getChecksSummaryFromDOM() {
    // Strategy:
    // - Search for label spans in the checks area whose text ends with:
    //     "failing check(s)" or "neutral check(s)"
    // - If any failing -> red
    // - else if any neutral -> yellow
    // - else -> gray

    const spans = Array.from(document.querySelectorAll('span.prc-Button-Label-FWkx3, span[data-component="text"]'));
    const texts = spans.map(s => (s.textContent || '').trim()).filter(Boolean);

    const failing = texts.filter(t => /\bfailing checks?\b/i.test(t));
    const neutral = texts.filter(t => /\bneutral checks?\b/i.test(t));

    // Example matches you gave:
    // "2 failing checks"
    // "1 neutral check"
    if (failing.length > 0) return { status: 'failing', matched: failing[0], all: texts };
    if (neutral.length > 0) return { status: 'neutral', matched: neutral[0], all: texts };
    return { status: 'unknown', matched: null, all: texts };
  }

  function updateButtonColorFromChecks(btn) {
    if (!btn) return;

    const summary = getChecksSummaryFromDOM();
    if (summary.status === 'failing') {
      applyButtonColor(btn, 'red', summary.matched);
      log('Button color -> RED (failing checks). Matched:', summary.matched);
    } else if (summary.status === 'neutral') {
      applyButtonColor(btn, 'yellow', summary.matched);
      log('Button color -> YELLOW (neutral checks). Matched:', summary.matched);
    } else {
      applyButtonColor(btn, 'gray', 'no failing/neutral checks label found');
      log('Button color -> GRAY (default/unknown).');
    }
  }

  async function goToFilesChanged() {
    info('goToFilesChanged()', { href: location.href, isFiles: isFilesChangedTab() });

    if (isFilesChangedTab()) return;

    const tab =
      document.querySelector('a[data-tab-item="i2files-tab"]') ||
      document.querySelector('a#files-tab') ||
      document.querySelector('a[href$="/files"], a[href*="/pull/"][href$="/files"]');

    info('Files tab element:', tab);

    if (tab) {
      tab.click();
      const start = Date.now();
      while (Date.now() - start < MAX_WAIT_MS) {
        if (isFilesChangedTab()) return;
        await sleep(100);
      }
    }

    const prNumber = getPrNumberFromUrl();
    if (!prNumber) throw new Error('Could not determine PR number from URL.');
    const base = location.origin + location.pathname.replace(/\/pull\/\d+.*/, `/pull/${prNumber}`);
    location.assign(base + '/files');
  }

  async function openReviewChangesOverlay() {
    await waitForSelector('span.js-review-changes, button.js-review-changes');
    const el = document.querySelector('span.js-review-changes, button.js-review-changes');
    info('Review changes element:', el);
    el.click();
  }

  async function fillAndApproveAndSubmit() {
    const textarea = await waitForSelector('#pull_request_review_body');
    textarea.focus();
    textarea.value = COMMENT_TEXT;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    const approveRadio = await waitForSelector('#pull_request_review\\[event\\]_approve');
    approveRadio.click();

    let submitBtn =
      document.querySelector('#pull_requests_submit_review button[type="submit"]') ||
      document.querySelector('form#pull_requests_submit_review button[type="submit"]') ||
      document.querySelector('#pull_requests_submit_review button');

    info('Submit button:', submitBtn);
    if (!submitBtn) throw new Error('Could not find submit review button.');

    submitBtn.click();
  }

  async function runAutoApprove(btn) {
    if (!isPullRequestPage()) return;

    const prNumber = getPrNumberFromUrl();
    if (!prNumber) {
      alert('AUTO-APPROVE: Could not determine PR number from URL.');
      return;
    }

    info('runAutoApprove()', { prNumber, href: location.href, dependabot: isDependabotAuthor() });

    if (!isDependabotAuthor()) {
      const ok = confirm('This does not look like a Dependabot PR. Run AUTO-APPROVE anyway?');
      if (!ok) return;
    }

    try {
      setButtonState(btn, { busy: true, text: 'AUTO-APPROVING…' });

      setButtonState(btn, { busy: true, text: 'Opening Files changed…' });
      await goToFilesChanged();

      setButtonState(btn, { busy: true, text: 'Opening Review changes…' });
      await openReviewChangesOverlay();

      setButtonState(btn, { busy: true, text: 'Submitting approval…' });
      await fillAndApproveAndSubmit();

      setButtonState(btn, { busy: false, text: 'AUTO-APPROVE' });
      info('Done.');
    } catch (e) {
      err('Error:', e);
      setButtonState(btn, { busy: false, text: 'AUTO-APPROVE' });
      alert(`AUTO-APPROVE failed: ${e?.message || e}`);
    }
  }

  function createButton() {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = 'AUTO-APPROVE';

    btn.style.borderRadius = '6px';
    btn.style.padding = '6px 12px';
    btn.style.fontWeight = '700';
    btn.style.fontSize = '12px';
    btn.style.lineHeight = '20px';
    btn.style.whiteSpace = 'nowrap';
    btn.style.marginRight = '8px';

    // Start GRAY by default (per your request)
    applyButtonColor(btn, 'gray', 'default');

    btn.addEventListener('click', () => runAutoApprove(btn));
    return btn;
  }

  // Anchor text variants (merge box button text differs by repo/settings)
  const MERGE_TEXTS = [
    'Merge pull request',
    'Enable auto-merge',
    'Enable auto-merge…',
    'Auto-merge',
    'Squash and merge',
  ];

  function findMergeControlsLabelNode() {
    const nodes = Array.from(document.querySelectorAll('button, span, div'));
    for (const n of nodes) {
      const t = (n.textContent || '').trim();
      if (MERGE_TEXTS.includes(t)) return n;
    }
    return null;
  }

  function injectButtonIfPossible() {
    if (document.getElementById(BUTTON_ID)) return true;

    const labelNode = findMergeControlsLabelNode();
    if (!labelNode) {
      log('inject: merge/auto-merge label not found yet (looking for one of):', MERGE_TEXTS);
      return false;
    }

    const mergeGroup =
      labelNode.closest('.prc-ButtonGroup-ButtonGroup-vFUrY') ||
      labelNode.closest('[class*="ButtonGroup"]') ||
      labelNode.closest('div');

    if (!mergeGroup) {
      warn('inject: found label node but could not find mergeGroup container.', labelNode);
      return false;
    }

    const hostRow = mergeGroup.parentElement;
    if (!hostRow) return false;

    hostRow.insertBefore(createButton(), mergeGroup);
    info('Injected AUTO-APPROVE button. Matched label:', (labelNode.textContent || '').trim());

    // Set color immediately after injection (merge box may already show checks)
    updateButtonColorFromChecks(document.getElementById(BUTTON_ID));
    return true;
  }

  function start() {
    info('Loaded on', location.href);

    // Poll because merge/auto-merge box and checks appear late.
    let tries = 0;
    const poll = setInterval(() => {
      tries += 1;

      const injected = injectButtonIfPossible();

      const btn = document.getElementById(BUTTON_ID);
      if (btn) updateButtonColorFromChecks(btn);

      if (injected && tries > 10) {
        // Keep polling a bit longer to catch checks rendering, then stop.
        // (MutationObserver will still handle subsequent DOM changes.)
        // ~5s after injection
        clearInterval(poll);
      }

      if (tries > 120) clearInterval(poll); // ~60s hard stop
    }, 500);

    const obs = new MutationObserver(() => {
      const injected = injectButtonIfPossible();
      const btn = document.getElementById(BUTTON_ID);
      if (btn) updateButtonColorFromChecks(btn);
      if (injected) log('observer: injected or updated');
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    // Console helper
    window.__autoApprove = {
      tryInject: () => injectButtonIfPossible(),
      refreshColor: () => {
        const btn = document.getElementById(BUTTON_ID);
        if (btn) updateButtonColorFromChecks(btn);
        return {
          hasButton: !!btn,
          color: btn?.dataset?.tmColor || null,
          summary: getChecksSummaryFromDOM(),
        };
      },
      debug: () => ({
        href: location.href,
        labelFound: !!findMergeControlsLabelNode(),
        labelText: findMergeControlsLabelNode()?.textContent?.trim() || null,
        hasButton: !!document.getElementById(BUTTON_ID),
        buttonColor: document.getElementById(BUTTON_ID)?.dataset?.tmColor || null,
        checks: getChecksSummaryFromDOM(),
      }),
    };
  }

  setTimeout(start, 800);
})();
