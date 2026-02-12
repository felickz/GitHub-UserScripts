// ==UserScript==
// @name         GitHub Issue Timeline Load All
// @author       felickz
// @namespace    https://github.com/felickz
// @version      0.1.1
// @license      MIT
// @description  Adds a "Load All" button next to GitHub's "Load more" on issue/PR timelines. Intercepts the GraphQL pagination request to set the count equal to the remaining items, and auto-retries until all history is loaded.
// @match        https://github.com/*/*/issues/*
// @match        https://github.com/*/*/pull/*
// @run-at       document-idle
// @grant        none
// @icon         https://github.githubassets.com/pinned-octocat.svg
// @updateURL    https://raw.githubusercontent.com/felickz/GitHub-UserScripts/main/github-issue-timeline-load-all.user.js
// @downloadURL  https://raw.githubusercontent.com/felickz/GitHub-UserScripts/main/github-issue-timeline-load-all.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────────────
  const NS = '[LOAD-ALL-TIMELINE]';
  const DEBUG = true;
  const DEFAULT_BATCH_SIZE = 150;
  const MAX_GRAPHQL_COUNT = 250; // GitHub API hard limit on `first`
  const MAX_RETRY_ITERATIONS = 50;
  const MAX_RETRY_TOTAL_MS = 120_000; // 2 minutes hard stop
  const POLL_AFTER_CLICK_MS = 2000; // wait for DOM to settle after each click
  const GRAPHQL_QUERY_NAME = 'NewTimelinePaginationFrontQuery';

  // Button IDs (per position: load-top / load-bottom)
  const BUTTON_ID_PREFIX = 'tm-load-all-btn-';

  // Module-level flag: when set to a positive number, the fetch interceptor
  // will override the `count` variable in the next matching GraphQL request.
  let pendingLoadAllCount = 0;

  // ─── Logging helpers ────────────────────────────────────────────────
  const log = (...a) => DEBUG && console.log(NS, ...a);
  const warn = (...a) => DEBUG && console.warn(NS, ...a);
  const err = (...a) => DEBUG && console.error(NS, ...a);

  // ─── Fetch interceptor ─────────────────────────────────────────────
  function installFetchInterceptor() {
    if (window.__loadAllFetchPatched) return;
    window.__loadAllFetchPatched = true;

    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      try {
        let [resource, init] = args;
        if (
          pendingLoadAllCount > 0 &&
          typeof resource === 'string' &&
          resource.includes('/_graphql') &&
          resource.includes(GRAPHQL_QUERY_NAME)
        ) {
          const url = new URL(resource, location.origin);
          const bodyParam = url.searchParams.get('body');
          if (bodyParam) {
            const body = JSON.parse(bodyParam);
            const originalCount = body.variables?.count;
            const requestCount = Math.min(pendingLoadAllCount, MAX_GRAPHQL_COUNT);
            body.variables.count = requestCount;
            log(
              `Intercepted GraphQL request: count ${originalCount} → ${requestCount} (requested ${pendingLoadAllCount}, capped at ${MAX_GRAPHQL_COUNT})`
            );
            url.searchParams.set('body', JSON.stringify(body));
            pendingLoadAllCount = 0; // consume the flag
            return originalFetch.call(this, url.toString(), init);
          }
        }
      } catch (e) {
        err('Fetch interceptor error (passing through):', e);
      }
      return originalFetch.apply(this, args);
    };
    log('Fetch interceptor installed');
  }

  // ─── DOM helpers ────────────────────────────────────────────────────

  /**
   * Find all "Load more" buttons on the timeline (top and/or bottom).
   * Returns an array of { button, position } objects.
   */
  function findLoadMoreButtons() {
    const results = [];
    for (const pos of ['load-top', 'load-bottom']) {
      const btn = document.querySelector(
        `button[data-testid="issue-timeline-load-more-${pos}"]`
      );
      if (btn) results.push({ button: btn, position: pos });
    }
    return results;
  }

  /**
   * Read the remaining-items count from the sibling <span> element.
   * e.g. <span data-testid="issue-timeline-load-more-count-load-top">241</span>
   */
  function getRemainingCount(position) {
    const span = document.querySelector(
      `span[data-testid="issue-timeline-load-more-count-${position}"]`
    );
    if (span) {
      const n = parseInt(span.textContent.trim().replace(/,/g, ''), 10);
      if (!isNaN(n) && n > 0) return n;
    }
    // Fallback: try to parse from the generic "N remaining items" text nearby
    const wrappers = document.querySelectorAll(
      'div[class*="LoadMore-module"]'
    );
    for (const w of wrappers) {
      const match = w.textContent.match(/(\d[\d,]*)\s*remaining/i);
      if (match) {
        const n = parseInt(match[1].replace(/,/g, ''), 10);
        if (!isNaN(n) && n > 0) return n;
      }
    }
    return null;
  }

  /**
   * Update the text inside the original "Load more" button to show the batch size.
   */
  function relabelLoadMoreButton(button) {
    const innerDiv = button.querySelector(
      'div[class*="LoadMore-module__buttonChildrenWrapper"]'
    );
    const target = innerDiv || button;
    const currentText = target.textContent.trim();
    // Only relabel if not already relabeled
    if (currentText === 'Load more') {
      target.textContent = `Load more (${DEFAULT_BATCH_SIZE})`;
      log('Relabeled "Load more" →', target.textContent);
    }
  }

  // ─── "Load All" button creation ────────────────────────────────────

  function createLoadAllButton(position, remainingCount) {
    const btn = document.createElement('button');
    btn.id = `${BUTTON_ID_PREFIX}${position}`;
    btn.type = 'button';
    btn.textContent = `Load All (${remainingCount ?? '?'})`;

    // Distinct green styling (GitHub's green)
    Object.assign(btn.style, {
      background: '#2ea44f',
      border: '1px solid #22863a',
      color: '#ffffff',
      borderRadius: '6px',
      padding: '6px 12px',
      fontWeight: '700',
      fontSize: '12px',
      lineHeight: '20px',
      cursor: 'pointer',
      marginLeft: '8px',
      verticalAlign: 'middle',
    });

    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#2c974b';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#2ea44f';
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleLoadAll(position, btn);
    });

    return btn;
  }

  // ─── Load All click handler (with auto-retry loop) ─────────────────

  async function handleLoadAll(position, loadAllBtn) {
    const startTime = Date.now();
    let iteration = 0;
    loadAllBtn.disabled = true;
    loadAllBtn.style.opacity = '0.7';
    loadAllBtn.style.cursor = 'wait';

    try {
      while (iteration < MAX_RETRY_ITERATIONS) {
        if (Date.now() - startTime > MAX_RETRY_TOTAL_MS) {
          warn('Safety timeout reached after', iteration, 'iterations');
          break;
        }
        iteration++;

        // Re-query the load-more button (DOM may have been replaced)
        const loadMoreBtn = document.querySelector(
          `button[data-testid="issue-timeline-load-more-${position}"]`
        );
        if (!loadMoreBtn) {
          log('No more "Load more" button found — all items loaded!');
          break;
        }

        // Re-read remaining count
        const remaining = getRemainingCount(position);
        if (!remaining || remaining <= 0) {
          log('Remaining count is 0 or unreadable — done.');
          break;
        }

        log(
          `Iteration ${iteration}: ${remaining} items remaining, requesting all...`
        );
        loadAllBtn.textContent = `Loading... (${remaining} left)`;

        // Set the fetch-interceptor flag
        pendingLoadAllCount = remaining;

        // Click the original "Load more" button
        loadMoreBtn.click();

        // Wait for the request to complete and DOM to update
        await new Promise((r) => setTimeout(r, POLL_AFTER_CLICK_MS));

        // Adaptive wait: keep waiting if the button still shows the same count
        let waited = POLL_AFTER_CLICK_MS;
        const maxAdaptiveWait = 15_000;
        while (waited < maxAdaptiveWait) {
          const newRemaining = getRemainingCount(position);
          const btnStillExists = document.querySelector(
            `button[data-testid="issue-timeline-load-more-${position}"]`
          );
          if (!btnStillExists || newRemaining !== remaining) break;
          await new Promise((r) => setTimeout(r, 1000));
          waited += 1000;
        }
      }

      // Final status
      const finalBtn = document.querySelector(
        `button[data-testid="issue-timeline-load-more-${position}"]`
      );
      if (!finalBtn) {
        log('All timeline items loaded successfully!');
        loadAllBtn.textContent = 'All loaded ✓';
        loadAllBtn.style.background = '#1a7f37';
        setTimeout(() => {
          loadAllBtn.remove();
        }, 3000);
      } else {
        const leftover = getRemainingCount(position);
        warn(`Stopped with ${leftover ?? '?'} items still remaining.`);
        loadAllBtn.textContent = `Load All (${leftover ?? '?'})`;
        loadAllBtn.disabled = false;
        loadAllBtn.style.opacity = '1';
        loadAllBtn.style.cursor = 'pointer';
      }
    } catch (e) {
      err('Error during Load All:', e);
      loadAllBtn.textContent = 'Error — retry?';
      loadAllBtn.disabled = false;
      loadAllBtn.style.opacity = '1';
      loadAllBtn.style.cursor = 'pointer';
    }
  }

  // ─── Injection logic ───────────────────────────────────────────────

  function injectLoadAllButton(button, position) {
    const btnId = `${BUTTON_ID_PREFIX}${position}`;
    if (document.getElementById(btnId)) return; // already injected

    const remaining = getRemainingCount(position);
    log(`Found "Load more" (${position}), remaining: ${remaining}`);

    // Relabel the original button
    relabelLoadMoreButton(button);

    // Create and insert the Load All button
    const loadAllBtn = createLoadAllButton(position, remaining);
    const wrapper = button.closest(
      'div[class*="LoadMore-module__buttonWrapper"]'
    );
    if (wrapper) {
      wrapper.style.display = 'flex';
      wrapper.style.alignItems = 'center';
      wrapper.style.justifyContent = 'center';
      wrapper.style.gap = '8px';
      wrapper.appendChild(loadAllBtn);
    } else {
      // Fallback: insert right after the button
      button.parentElement.insertBefore(loadAllBtn, button.nextSibling);
    }
    log(`Injected "Load All" button for ${position}`);
  }

  function scanAndInject() {
    const buttons = findLoadMoreButtons();
    for (const { button, position } of buttons) {
      injectLoadAllButton(button, position);
    }
  }

  // ─── Entry point ───────────────────────────────────────────────────

  function start() {
    log('Starting...');
    installFetchInterceptor();

    // Initial scan
    scanAndInject();

    // MutationObserver for SPA navigation and late-rendered DOM
    const observer = new MutationObserver(() => {
      scanAndInject();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    log('MutationObserver active');
  }

  // Expose debug object
  window.__loadAllTimeline = {
    scanAndInject,
    findLoadMoreButtons,
    getRemainingCount,
    get pendingCount() {
      return pendingLoadAllCount;
    },
    set pendingCount(v) {
      pendingLoadAllCount = v;
    },
  };

  setTimeout(start, 800);
})();
