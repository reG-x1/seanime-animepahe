/// <reference path="./online-streaming-provider.d.ts" />
class Provider {
  constructor() {
    this.mirrors = ["https://animepahe.com", "https://animepahe.pw", "https://animepahe.org"];
    this.defaultUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
    this.sessionKey = "animepahe:clearance";
  }

  getSettings() {
    return { episodeServers: ["Kwik"], supportsDub: true };
  }

  // ───────────────────────── search ─────────────────────────

  async search(opts) {
    console.log(`[Animepahe] v2.1.1 search: "${opts.query}" dub=${!!opts.dub}`);
    const audio = opts.dub ? "dub" : "sub";
    const queries = this.uniq([
      opts.media && opts.media.romajiTitle,
      opts.media && opts.media.englishTitle,
      opts.query,
    ].map(q => (q || "").trim()).filter(Boolean));

    const seen = {};
    const results = [];
    for (const q of queries) {
      let data;
      try {
        data = await this.api(`/api?m=search&q=${encodeURIComponent(q)}`);
      } catch (e) {
        if (!results.length && q === queries[queries.length - 1]) throw e;
        console.log(`[Animepahe] search "${q}" failed: ${this.why(e)}`);
        continue;
      }
      const list = (data && data.data) || [];
      for (const item of list) {
        if (!item || !item.session || seen[item.session]) continue;
        seen[item.session] = true;
        results.push({
          id: `${item.session}|${audio}`,
          title: item.title || item.session,
          url: `${this.currentBase()}/anime/${item.session}`,
          subOrDub: "both",
          _eps: Number(item.episodes) || 0,
        });
      }
      if (results.length) break; // first query that hits is the most specific
    }

    const want = opts.media && opts.media.episodeCount > 0 ? opts.media.episodeCount : 0;
    if (want) results.sort((a, b) => (b._eps === want ? 1 : 0) - (a._eps === want ? 1 : 0));
    if (!results.length) throw new Error("Animepahe: no results found");
    return results.map(r => ({ id: r.id, title: r.title, url: r.url, subOrDub: r.subOrDub }));
  }

  // ───────────────────────── episodes ─────────────────────────

  async findEpisodes(id) {
    console.log(`[Animepahe] findEpisodes: ${id}`);
    const parts = String(id).split("|");
    const animeSession = parts[0];
    const audio = parts[1] === "dub" ? "dub" : "sub";
    if (!animeSession) return [];

    const first = await this.api(`/api?m=release&id=${animeSession}&sort=episode_asc&page=1`);
    let items = (first && first.data) || [];
    const last = Math.min(Number(first && first.last_page) || 1, 60);
    for (let page = 2; page <= last; page++) {
      const next = await this.api(`/api?m=release&id=${animeSession}&sort=episode_asc&page=${page}`);
      items = items.concat((next && next.data) || []);
    }

    const base = this.currentBase();
    const episodes = [];
    for (const ep of items) {
      const number = Number.parseFloat(ep && ep.episode);
      if (!ep || !ep.session || !Number.isFinite(number)) continue;
      episodes.push({
        id: `${animeSession}/${ep.session}|${audio}`,
        number,
        title: ep.title ? `Episode ${number} - ${ep.title}` : `Episode ${number}`,
        url: `${base}/play/${animeSession}/${ep.session}`,
      });
    }
    episodes.sort((a, b) => a.number - b.number);
    return episodes;
  }

  // ───────────────────────── video ─────────────────────────

