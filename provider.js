/// <reference path="./onlinestream-provider.d.ts" />

// ---------------------------------------------------------------
// Animepahe (Custom) - direct scraper, ES5 only (Goja compatible)
// ---------------------------------------------------------------

// Animepahe changes domains often (animepahe.ru / .com / .si / .ch ...).
// Open the one that currently loads in your browser and put it here.
var BASE = "https://animepahe.pw";

var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Fallback cookie for DDoS-Guard. If the site shows a challenge page, copy the
// full Cookie header from your browser's dev tools (Network tab) and paste it here.
var FALLBACK_COOKIE = "__ddg1_=; __ddg2_=;";

// If Animepahe keeps answering 403, open it in your browser, press F12 -> Network,
// reload, click a request to animepahe.pw, and copy the "cookie" request header value here.
// (Also copy your browser's "user-agent" value into UA above.) These cookies expire.
// Keep this value private - do not share it.
var USER_COOKIE = "";

var cookieCache = null;

function log(msg) {
    try {
        console.log("[pahe] " + msg);
    } catch (e) {}
}

function getCookie() {
    if (USER_COOKIE) {
        return Promise.resolve(USER_COOKIE);
    }
    if (cookieCache) {
        return Promise.resolve(cookieCache);
    }
    return fetch("https://check.ddos-guard.net/check.js")
        .then(function (res) {
            var sc = "";
            try {
                sc = res.headers.get("set-cookie") || "";
            } catch (e) {}
            var m = sc.match(/__ddg2_=[^;]*/);
            log("check.js status " + res.status + ", ddg2 cookie " + (m ? "found" : "NOT found"));
            cookieCache = m ? ("__ddg1_=; " + m[0] + ";") : FALLBACK_COOKIE;
            return cookieCache;
        })
        .catch(function () {
            cookieCache = FALLBACK_COOKIE;
            return cookieCache;
        });
}

// Animepahe requests (need the DDoS-Guard cookie).
function paheText(url, referer) {
    log("GET " + url);
    var status = 0;
    return getCookie().then(function (cookie) {
        return fetch(url, {
            headers: {
                "Cookie": cookie,
                "Referer": referer || (BASE + "/"),
                "User-Agent": UA
            }
        });
    }).then(function (res) {
        status = res.status;
        log("status " + status + " for " + url);
        return res.text();
    }).then(function (text) {
        log("body length " + text.length);
        if (status !== 200) {
            log("non-200 body start: " + text.replace(/\s+/g, " ").substring(0, 500));
            throw new Error("Animepahe answered HTTP " + status + " (bot protection?)");
        }
        return text;
    });
}

// Kwik requests (only need a Referer).
function kwikText(url) {
    log("GET kwik " + url);
    return fetch(url, {
        headers: {
            "Referer": BASE + "/",
            "User-Agent": UA
        }
    }).then(function (res) {
        log("kwik status " + res.status);
        return res.text();
    }).then(function (text) {
        log("kwik body length " + text.length);
        return text;
    });
}

