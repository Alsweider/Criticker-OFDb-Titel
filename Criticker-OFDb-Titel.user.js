// ==UserScript==
// @name         Criticker-OFDb-Titel
// @namespace    https://criticker.com/
// @version      2026-05-11
// @description  Ruft deutsche Filmtitel von ofdb.de ab und zeigt sie auf Criticker als Untertitel an.
// @author       Alsweider
// @match        https://www.criticker.com/film/*
// @match        https://www.criticker.com/tv/*
// @icon         https://www.criticker.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      www.ofdb.de
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/558803/Criticker-OFDb-Titel.user.js
// @updateURL https://update.greasyfork.org/scripts/558803/Criticker-OFDb-Titel.meta.js
// ==/UserScript==

(function () {
    'use strict';

    const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage
    const TIMEOUT_MS   = 180000;
    const OFDB_BASE    = 'https://www.ofdb.de';
    const ELEM_ID      = 'ofdb-local-title';

    // --- IMDb-ID ermitteln ---
    const imdbLink = document.querySelector('.tip_sidebar_action a[href*="imdb.com/title/"]');
    if (!imdbLink) return;

    const imdbID = imdbLink.href.match(/tt\d+/)?.[0];
    if (!imdbID) return;

    const cacheKey = `ofdb_${imdbID}`;

    // --- Platzhalter sofort einfügen ---
    const mainTitle = document.querySelector('.tip_title_maininfo h1');
    if (!mainTitle) return;

    const placeholder = createSpan();
    mainTitle.after(placeholder);

    // --- Starten (wird auch beim Reload-Klick erneut aufgerufen) ---
    run();

    function run() {
        setState(placeholder, 'loading');

        const cached = GM_getValue(cacheKey, null);
        if (cached && cached.title && (Date.now() - cached.ts) < CACHE_TTL_MS) {
            setState(placeholder, 'found', cached.title, cached.url);
            return;
        }

        // Direktversuch: OFDb-Seite per IMDb-ID
        const directURL = `${OFDB_BASE}/film/imdb/${imdbID}`;

        GM_xmlhttpRequest({
            method:  'GET',
            url:     directURL,
            timeout: TIMEOUT_MS,
            onload: function (response) {
                if (response.status === 200 && response.finalUrl &&
                    response.finalUrl.includes('/film/')) {
                    const title = extractTitle(response.responseText);
                    if (title) {
                        GM_setValue(cacheKey, { title, url: response.finalUrl, ts: Date.now() });
                        setState(placeholder, 'found', title, response.finalUrl);
                        return;
                    }
                }
                fetchViaSearch();
            },
            onerror:   function () { fetchViaSearch(); },
            ontimeout: function () {
                console.warn('[OFDb-Titel] Direktabruf Timeout – versuche Suche');
                fetchViaSearch();
            }
        });
    }

    // --- Zweistufige Suche (Fallback) ---
    function fetchViaSearch() {
        const searchURL = `${OFDB_BASE}/suchergebnis/?${imdbID}`;

        GM_xmlhttpRequest({
            method:  'GET',
            url:     searchURL,
            timeout: TIMEOUT_MS,
            onload: function (response) {
                const parser = new DOMParser();
                const doc    = parser.parseFromString(response.responseText, 'text/html');
                const anchor = doc.querySelector('#TabelleBody a');
                if (!anchor) {
                    setState(placeholder, 'notfound');
                    return;
                }

                const href    = anchor.getAttribute('href') || '';
                const filmURL = href.startsWith('http') ? href : `${OFDB_BASE}/${href.replace(/^\//, '')}`;

                GM_xmlhttpRequest({
                    method:  'GET',
                    url:     filmURL,
                    timeout: TIMEOUT_MS,
                    onload: function (resp) {
                        const title = extractTitle(resp.responseText);
                        if (title) {
                            GM_setValue(cacheKey, { title, url: filmURL, ts: Date.now() });
                            setState(placeholder, 'found', title, filmURL);
                        } else {
                            setState(placeholder, 'notfound');
                        }
                    },
                    onerror:   function () { setState(placeholder, 'notfound'); },
                    ontimeout: function () {
                        console.warn('[OFDb-Titel] Timeout beim Abruf der Filmseite');
                        setState(placeholder, 'notfound');
                    }
                });
            },
            onerror:   function () { setState(placeholder, 'notfound'); },
            ontimeout: function () {
                console.warn('[OFDb-Titel] Timeout bei der Suche');
                setState(placeholder, 'notfound');
            }
        });
    }

    // --- Hilfsfunktionen ---

    function extractTitle(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const el  = doc.querySelector('h1[itemprop="name"]');
        return el ? el.textContent.trim() : null;
    }

    function createSpan() {
        const existing = document.getElementById(ELEM_ID);
        if (existing) return existing;
        const span = document.createElement('span');
        span.id    = ELEM_ID;
        return span;
    }

    function createReloadButton() {
        const btn = document.createElement('button');
        btn.textContent   = '↺';
        btn.title         = 'Neu laden (Cache leeren)';
        btn.style.cssText =
            'display:inline; margin-left:6px; background:none; border:none; cursor:pointer;' +
            'color:#aaa; font-size:1em; padding:0; line-height:1;' +
            'vertical-align:middle;';
        btn.addEventListener('mouseenter', () => btn.style.color = '#555');
        btn.addEventListener('mouseleave', () => btn.style.color = '#aaa');
        btn.addEventListener('click', () => {
            GM_deleteValue(cacheKey);
            run();
        });
        return btn;
    }

    /**
     * Setzt den visuellen Zustand des Platzhalters.
     *
     * 'loading'  → Ladehinweis, kein Button
     * 'found'    → deutscher Titel als Link + Reload-Button
     * 'notfound' → Hinweis + Reload-Button, blendet sich nach 4 s aus
     */
    function setState(el, state, text, url) {
        el.innerHTML     = '';
        el.style.cssText = 'display:block; font-size:1.0em;';
        if (el._fadeTimeout) { clearTimeout(el._fadeTimeout); delete el._fadeTimeout; }
        el.style.opacity    = '1';
        el.style.transition = '';

        switch (state) {
            case 'loading': {
                el.style.color     = '#aaa';
                el.style.fontStyle = 'italic';
                el.textContent     = '↻ OFDb-Titel wird gesucht …';
                // Kein Reload-Button während des Ladens
                break;
            }

            case 'found': {
                el.style.fontStyle = 'normal';
                const link         = document.createElement('a');
                link.href          = url;
                link.target        = '_blank';
                link.textContent   = `OFDb: ${text}`;
                link.style.cssText = 'color:#555; text-decoration:underline;';
                el.appendChild(link);
                el.appendChild(createReloadButton());
                break;
            }

            case 'notfound': {
                el.style.color     = '#bbb';
                el.style.fontStyle = 'italic';
                el.appendChild(document.createTextNode('(kein OFDb-Eintrag gefunden)'));
                el.appendChild(createReloadButton());
                // Nach 4 s gemeinsam mit Button ausblenden und entfernen
                el._fadeTimeout = setTimeout(() => {
                    el.style.transition = 'opacity 1s';
                    el.style.opacity    = '0';
                    setTimeout(() => el.remove(), 1000);
                }, 4000);
                break;
            }
        }
    }

})();