  async findEpisodeServer(episode, _server) {
    console.log(`[Animepahe] findEpisodeServer: ${episode && episode.id}`);
    const idStr = String(episode.id);
    const wantDub = idStr.split("|")[1] === "dub";
    const path = idStr.split("|")[0]; // animeSession/episodeSession
    if (path.indexOf("/") === -1) throw new Error("Animepahe: invalid episode id");

    const page = await this.get(`/play/${path}`);
    const buttons = this.parsePlayButtons(page.body).filter(b =>
      wantDub ? b.audio === "eng" : b.audio !== "eng"
    );
    if (!buttons.length) {
      throw new Error(wantDub ? "Animepahe: no dub available for this episode" : "Animepahe: no stream buttons found on play page");
    }

    // One button per resolution (first fansub wins), highest first.
    const byRes = {};
    for (const b of buttons) if (!byRes[b.res]) byRes[b.res] = b;
    const picked = Object.keys(byRes).map(Number).sort((a, b) => b - a).map(r => byRes[r]);

    const videoSources = [];
    let lastErr = "";
    for (const b of picked) {
      try {
        const url = await this.resolveKwik(b.src, page.base);
        videoSources.push({
          url,
          type: "m3u8",
          quality: `${b.res}p`,
          label: b.fansub ? `${b.res}p · ${b.fansub}` : `${b.res}p`,
          subtitles: [],
        });
        this._kwikOrigin = this.origin(b.src);
      } catch (e) {
        lastErr = this.why(e);
        console.log(`[Animepahe] ${b.res}p failed: ${lastErr}`);
      }
    }
    if (!videoSources.length) throw new Error(`Animepahe: could not extract a stream (${lastErr})`);

    return {
      server: "Kwik",
      headers: { Referer: `${this._kwikOrigin || "https://kwik.si"}/` },
      videoSources,
    };
  }