function safeParse(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

function attr(tag, name) {
    var m = tag.match(new RegExp(name + '="([^"]*)"'));
    return m ? m[1] : "";
}

function originOf(url) {
    var m = url.match(/^(https?:\/\/[^\/]+)/);
    return m ? m[1] : url;
}

// Dean Edwards p,a,c,k,e,d unpacker (what kwik uses to hide the m3u8 URL).
function unpack(p, a, c, k) {
    function e(n) {
        return (n < a ? "" : e(parseInt(n / a, 10))) +
            ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    }
    var d = {};
    while (c--) {
        d[e(c)] = k[c] || e(c);
    }
    return p.replace(/\b\w+\b/g, function (w) {
        return d.hasOwnProperty(w) ? d[w] : w;
    });
}

function resolveKwik(kwikUrl) {
    return kwikText(kwikUrl).then(function (html) {
        var m = html.match(/\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([^']*)'\.split\('\|'\)/);
        if (!m) {
            log("kwik: packed script NOT found. Start of page: " + html.substring(0, 300));
            return null;
        }
        var payload = m[1].replace(/\\'/g, "'");
        var unpacked = unpack(payload, parseInt(m[2], 10), parseInt(m[3], 10), m[4].split("|"));
        var u = unpacked.match(/https?:\/\/[^'"\s\\]+\.m3u8[^'"\s\\]*/);
        if (!u) {
            log("kwik: unpacked but no m3u8 found. Unpacked start: " + unpacked.substring(0, 300));
            return null;
        }
        log("kwik: m3u8 found " + u[0]);
        return u[0];
    }).catch(function (err) {
        log("kwik error: " + err);
        return null;
    });
}

// ---------------------------------------------------------------
// Core lookups
// ---------------------------------------------------------------

function searchOnce(query) {
    return paheText(BASE + "/api?m=search&q=" + encodeURIComponent(query)).then(function (text) {
        var data = safeParse(text);
        var list = (data && data.data) ? data.data : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            out.push({
                id: String(r.session),
                title: String(r.title),
                image: r.poster || "",
                url: BASE + "/anime/" + r.session,
                subOrDub: "sub"
            });
        }
        return out;
    });
}

// Try each query in order until one returns results.
function searchChain(queries, idx) {
    if (idx >= queries.length) {
        return Promise.resolve([]);
    }
    return searchOnce(queries[idx]).then(function (results) {
        if (results.length > 0) {
            return results;
        }
        return searchChain(queries, idx + 1);
    });
}

function fetchEpisodePages(animeId, page, acc) {
    var url = BASE + "/api?m=release&id=" + animeId + "&sort=episode_asc&page=" + page;
    return paheText(url, BASE + "/anime/" + animeId).then(function (text) {
        var data = safeParse(text);
        if (!data || !data.data) {
            return acc;
        }
        for (var i = 0; i < data.data.length; i++) {
            var e = data.data[i];
            acc.push({
                id: animeId + "/" + e.session,
                number: Number(e.episode),
                title: (e.title && String(e.title).length > 0) ? String(e.title) : ("Episode " + e.episode),
                url: BASE + "/play/" + animeId + "/" + e.session
            });
        }
        if (Number(data.current_page) < Number(data.last_page)) {
            return fetchEpisodePages(animeId, page + 1, acc);
        }
        return acc;
    });
}

function resolveSequential(found, idx, acc) {
    if (idx >= found.length) {
        return Promise.resolve(acc);
    }
    var f = found[idx];
    return resolveKwik(f.kwik).then(function (m3u8) {
        if (m3u8) {
            acc.push({
                server: "kwik",
                url: m3u8,
                quality: f.resolution ? (f.resolution + "p") : "auto",
                isM3U8: true,
                referer: originOf(f.kwik) + "/"
            });
        }
        return resolveSequential(found, idx + 1, acc);
    });
}

// Returns [{ server, url, quality, isM3U8, referer }]
function resolveEpisode(episodeId) {
    log("resolveEpisode " + episodeId);
    return paheText(BASE + "/play/" + episodeId).then(function (html) {
        var re = /<button[^>]*data-src="([^"]+)"[^>]*>/g;
        var m;
        var found = [];
        while ((m = re.exec(html)) !== null) {
            var audio = attr(m[0], "data-audio");
            if (audio === "eng") {
                continue; // dub entries skipped (supportsDub is false)
            }
            found.push({
                kwik: m[1],
                resolution: parseInt(attr(m[0], "data-resolution"), 10) || 0
            });
        }
        log("found " + found.length + " kwik buttons");
        if (found.length === 0) {
            log("no buttons. Start of play page: " + html.substring(0, 300));
        }
        found.sort(function (x, y) {
            return y.resolution - x.resolution;
        });
        return resolveSequential(found, 0, []);
    });
}

// ---------------------------------------------------------------
// Seanime provider interface
// ---------------------------------------------------------------

function Provider() {}

Provider.prototype.getSettings = function () {
    return {
        episodeServers: ["kwik"],
        supportsDub: false
    };
};

// opts = { query, dub, media: { englishTitle, romajiTitle, synonyms, ... } }
Provider.prototype.search = function (opts) {
    log("search " + JSON.stringify(opts));
    var queries = [];
    if (typeof opts === "string") {
        queries.push(opts);
    } else {
        if (opts.query) {
            queries.push(opts.query);
        }
        if (opts.media) {
            if (opts.media.romajiTitle) {
                queries.push(opts.media.romajiTitle);
            }
            if (opts.media.englishTitle) {
                queries.push(opts.media.englishTitle);
            }
        }
    }
    return searchChain(queries, 0);
};

Provider.prototype.findEpisodes = function (id) {
    log("findEpisodes " + id);
    return fetchEpisodePages(id, 1, []);
};

// Shape requested originally: [{ server, url, quality, isM3U8 }]
Provider.prototype.findVideoSources = function (episodeId) {
    return resolveEpisode(episodeId).then(function (sources) {
        var out = [];
        for (var i = 0; i < sources.length; i++) {
            out.push({
                server: sources[i].server,
                url: sources[i].url,
                quality: sources[i].quality,
                isM3U8: sources[i].isM3U8
            });
        }
        return out;
    });
};

// Entry point Seanime calls for playback.
Provider.prototype.findEpisodeServer = function (episode, server) {
    log("findEpisodeServer id=" + episode.id + " server=" + server);
    return resolveEpisode(episode.id).then(function (sources) {
        if (sources.length === 0) {
            throw new Error("No playable sources found for this episode");
        }
        var videoSources = [];
        for (var i = 0; i < sources.length; i++) {
            videoSources.push({
                url: sources[i].url,
                type: "m3u8",
                quality: sources[i].quality,
                subtitles: []
            });
        }
        return {
            server: server || "kwik",
            headers: { "Referer": sources[0].referer },
            videoSources: videoSources
        };
    });
};
