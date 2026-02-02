// ==UserScript==
// @name         GitHub PR Copilot fix failing checks button
// @author       felickz
// @namespace    https://github.com/felickz
// @version      0.1.4
// @license     MIT
// @description  Adds a button near Merge/Auto-merge controls. On click: collects failing check run/job URLs and posts a comment to @copilot.
// @match        https://github.com/*/*/pull/*
// @run-at       document-idle
// @grant        none
// @icon         https://github.githubassets.com/pinned-octocat.svg
// @updateURL    https://raw.githubusercontent.com/felickz/GitHub-UserScripts/main/github-pr-copilot-fix-failing-checks-button.user.js
// @downloadURL  https://raw.githubusercontent.com/felickz/GitHub-UserScripts/main/github-pr-copilot-fix-failing-checks-button.user.js
// ==/UserScript==

(function () {
  'use strict';

  const BUTTON_ID = 'tm-copilot-fix-ci-btn';
  const DEBUG = true;
  const NS = '[COPILOT-FIX-CI]';

  // Anchor text variants (merge box button text differs by repo/settings)
  const MERGE_TEXTS = [
    'Merge pull request',
    'Enable auto-merge',
    'Enable auto-merge…',
    'Auto-merge',
    'Squash and merge',
    'Disable auto-merge',
  ];

  const log = (...a) => DEBUG && console.log(NS, ...a);

  function uniq(arr) {
    return [...new Set(arr)];
  }

  function createButton() {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';

    // Orange-ish button
    btn.style.background = '#f59e0b';
    btn.style.border = '1px solid #b45309';
    btn.style.color = '#111827';
    btn.style.borderRadius = '6px';
    btn.style.padding = '6px 12px';
    btn.style.fontWeight = '700';
    btn.style.fontSize = '12px';
    btn.style.lineHeight = '20px';
    btn.style.whiteSpace = 'nowrap';
    btn.style.marginRight = '8px';
    btn.style.cursor = 'pointer';

    // Icon + label
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.gap = '6px';

    const img = document.createElement('img');
    img.className = 'emoji';
    img.title = ':copilot:';
    img.alt = ':copilot:';
    img.src = 'https://github.githubassets.com/images/icons/emoji/copilot.png';
    img.width = 20;
    img.height = 20;

    const label = document.createElement('span');
    label.setAttribute('data-tm', 'label');
    label.textContent = 'ASK COPILOT: FIX CI';

    btn.appendChild(img);
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      run(btn).catch((e) => {
        console.error(NS, e);
        alert(`${NS} failed: ${e?.message || e}`);
        btn.disabled = false;
        label.textContent = 'ASK COPILOT: FIX CI';
        btn.style.opacity = '1';
      });
    });

    return btn;
  }

  function setButtonLabel(btn, text) {
    const label = btn.querySelector('[data-tm="label"]');
    if (label) label.textContent = text;
    else btn.textContent = text;
  }

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
    if (!labelNode) return false;

    const mergeGroup =
      labelNode.closest('.prc-ButtonGroup-ButtonGroup-vFUrY') ||
      labelNode.closest('[class*="ButtonGroup"]') ||
      labelNode.closest('div');

    if (!mergeGroup) return false;

    const hostRow = mergeGroup.parentElement;
    if (!hostRow) return false;

    hostRow.insertBefore(createButton(), mergeGroup);
    return true;
  }

  // ---- UPDATED failing URL collector (uses your failing checks group) ----
  function getFailingChecksGroup() {
    // Prefer the ARIA-labeled group (stable):
    // <div aria-label="failing checks" role="group" ...>
    return (
      document.querySelector('div[role="group"][aria-label="failing checks"]') ||
      // fallback (your example id)
      document.querySelector('#_r_2q_') ||
      null
    );
  }

  function collectFailingCheckUrls() {
    const group = getFailingChecksGroup();
    log('failing checks group:', group);

    if (!group) return [];

    // Primary: grab the run/job anchors inside that group.
    // Your example:
    //  a.Title-module__anchor... href="/.../actions/runs/.../job/...?pr=42"
    const anchors = Array.from(
      group.querySelectorAll('a[href*="/actions/runs/"], a[href*="/actions/runs/"][href*="/job/"]')
    );

    // Fallback: use your specific selector pattern (id is dynamic though)
    const anchors2 = anchors.length
      ? anchors
      : Array.from(group.querySelectorAll('h4 a[href], a.Title-module__anchor--GmXUE[href]'));

    const urls = anchors2
      .map((a) => a.getAttribute('href'))
      .filter(Boolean)
      .map((href) => (href.startsWith('http') ? href : new URL(href, location.origin).toString()));

    return uniq(urls);
  }

  function buildComment(urls) {
    const inside = urls.length ? urls.join(' ') : '(no failing check URLs found)';
    return `@copilot fix the failing CI (${inside}) for this PR`;
  }

  function findCommentTextarea() {
    return document.querySelector('#new_comment_field');
  }

  function findCommentSubmitButton() {
    const buttons = Array.from(document.querySelectorAll('button[type="submit"]'));
    return buttons.find((b) => (b.textContent || '').trim() === 'Comment') || null;
  }

  function setTextareaValue(textarea, value) {
    textarea.focus();
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function run(btn) {
    btn.disabled = true;
    btn.style.opacity = '0.75';
    setButtonLabel(btn, 'COLLECTING…');

    const urls = collectFailingCheckUrls();
    log('Collected failing URLs:', urls);

    setButtonLabel(btn, 'COMMENTING…');

    const textarea = findCommentTextarea();
    if (!textarea) throw new Error('Could not find comment textarea: #new_comment_field');

    const submit = findCommentSubmitButton();
    if (!submit) throw new Error('Could not find the "Comment" submit button');

    setTextareaValue(textarea, buildComment(urls));

    await new Promise((r) => setTimeout(r, 250));
    submit.click();

    setButtonLabel(btn, 'ASK COPILOT: FIX CI');
    btn.disabled = false;
    btn.style.opacity = '1';
  }

  function start() {
    let tries = 0;
    const poll = setInterval(() => {
      tries += 1;
      const ok = injectButtonIfPossible();
      if (ok || tries > 120) clearInterval(poll);
    }, 500);

    const obs = new MutationObserver(() => injectButtonIfPossible());
    obs.observe(document.documentElement, { childList: true, subtree: true });

    window.__copilotFixCI = {
      group: () => getFailingChecksGroup(),
      urls: () => collectFailingCheckUrls(),
      comment: () => buildComment(collectFailingCheckUrls()),
    };
  }

  setTimeout(start, 800);
})();