  async resolveKwik(embedUrl, base) {
    const res = await fetch(embedUrl, {
      headers: { "User-Agent": this.userAgent(), Referer: `${base}/`, Accept: "text/html,*/*" },
      timeout: 30,
    });
    const html = res.text();
    if (!res.ok) throw new Error(`kwik HTTP ${res.status}`);
    const js = this.unpackKwik(html);
    const m = js.match(/(?:const|var|let)\s+source\s*=\s*['"]([^'"]+)['"]/) || js.match(/https?:\/\/[^'"\s\\]+\.m3u8[^'"\s\\]*/);
    if (!m) throw new Error("m3u8 not found in kwik page");
    return (m[1] || m[0]).replace(/\\\//g, "/");
  }

  // Dean Edwards p,a,c,k,e,d unpacker (what kwik uses).
  unpackKwik(html) {
    const m = html.match(/\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/);
    if (!m) return html; // some builds ship the source unpacked
    const unesc = s => s.replace(/\\(['\\])/g, "$1");
    const payload = unesc(m[1]);
    const radix = parseInt(m[2], 10);
    let count = parseInt(m[3], 10);
    const keys = unesc(m[4]).split("|");
    const enc = n => (n < radix ? "" : enc(Math.floor(n / radix))) + ((n = n % radix) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    const dict = {};
    while (count--) dict[enc(count)] = keys[count] || enc(count);
    return payload.replace(/\b\w+\b/g, w => (Object.prototype.hasOwnProperty.call(dict, w) ? dict[w] : w));
  }

  parsePlayButtons(html) {
    const out = [];
    const re = /<button\b[^>]*\bdata-src\s*=\s*["'][^"']+["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const tag = m[0];
      const src = this.attr(tag, "data-src");
      if (!src) continue;
      out.push({
        src,
        res: parseInt(this.attr(tag, "data-resolution"), 10) || 0,
        audio: (this.attr(tag, "data-audio") || "jpn").toLowerCase(),
        fansub: this.attr(tag, "data-fansub") || "",
      });
    }
    return out;
  }

  attr(tag, name) {
    const m = tag.match(new RegExp("\\b" + name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i"));
    return m ? m[1].replace(/&amp;/gi, "&") : "";
  }

  // ───────────────────────── http + anti-bot ─────────────────────────

  async api(path) {
    const r = await this.get(path, { Accept: "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" });
    try {
      return JSON.parse(r.body);
    } catch (_e) {
      throw new Error(`Animepahe: unexpected non-JSON response (HTTP ${r.status}): ${r.body.slice(0, 120)}`);
    }
  }

  // GET against the first reachable mirror; solves a Cloudflare/DDoS-Guard challenge once if needed.
  async get(path, extraHeaders) {
    let lastErr;
    for (const base of this.bases()) {
      try {
        let r = await this.fetchOnce(base, path, extraHeaders);
        if (this.isBlocked(r)) {
          console.log(`[Animepahe] ${base} returned an anti-bot challenge (HTTP ${r.status}); trying browser solve`);
          const solved = await this.solveChallenge(base);
          if (!solved) {
            throw new Error(
              "Animepahe is behind an anti-bot challenge. Options: install Chrome/Chromium so Seanime\'s ChromeDP can solve it, run FlareSolverr and set solverUrl, or paste your browser cookie + User-Agent into the extension settings."
            );
          }
          const sess = this.loadSession();
          r = await this.fetchOnce((sess && sess.origin) || base, path, extraHeaders);
          if (this.isBlocked(r)) throw new Error(`Animepahe still blocked after solving (HTTP ${r.status}); cookie is probably bound to a different IP/User-Agent`);
        }
        if (!r.ok) throw new Error(`Animepahe HTTP ${r.status} for ${path}`);
        this.setBase(r.base);
        return r;
      } catch (e) {
        lastErr = e;
        const msg = this.why(e);
        // Only fall through to the next mirror on transport errors.
        if (/anti-bot|still blocked|HTTP \d+/.test(msg)) throw e;
        console.log(`[Animepahe] ${base} unreachable: ${msg}`);
      }
    }
    throw lastErr || new Error("Animepahe: no mirror reachable");
  }

  async fetchOnce(base, path, extraHeaders) {
    const sess = this.loadSession();
    const headers = Object.assign(
      { "User-Agent": this.userAgent(), Referer: `${base}/`, Accept: "*/*" },
      extraHeaders || {}
    );
    const cookie = (sess && sess.cookie && sess.origin === base ? sess.cookie : "") || this.pref("cookie", "");
    if (cookie) headers.Cookie = cookie;
    const t0 = Date.now();
    console.log(`[Animepahe] GET ${base}${path} (cookie: ${cookie ? "yes" : "no"})`);
    const res = await fetch(`${base}${path}`, { headers, timeout: 20 });
    const body = res.text() || "";
    console.log(`[Animepahe]   -> HTTP ${res.status}, ${body.length} bytes, ${Date.now() - t0}ms, starts: ${body.slice(0, 80).replace(/\s+/g, " ")}`);
    return { ok: res.ok, status: res.status, body, base };
  }

  isBlocked(r) {
    if (r.ok && r.body && (r.body.charAt(0) === "{" || r.body.charAt(0) === "[")) return false;
    if (r.status !== 403 && r.status !== 503 && r.status !== 429 && r.status !== 200) return false;
    const b = (r.body || "").toLowerCase();
    return (
      b.indexOf("just a moment") !== -1 ||
      b.indexOf("/cdn-cgi/challenge-platform") !== -1 ||
      b.indexOf("cf-browser-verification") !== -1 ||
      b.indexOf("attention required! | cloudflare") !== -1 ||
      b.indexOf("ddos-guard") !== -1 ||
      b.indexOf("__ddg") !== -1 && !r.ok
    );
  }

  // Tries every available bypass in order. Each one ends in saveSession().
  async solveChallenge(base) {
    const solver = this.pref("solverUrl", "");
    if (solver && (await this.solveWithSolver(base, solver))) return true;
    if (await this.solveWithBrowser(base)) return true;
    if (!solver) console.log("[Animepahe] tip: set solverUrl (FlareSolverr, e.g. http://127.0.0.1:8191/v1) as a further fallback");
    return false;
  }

  saveSession(cookie, ua, origin, how) {
    $store.set(this.sessionKey, { cookie, ua, origin, at: Date.now() });
    this.setBase(origin);
    console.log(`[Animepahe] clearance saved via ${how} for ${origin}`);
  }

  hostOf(u) { return String(u).replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
  cookieMatches(c, host) {
    const d = String((c && c.domain) || "").replace(/^\./, "");
    return !!d && (host === d || host.slice(-d.length - 1) === "." + d);
  }

  // Local FlareSolverr-compatible service. Follows redirects, so .com -> .pw is handled too.
  async solveWithSolver(base, endpoint) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd: "request.get", url: `${base}/`, maxTimeout: 60000 }),
        timeout: 90,
      });
      const data = JSON.parse(res.text() || "{}");
      const sol = data && data.solution;
      if (!sol || data.status !== "ok") {
        console.log(`[Animepahe] solver failed: ${(data && data.message) || res.status}`);
        return false;
      }
      const origin = this.origin(sol.url || base);
      const host = this.hostOf(origin);
      const cookies = (sol.cookies || []).filter(c => this.cookieMatches(c, host));
      if (!cookies.some(c => c.name === "cf_clearance" || /^__ddg2_/.test(c.name))) {
        console.log("[Animepahe] solver returned no clearance cookie");
        return false;
      }
      this.saveSession(cookies.map(c => `${c.name}=${c.value}`).join("; "), sol.userAgent || this.userAgent(), origin, "solver");
      return true;
    } catch (e) {
      console.log(`[Animepahe] solver error: ${this.why(e)}`);
      return false;
    }
  }

  // Real Chrome through Seanime's ChromeDP. Detects where the site redirected to (.com -> .pw).
  async solveWithBrowser(base) {
    if (typeof ChromeDP === "undefined" || typeof ChromeDP.newBrowser !== "function") {
      console.log("[Animepahe] ChromeDP is unavailable");
      return false;
    }
    const ua = this.userAgent();
    const hosts = this.bases().map(b => this.hostOf(b));
    let browser;
    try {
      browser = await ChromeDP.newBrowser({ timeout: 60, userAgent: ua });
      try {
        await browser.navigate(`${base}/`);
      } catch (e) {
        console.log(`[Animepahe] navigate: ${this.why(e)} (continuing)`);
      }
      for (let i = 0; i < 40; i++) {
        await browser.sleep(1000);
        const result = await browser.executeCDP("Network.getAllCookies");
        const all = Array.isArray(result && result.cookies) ? result.cookies : [];
        const mine = all.filter(c => hosts.some(h => this.cookieMatches(c, h)));
        const cleared = mine.find(c => c.name === "cf_clearance" || /^__ddg2_/.test(c.name));
        if (!cleared) continue;
        const dom = String(cleared.domain).replace(/^\./, "");
        let origin = `https://${dom}`;
        try {
          const loc = await browser.executeCDP("Runtime.evaluate", { expression: "location.origin", returnByValue: true });
          const v = loc && loc.result && loc.result.value;
          if (typeof v === "string" && /^https?:\/\//.test(v) && hosts.some(h => this.cookieMatches({ domain: this.hostOf(v) }, h))) origin = v;
        } catch (_e) {}
        const host = this.hostOf(origin);
        const jar = mine.filter(c => this.cookieMatches(c, host));
        this.saveSession(jar.map(c => `${c.name}=${c.value}`).join("; "), ua, origin, `browser (~${i + 1}s)`);
        return true;
      }
      console.log("[Animepahe] challenge cookie never appeared");
      return false;
    } catch (e) {
      console.log(`[Animepahe] browser solve failed: ${this.why(e)}`);
      return false;
    } finally {
      if (browser) {
        try { await browser.close(); } catch (_e) {}
      }
    }
  }

  loadSession() {
    try { return $store.get(this.sessionKey) || null; } catch (_e) { return null; }
  }

  userAgent() {
    const sess = this.loadSession();
    return (sess && sess.ua) || this.pref("userAgent", "") || this.defaultUA;
  }

  // ───────────────────────── helpers ─────────────────────────

  pref(name, fallback) {
    try {
      const v = $getUserPreference(name);
      if (typeof v === "string" && v.trim() && v.indexOf("{{") === -1) return v.trim();
    } catch (_e) {}
    return fallback;
  }

  bases() {
    const configured = this.pref("baseUrl", this.mirrors[0]).replace(/\/+$/, "");
    const sess = this.loadSession();
    return this.uniq([sess && sess.origin, configured].concat(this.mirrors));
  }

  setBase(base) { this._base = base; }
  currentBase() { return this._base || this.bases()[0]; }
  origin(u) { const m = String(u).match(/^https?:\/\/[^/]+/i); return m ? m[0] : "https://kwik.si"; }
  uniq(a) { return a.filter((x, i) => x && a.indexOf(x) === i); }
  why(e) { return e instanceof Error ? e.message : String(e); }
}
