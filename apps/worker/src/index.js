const SEATMAP_REFRESH_MS = 12 * 60 * 60 * 1000; // 12 часов
const SEATMAP_LOCK_TTL = 120; // 2 минуты
const SEATMAP_COOLDOWN_MS = 30 * 60 * 1000; // 30 минут после 429

const SEATMAP_TTL_SEC = 7 * 24 * 60 * 60;      // 7 дней в KV
const BUILD_PAGE_SIZE = 100;
const BUILD_PAGES_PER_CHUNK = 3;               // 3 страницы за один фоновый проход
const BUILD_LOCK_TTL_SEC = 60;                 // lock на минуту
const BUILD_COOLDOWN_MS = 10 * 60 * 1000;      // 10 минут после 429



export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, "") || "/";

        // CORS preflight (на будущее)
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: corsHeaders(env),
            });
        }

        if (request.method !== "GET") {
            return new Response("Method Not Allowed", { status: 405 });
        }

        if (url.pathname === "/") {
            return new Response("cluster-42 worker is alive", {
                headers: { "content-type": "text/plain; charset=utf-8" }
            });
        }

        if (path === "/login") return handleLogin(url, env);
        if (path === "/callback") return handleCallback(url, env);
        if (path === "/session") return handleSession(url, env);
        if (path === "/cluster") return handleCluster(url, env, ctx);
        if (path === "/debug/hosts") return debugHosts(url, env);
        if (path === "/debug/maxhosts") return debugMaxHosts(url, env);
        if (path === "/debug/seatmap") return debugSeatmap(url, env);
        if (path === "/debug/seatmap_err") return debugSeatmapErr(url, env);
        if (path === "/debug/hosts_page") return debugHostsPage(url, env);
        if (path === "/debug/build_seatmap") return debugBuildSeatmap(url, env);
        if (path === "/user") return handleUser(url, env);

        return new Response("Not Found", { status: 404 });
    },
};

function corsHeaders(env) {
    return {
        "Access-Control-Allow-Origin": env.FRONTEND_ORIGIN,
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };
}

async function handleLogin(url, env) {
    const state = cryptoRandomHex(16);

    // state на 10 минут
    await env.OAUTH.put(`state:${state}`, "1", { expirationTtl: 600 });

    const redirectUri = `${url.origin}/callback`;

    const authorizeUrl = new URL("https://api.intra.42.fr/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", env.FT_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", state);

    return Response.redirect(authorizeUrl.toString(), 302);
}

async function handleCallback(url, env) {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) return new Response("Missing ?code", { status: 400 });
    if (!state) return new Response("Missing ?state", { status: 400 });

    // проверка state
    const ok = await env.OAUTH.get(`state:${state}`);
    if (!ok) return new Response("Invalid state", { status: 400 });
    await env.OAUTH.delete(`state:${state}`);

    const redirectUri = `${url.origin}/callback`;

    // code -> token
    const tokenRes = await fetch("https://api.intra.42.fr/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: env.FT_CLIENT_ID,
            client_secret: env.FT_CLIENT_SECRET,
            code,
            redirect_uri: redirectUri,
        }),
    });

    if (!tokenRes.ok) {
        const err = await tokenRes.text();
        return new Response(`Token exchange failed: ${err}`, { status: 502 });
    }

    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson.access_token;

    // создаём session и храним 2 часа
    const sessionId = cryptoRandomHex(16);
    await env.OAUTH.put(`sess:${sessionId}`, JSON.stringify({ accessToken }), {
        expirationTtl: 7200,
    });

    // редирект на GitHub Pages
    const front = new URL(env.FRONTEND_URL);
    front.searchParams.set("session", sessionId);

    return Response.redirect(front.toString(), 302);
}

async function handleSession(url, env) {
    const sessionId = url.searchParams.get("session");
    if (!sessionId) return new Response("Missing ?session", { status: 400 });

    const raw = await env.OAUTH.get(`sess:${sessionId}`);
    if (!raw) return new Response("Session expired", { status: 401 });

    const { accessToken } = JSON.parse(raw);

    // проверяем пользователя на стороне 42
    const meRes = await fetch("https://api.intra.42.fr/v2/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!meRes.ok) return new Response("Failed to fetch /me", { status: 502 });

    const me = await meRes.json();

    return new Response(JSON.stringify({ ok: true, me }), {
        headers: {
            "Content-Type": "application/json",
            ...corsHeaders(env),
        },
    });
}

function cryptoRandomHex(bytesLen) {
    const bytes = new Uint8Array(bytesLen);
    crypto.getRandomValues(bytes);
    return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------- helpers ----------------

async function handleCluster(url, env, ctx) {
    const sessionId = url.searchParams.get("session");
    const campusId = url.searchParams.get("campus_id");
    if (!sessionId) return new Response("Missing ?session", { status: 400 });
    if (!campusId) return new Response("Missing ?campus_id", { status: 400 });

    const raw = await env.OAUTH.get(`sess:${sessionId}`);
    if (!raw) return new Response("Session expired", { status: 401 });

    const { accessToken } = JSON.parse(raw);

    // 1) active locations (быстро)
    const activeLocations = await fetchActiveCampusLocations(campusId, accessToken);
    const activeHosts = activeLocations.map(x => x?.host).filter(Boolean);

    // 2) seatmap из KV или временный (из active) + фоновое обновление
    const seatRes = await getSeatmapFast(env, campusId, ctx, accessToken, activeHosts);
    const seatmap = seatRes.seatmap;

    // 3) users bulk
    const userIds = [...new Set(activeLocations.map(l => l?.user?.id).filter(Boolean))];
    const usersById = await fetchUsersByIds(userIds, accessToken);

    // 4) occupied map по host
    const occupied = new Map();
    for (const l of activeLocations) {
        const seat = parseSeatFromHost(l?.host);
        if (!seat) continue;

        const u = usersById.get(l.user.id);
        occupied.set(`${seat.zone}|${seat.row}|${seat.post}`, {
            status: "occupied",
            post: seat.post,
            user: u ? {
                id: u.id,
                login: u.login,
                displayname: u.displayname,
                avatar: u.image?.versions?.medium || u.image?.versions?.large || u.image?.versions?.small || u.image?.versions?.micro
                    || u.image?.link,
                pool_year: u.pool_year,
                kind: u.kind,
                staff: u["staff?"],
                alumni: u["alumni?"],
                // аватар для попапа (большой)
                avatar_large: u.image?.versions?.large
                    || u.image?.versions?.medium
                    || u.image?.link,
                // уровень (может отсутствовать)
                level: (() => {
                    const cu = (Array.isArray(u?.cursus_users) && u.cursus_users.length)
                        ? (
                            u.cursus_users.find(c => c?.cursus?.slug === "42cursus")
                            || u.cursus_users.find(c => c?.cursus_id === 21 || c?.cursus?.id === 21)
                            || u.cursus_users.find(c => typeof c?.level === "number")
                        )
                        : null;

                    return (typeof cu?.level === "number") ? cu.level : null;
                })(),
            } : { id: l.user.id, login: l.user.login },
        });
    }

    // 5) overlay на seatmap
    const zonesOut = (seatmap.zones || []).map(z => ({
        name: z.name,
        rows: (z.rows || []).map(r => ({
            name: r.name,
            seats: (r.posts || []).map(p =>
                occupied.get(`${z.name}|${r.name}|${p}`) || { status: "free", post: p }
            ),
        })),
    }));

    // 6) stats
    const stats = { occupied: 0, free: 0, blocked: 0, promo: {}, kind: {} };
    for (const z of zonesOut) {
        for (const r of z.rows) {
            for (const s of r.seats) {
                stats[s.status] = (stats[s.status] || 0) + 1;
                if (s.status === "occupied" && s.user) {
                    const py = s.user.pool_year || "unknown";
                    stats.promo[py] = (stats.promo[py] || 0) + 1;

                    const k = s.user.kind || "unknown";
                    stats.kind[k] = (stats.kind[k] || 0) + 1;
                    // const g = s.user.grade || "unknown";
                    // stats.grade[g] = (stats.grade[g] || 0) + 1;
                }
            }
        }
    }

    const meta = {
        campus_id: campusId,
        active_count: activeLocations.length,
        seatmap_source: seatmap.source,
        seatmap_generated_at: seatmap.generated_at || null,
        seatmap_hosts_count: seatmap.hosts_count || null,
        seatmap_refreshing: !!seatRes.refreshing,
        seatmap_error: seatRes.error || null,
        seatmap_building: !!seatRes.building,
        seatmap_build_err: seatRes.error || null,

    };

    return new Response(JSON.stringify({
        ok: true,
        updated_at: new Date().toISOString(),
        zones: zonesOut,
        stats,
        meta,
    }), {
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": env.FRONTEND_ORIGIN,
        }
    });
}

async function handleUser(url, env) {
    // CORS preflight (если надо)
    // if (url.method === "OPTIONS") return new Response("", { headers: corsHeaders(env) });

    const sessionId = url.searchParams.get("session");
    const id = url.searchParams.get("id");
    if (!sessionId) return new Response("Missing ?session", { status: 400, headers: corsHeaders(env) });
    if (!id) return new Response("Missing ?id", { status: 400, headers: corsHeaders(env) });

    const raw = await env.OAUTH.get(`sess:${sessionId}`);
    if (!raw) return new Response("Session expired", { status: 401, headers: corsHeaders(env) });
    const { accessToken } = JSON.parse(raw);

    const cacheKey = `user_full:${id}`;
    const cached = await env.OAUTH.get(cacheKey);
    if (cached) {
        return new Response(cached, {
            headers: { "Content-Type": "application/json", ...corsHeaders(env) }
        });
    }

    const res = await fetch(`https://api.intra.42.fr/v2/users/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
        return new Response(JSON.stringify({ ok: false, error: `HTTP ${res.status}` }), {
            headers: { "Content-Type": "application/json", ...corsHeaders(env) }
        });
    }

    const u = await res.json();

    const payload = {
        ok: true,
        user: u, // <-- ВЕСЬ объект как от API
        derived: {
            level42: pickLevel42(u),
            avatar: pickAvatar(u),
            avatar_large: pickAvatarLarge(u),
        }
    };

    const out = JSON.stringify(payload);

    // кэш на 5 минут, чтобы не долбить API при кликах
    await env.OAUTH.put(cacheKey, out, { expirationTtl: 300 });

    return new Response(out, {
        headers: { "Content-Type": "application/json", ...corsHeaders(env) }
    });
}



function seatmapKey(campusId) { return `seatmap_host:${campusId}`; }
function cursorKey(campusId) { return `seatmap_build_cursor:${campusId}`; }
function lockKey(campusId) { return `seatmap_build_lock:${campusId}`; }
function cooldownKey(campusId) { return `seatmap_build_cooldown:${campusId}`; }
function errKey(campusId) { return `seatmap_build_err:${campusId}`; }


// ---------------- helpers ----------------
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllCampusLocations(campusId, accessToken) {
    // Без filter[active] — чтобы получить и пустые места/геометрию.
    // Пагинация: page[number]
    const pageSize = 100;
    let page = 1;
    const out = [];

    while (true) {
        const u = new URL(`https://api.intra.42.fr/v2/campus/${campusId}/locations`);
        u.searchParams.set("page[size]", String(pageSize));
        u.searchParams.set("page[number]", String(page));

        const res = await fetch(u.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error("Failed to fetch campus locations");

        const chunk = await res.json();
        out.push(...chunk);

        if (!Array.isArray(chunk) || chunk.length < pageSize) break;
        page++;
        if (page > 30) break; // защита от бесконечного цикла
    }

    return out;
}

async function fetchActiveCampusLocations(campusId, accessToken) {
    const pageSize = 100;
    let page = 1;
    const out = [];

    while (true) {
        const u = new URL(`https://api.intra.42.fr/v2/campus/${campusId}/locations`);
        u.searchParams.set("filter[active]", "true");
        u.searchParams.set("page[size]", String(pageSize));
        u.searchParams.set("page[number]", String(page));

        const res = await fetch(u.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error("Failed to fetch active locations");

        const chunk = await res.json();
        out.push(...chunk);

        if (!Array.isArray(chunk) || chunk.length < pageSize) break;
        page++;
        if (page > 30) break;
    }

    return out;
}

async function fetchAllCampusHosts(campusId, accessToken) {
    const pageSize = 100;
    let page = 1;
    const hosts = [];

    while (true) {
        const u = new URL(`https://api.intra.42.fr/v2/campus/${campusId}/locations`);
        u.searchParams.set("page[size]", String(pageSize));
        u.searchParams.set("page[number]", String(page));

        const res = await fetch(u.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (res.status === 429) {
            // небольшая пауза и бросаем наверх — включится cooldown
            await sleep(800);
            throw new Error("fetchAllCampusHosts HTTP 429");
        }

        if (!res.ok) throw new Error(`fetchAllCampusHosts HTTP ${res.status}`);

        const chunk = await res.json();

        for (const loc of chunk) {
            if (loc?.host) hosts.push(loc.host);
        }

        if (!Array.isArray(chunk) || chunk.length < pageSize) break;
        page++;
        if (page > 120) break; // safety

        // пауза между страницами — реально помогает
        await sleep(200);
    }

    return hosts;
}

async function fetchUsersByIds(ids, accessToken) {
    const map = new Map();
    if (!ids.length) return map;

    const CHUNK = 90;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const part = ids.slice(i, i + CHUNK);

        const u = new URL("https://api.intra.42.fr/v2/users");
        u.searchParams.set("filter[id]", part.join(","));
        u.searchParams.set("page[size]", "100");

        const res = await fetch(u.toString(), {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!res.ok) continue;
        const users = await res.json();

        // Debug: посмотри что приходит
        if (users.length > 0) {
            console.log("Sample user cursus_users:", JSON.stringify(users[0]?.cursus_users));
        }

        for (const user of users) map.set(user.id, user);
    }

    return map;
}


function buildSeatmapFromLocations(locations) {
    // собираем по zone: set(rows), set(posts)
    const zoneRows = new Map();   // zone -> Set(row)
    const zonePosts = new Map();  // zone -> Set(post)

    let filledCount = 0;

    for (const l of locations) {
        const zone = l?.floor;
        const row = l?.row;
        const post = l?.post;
        if (!zone || !row || post == null) continue;

        filledCount++;

        if (!zoneRows.has(zone)) zoneRows.set(zone, new Set());
        zoneRows.get(zone).add(row);

        const p = Number(post);
        if (!Number.isFinite(p)) continue;
        if (!zonePosts.has(zone)) zonePosts.set(zone, new Set());
        zonePosts.get(zone).add(p);
    }

    // если почти ничего не заполнено — Variant B не подходит
    if (filledCount < 5) {
        return {
            source: "locations:insufficient-floor-row-post",
            zones: [],
        };
    }

    const zones = [...zoneRows.keys()].sort((a, b) => a.localeCompare(b)).map(zoneName => {
        const rows = [...zoneRows.get(zoneName)]
            .sort(naturalRowSort)
            .map(r => ({ name: r }));

        const postsSet = zonePosts.get(zoneName) || new Set();
        const posts = makeRangeFromSet(postsSet, "desc"); // 8..1 или 5..1

        return {
            name: zoneName,
            rows: rows.map(r => ({ name: r.name, posts })),
        };
    });

    return {
        source: "locations:auto",
        zones,
    };
}

function buildSeatmapFromHosts(hosts, prevSeatmap) {
    const maxima = prevSeatmap?.maxima || {}; // { Z1: {maxRow,maxPost}, ... }

    for (const host of hosts) {
        const seat = parseSeatFromHost(host);
        if (!seat) continue;

        const z = seat.zone;
        const rowNum = Number(seat.row.slice(1));
        const postNum = Number(seat.post);

        if (!maxima[z]) maxima[z] = { maxRow: 0, maxPost: 0 };
        maxima[z].maxRow = Math.max(maxima[z].maxRow, rowNum);
        maxima[z].maxPost = Math.max(maxima[z].maxPost, postNum);
    }

    const zoneNames = Object.keys(maxima).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

    const zones = zoneNames.map(z => {
        const { maxRow, maxPost } = maxima[z];

        const rows = [];
        for (let r = 1; r <= maxRow; r++) {
            const posts = [];
            for (let p = maxPost; p >= 1; p--) posts.push(p);
            rows.push({ name: `R${r}`, posts });
        }

        return { name: z, rows };
    });

    return { source: "host:all-locations", maxima, zones };
}

function naturalRowSort(a, b) {
    const na = extractNum(a);
    const nb = extractNum(b);
    if (na !== null && nb !== null && na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
}

function extractNum(s) {
    const m = String(s).match(/(\d+)/);
    return m ? Number(m[1]) : null;
}

function makeRangeFromSet(set, dir = "asc") {
    const arr = [...set].filter(Number.isFinite);
    if (!arr.length) return [];
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const out = [];
    if (dir === "desc") {
        for (let i = max; i >= min; i--) out.push(i);
    } else {
        for (let i = min; i <= max; i++) out.push(i);
    }
    return out;
}

function parseSeatFromHost(host) {
    const h = String(host || "").toLowerCase();
    const m = h.match(/^z(\d+)r(\d+)p(\d+)$/);
    if (!m) return null;

    return {
        zone: `Z${Number(m[1])}`,
        row: `R${Number(m[2])}`,
        post: Number(m[3]),
    };
}

async function getSeatmapCached(env, campusId, accessToken) {
    const key = `seatmap_host:${campusId}`;
    const prevRaw = await env.OAUTH.get(key);
    const prev = prevRaw ? JSON.parse(prevRaw) : null;

    const now = Date.now();
    const TTL_SEATMAP = 7 * 24 * 60 * 60;       // храним в KV 7 дней
    const REFRESH_MS = 24 * 60 * 60 * 1000;     // обновляем раз в сутки

    const hasData = prev?.zones?.length > 0 && prev?.maxima && Object.keys(prev.maxima).length > 0;
    const isFresh = hasData && prev?.generated_at && (now - prev.generated_at) < REFRESH_MS;

    // свежий seatmap — сразу отдаём
    if (prev && isFresh) return { seatmap: prev, refreshed: false };

    // иначе пробуем обновить из ALL locations
    try {
        const hosts = await fetchAllCampusHosts(campusId, accessToken);
        const updated = buildSeatmapFromHosts(hosts, prev);
        updated.generated_at = now;
        updated.hosts_count = hosts.length;

        await env.OAUTH.put(key, JSON.stringify(updated), { expirationTtl: TTL_SEATMAP });
        return { seatmap: updated, refreshed: true };
    } catch (e) {
        // fallback: если есть старый — используем его, чтобы UI не умер
        if (prev) {
            prev.source = (prev.source || "host:all-locations") + "|stale-fallback";
            return { seatmap: prev, refreshed: false, error: String(e?.message || e) };
        }

        // fallback 2: если вообще нет — вернём пустой (но это редкий край)
        return {
            seatmap: { source: "seatmap:none", generated_at: now, maxima: {}, zones: [] },
            refreshed: false,
            error: String(e?.message || e),
        };
    }
}

async function getSeatmapCachedFast(env, campusId, accessToken, ctx, activeHosts) {
    const key = `seatmap_host:${campusId}`;
    const keyErr = `seatmap_host_err:${campusId}`;
    const keyLock = `seatmap_host_lock:${campusId}`;
    const keyCooldown = `seatmap_host_cooldown:${campusId}`;

    const now = Date.now();

    const prevRaw = await env.OAUTH.get(key);
    const prev = prevRaw ? JSON.parse(prevRaw) : null;

    const hasPrev = prev?.zones?.length > 0 && prev?.maxima && Object.keys(prev.maxima).length > 0;
    const isFresh = hasPrev && prev?.generated_at && (now - prev.generated_at) < SEATMAP_REFRESH_MS;

    // fallback seatmap, чтобы UI работал мгновенно
    let fallback;
    if (hasPrev) {
        fallback = JSON.parse(JSON.stringify(prev));
        fallback.source = (fallback.source || "host:seatmap") + "|stale";
    } else {
        fallback = buildSeatmapFromHosts(activeHosts, null);
        fallback.generated_at = now;
        fallback.source = (fallback.source || "host:active") + "|fallback";
    }

    // если свежий — отдаём сразу, без refresh
    if (isFresh) return { seatmap: prev, refreshing: false };

    // проверим cooldown (после 429)
    const cooldownRaw = await env.OAUTH.get(keyCooldown);
    if (cooldownRaw) {
        const cooldownUntil = Number(cooldownRaw);
        if (Number.isFinite(cooldownUntil) && now < cooldownUntil) {
            return { seatmap: fallback, refreshing: false, error: "cooldown_after_429" };
        }
    }

    // попробуем поставить lock, чтобы не запускать refresh параллельно
    const lockExists = await env.OAUTH.get(keyLock);
    if (!lockExists && ctx?.waitUntil) {
        await env.OAUTH.put(keyLock, "1", { expirationTtl: SEATMAP_LOCK_TTL });

        ctx.waitUntil(
            refreshSeatmapInBackground(env, campusId, accessToken, prev)
                .catch(async (e) => {
                    // если 429 — выставим cooldown
                    const msg = String(e?.message || e);
                    if (msg.includes("HTTP 429")) {
                        await env.OAUTH.put(keyCooldown, String(now + SEATMAP_COOLDOWN_MS), { expirationTtl: Math.ceil(SEATMAP_COOLDOWN_MS / 1000) });
                    }
                    // запишем ошибку (у тебя уже есть логирование)
                    await env.OAUTH.put(keyErr, JSON.stringify({ at: new Date().toISOString(), error: msg }), { expirationTtl: 3600 });
                })
                .finally(async () => {
                    // lock сам истечёт по TTL, но можно удалить сразу
                    await env.OAUTH.delete(keyLock);
                })
        );

        return { seatmap: fallback, refreshing: true };
    }

    // refresh уже идёт или ctx нет
    return { seatmap: fallback, refreshing: false };
}

async function getSeatmapFast(env, campusId, ctx, accessToken, activeHosts) {
    const now = Date.now();

    const raw = await env.OAUTH.get(seatmapKey(campusId));
    const prev = raw ? JSON.parse(raw) : null;

    const hasPrev = prev?.zones?.length > 0 && prev?.maxima && Object.keys(prev.maxima).length > 0;
    const isFresh = hasPrev && prev?.generated_at && (now - prev.generated_at) < SEATMAP_REFRESH_MS;

    // fallback — чтобы UI работал всегда
    const fallback = hasPrev
        ? (() => { const x = JSON.parse(JSON.stringify(prev)); x.source = (x.source || "seatmap") + "|kv"; return x; })()
        : (() => { const x = buildSeatmapFromHosts(activeHosts, null); x.generated_at = now; x.source = "host:active|fallback"; return x; })();

    // если свежий — всё, ничего не строим
    if (isFresh) return { seatmap: prev, building: false };

    // если cooldown — не строим сейчас
    const cd = await env.OAUTH.get(cooldownKey(campusId));
    if (cd && now < Number(cd)) {
        return { seatmap: fallback, building: false, error: "cooldown" };
    }

    // если lock — другой билд уже идёт
    const lock = await env.OAUTH.get(lockKey(campusId));
    if (lock) return { seatmap: fallback, building: false, error: "locked" };

    // запускаем фоновый chunk-build (не блокируем ответ)
    if (ctx?.waitUntil) {
        await env.OAUTH.put(lockKey(campusId), "1", { expirationTtl: BUILD_LOCK_TTL_SEC });
        ctx.waitUntil(buildSeatmapChunk(env, campusId, accessToken).finally(async () => {
            await env.OAUTH.delete(lockKey(campusId));
        }));
        return { seatmap: fallback, building: true };
    }

    return { seatmap: fallback, building: false };
}

async function buildSeatmapChunk(env, campusId, accessToken) {
    const now = Date.now();

    try {
        // где остановились
        const curRaw = await env.OAUTH.get(cursorKey(campusId));
        let page = curRaw ? Number(curRaw) : 1;

        // текущий seatmap из KV (для maxima)
        const prevRaw = await env.OAUTH.get(seatmapKey(campusId));
        const prev = prevRaw ? JSON.parse(prevRaw) : null;

        const hostsBatch = [];
        let done = false;

        for (let i = 0; i < BUILD_PAGES_PER_CHUNK; i++) {
            const u = new URL(`https://api.intra.42.fr/v2/campus/${campusId}/locations`);
            u.searchParams.set("page[size]", String(BUILD_PAGE_SIZE));
            u.searchParams.set("page[number]", String(page));

            const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });

            if (res.status === 429) {
                // cooldown и выходим
                await env.OAUTH.put(cooldownKey(campusId), String(now + BUILD_COOLDOWN_MS), {
                    expirationTtl: Math.ceil(BUILD_COOLDOWN_MS / 1000),
                });
                throw new Error("HTTP 429");
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const chunk = await res.json();
            for (const loc of chunk) if (loc?.host) hostsBatch.push(loc.host);

            if (!Array.isArray(chunk) || chunk.length < BUILD_PAGE_SIZE) {
                done = true;
                break;
            }

            page++;
            // маленькая пауза — реально уменьшает 429
            await new Promise(r => setTimeout(r, 200));
        }

        // обновляем seatmap по этой пачке
        const updated = buildSeatmapFromHosts(hostsBatch, prev);
        updated.source = "host:incremental";
        updated.generated_at = now;
        updated.hosts_count = (prev?.hosts_count || 0) + hostsBatch.length;

        await env.OAUTH.put(seatmapKey(campusId), JSON.stringify(updated), { expirationTtl: SEATMAP_TTL_SEC });

        if (done) {
            await env.OAUTH.delete(cursorKey(campusId));
        } else {
            await env.OAUTH.put(cursorKey(campusId), String(page), { expirationTtl: 3600 });
        }

        await env.OAUTH.delete(errKey(campusId));
    } catch (e) {
        await env.OAUTH.put(errKey(campusId), JSON.stringify({
            at: new Date().toISOString(),
            error: String(e?.message || e),
        }), { expirationTtl: 3600 });
    }
}

async function refreshSeatmapInBackground(env, campusId, accessToken, prev) {
    const key = `seatmap_host:${campusId}`;
    const keyErr = `seatmap_host_err:${campusId}`;
    const TTL_SEATMAP = 7 * 24 * 60 * 60; // seconds

    try {
        const hosts = await fetchAllCampusHosts(campusId, accessToken);
        const updated = buildSeatmapFromHosts(hosts, prev);
        updated.generated_at = Date.now();
        updated.hosts_count = hosts.length;
        updated.source = "host:all-locations";

        await env.OAUTH.put(key, JSON.stringify(updated), { expirationTtl: TTL_SEATMAP });
        await env.OAUTH.delete(keyErr); // очистим ошибку если всё ок
    } catch (e) {
        const payload = {
            at: new Date().toISOString(),
            error: String(e?.message || e),
        };
        await env.OAUTH.put(keyErr, JSON.stringify(payload), { expirationTtl: 3600 });
        throw e;
    }
}

function pickLevel42(u) {
    const cu =
        u?.cursus_users?.find(c => c?.cursus?.slug === "42cursus") ||
        u?.cursus_users?.find(c => c?.cursus_id === 21 || c?.cursus?.id === 21) ||
        u?.cursus_users?.find(c => typeof c?.level === "number");
    return (typeof cu?.level === "number") ? cu.level : null;
}

function pickAvatar(u) {
    return u?.image?.versions?.medium
        || u?.image?.versions?.small
        || u?.image?.versions?.micro
        || u?.image?.link
        || null;
}

function pickAvatarLarge(u) {
    return u?.image?.versions?.large
        || u?.image?.versions?.medium
        || u?.image?.link
        || null;
}

async function debugHosts(url, env) {
    const sessionId = url.searchParams.get("session");
    const campusId = url.searchParams.get("campus_id");
    if (!sessionId || !campusId) return new Response("need session & campus_id", { status: 400 });

    const raw = await env.OAUTH.get(`sess:${sessionId}`);
    if (!raw) return new Response("Session expired", { status: 401 });

    const { accessToken } = JSON.parse(raw);

    const u = new URL(`https://api.intra.42.fr/v2/campus/${campusId}/locations`);
    u.searchParams.set("filter[active]", "true");
    u.searchParams.set("page[size]", "100");

    const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const arr = await res.json();

    const hosts = arr.map(x => x?.host).filter(Boolean);
    const sample = [...new Set(hosts)].slice(0, 50);

    return Response.json({
        count: hosts.length,
        unique: new Set(hosts).size,
        sample
    });
}

async function debugMaxHosts(url, env) {
    const sessionId = url.searchParams.get("session");
    const campusId = url.searchParams.get("campus_id");
    const raw = await env.OAUTH.get(`sess:${sessionId}`);
    const { accessToken } = JSON.parse(raw);

    const hosts = await fetchAllCampusHosts(campusId, accessToken);

    const maxRow = {};
    for (const h of hosts) {
        const s = parseSeatFromHost(h);
        if (!s) continue;
        const z = s.zone;
        const r = Number(s.row.slice(1));
        if (!maxRow[z] || r > maxRow[z].r) maxRow[z] = { r, host: h };
    }
    return Response.json(maxRow);
}

async function debugSeatmap(url, env) {
    const campusId = url.searchParams.get("campus_id");
    if (!campusId) return new Response("Missing ?campus_id", { status: 400 });

    const key = `seatmap_host:${campusId}`;
    const raw = await env.OAUTH.get(key);
    if (!raw) return Response.json({ ok: false, error: "no seatmap in KV yet" });

    const seatmap = JSON.parse(raw);

    const rowsByZone = {};
    for (const z of (seatmap.zones || [])) {
        rowsByZone[z.name] = z.rows?.length ?? 0;
    }

    // максимум для проверки Z3
    const maxima = seatmap.maxima || {};
    return Response.json({
        ok: true,
        source: seatmap.source,
        generated_at: seatmap.generated_at || null,
        hosts_count: seatmap.hosts_count || null,
        rowsByZone,
        maxima,
    });
}


async function debugSeatmapErr(url, env) {
    const campusId = url.searchParams.get("campus_id");
    if (!campusId) return new Response("Missing ?campus_id", { status: 400 });

    const raw = await env.OAUTH.get(`seatmap_host_err:${campusId}`);
    if (!raw) return Response.json({ ok: true, error: null });

    return new Response(raw, { headers: { "Content-Type": "application/json" } });
}

async function debugHostsPage(url, env) {
    const sessionId = url.searchParams.get("session");
    const campusId = url.searchParams.get("campus_id");
    const page = Number(url.searchParams.get("page") || "1");
    const size = Number(url.searchParams.get("size") || "100");

    if (!sessionId || !campusId) return new Response("need session & campus_id", { status: 400 });

    const raw = await env.OAUTH.get(`sess:${sessionId}`);
    if (!raw) return new Response("Session expired", { status: 401 });

    const { accessToken } = JSON.parse(raw);

    const u = new URL(`https://api.intra.42.fr/v2/campus/${campusId}/locations`);
    u.searchParams.set("page[size]", String(size));
    u.searchParams.set("page[number]", String(page));

    const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });

    // Важно: если 429 — покажем это явно
    if (!res.ok) {
        const ra = res.headers.get("retry-after");
        return Response.json({
            ok: false,
            status: res.status,
            retry_after: ra || null,
            page, size,
        }, { status: 200 });
    }

    const chunk = await res.json();

    const hosts = [];
    const unparsed = [];
    for (const loc of chunk) {
        const h = loc?.host;
        if (!h) continue;
        hosts.push(h);
        if (!parseSeatFromHost(h)) unparsed.push(h);
    }

    // немного статистики по максимальным рядам/постам на этой странице
    const pageMax = {};
    for (const h of hosts) {
        const s = parseSeatFromHost(h);
        if (!s) continue;
        const z = s.zone;
        const r = Number(s.row.slice(1));
        const p = Number(s.post);
        if (!pageMax[z]) pageMax[z] = { maxRow: 0, maxPost: 0 };
        pageMax[z].maxRow = Math.max(pageMax[z].maxRow, r);
        pageMax[z].maxPost = Math.max(pageMax[z].maxPost, p);
    }

    return Response.json({
        ok: true,
        page,
        size,
        count: chunk.length,
        done: chunk.length < size,         // если меньше size — это последняя страница
        hosts,
        unparsed_sample: unparsed.slice(0, 50),
        pageMax,
    });
}

async function debugBuildSeatmap(url, env) {
    const sessionId = url.searchParams.get("session");
    const campusId = url.searchParams.get("campus_id");
    const pages = Number(url.searchParams.get("pages") || "3"); // сколько страниц за один вызов
    const size = Number(url.searchParams.get("size") || "100");

    if (!sessionId || !campusId) return new Response("need session & campus_id", { status: 400 });

    const raw = await env.OAUTH.get(`sess:${sessionId}`);
    if (!raw) return new Response("Session expired", { status: 401 });

    const { accessToken } = JSON.parse(raw);

    const key = `seatmap_host:${campusId}`;
    const cursorKey = `seatmap_build_cursor:${campusId}`;

    const prevRaw = await env.OAUTH.get(key);
    const prev = prevRaw ? JSON.parse(prevRaw) : null;

    const cursorRaw = await env.OAUTH.get(cursorKey);
    let page = cursorRaw ? Number(cursorRaw) : 1;

    let done = false;
    let totalHosts = 0;
    let hit429 = false;

    // накопим hosts пачками
    const hostsBatch = [];

    for (let i = 0; i < pages; i++) {
        const u = new URL(`https://api.intra.42.fr/v2/campus/${campusId}/locations`);
        u.searchParams.set("page[size]", String(size));
        u.searchParams.set("page[number]", String(page));

        const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });

        if (!res.ok) {
            if (res.status === 429) hit429 = true;
            break;
        }

        const chunk = await res.json();

        for (const loc of chunk) {
            if (loc?.host) hostsBatch.push(loc.host);
        }

        totalHosts += chunk.length;

        if (!Array.isArray(chunk) || chunk.length < size) {
            done = true;
            break;
        }

        page++;
        // лёгкая пауза, чтобы не ловить лимит
        await new Promise(r => setTimeout(r, 200));
    }

    // обновляем seatmap по этой пачке 
    const updated = buildSeatmapFromHosts(hostsBatch, prev);
    updated.source = "host:incremental";
    updated.generated_at = Date.now();
    updated.hosts_count = (prev?.hosts_count || 0) + hostsBatch.length;

    await env.OAUTH.put(key, JSON.stringify(updated), { expirationTtl: 7 * 24 * 60 * 60 });

    if (done) {
        await env.OAUTH.delete(cursorKey);
    } else {
        // если упёрлись в 429 — не двигаем курсор
        if (!hit429) await env.OAUTH.put(cursorKey, String(page), { expirationTtl: 3600 });
    }

    const rowsByZone = {};
    for (const z of (updated.zones || [])) rowsByZone[z.name] = z.rows?.length ?? 0;

    return Response.json({
        ok: true,
        built_pages: pages,
        next_page: done ? null : page,
        done,
        hit429,
        rowsByZone,
        maxima: updated.maxima,
    });
}
