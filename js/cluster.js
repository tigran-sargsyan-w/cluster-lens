// === Dynamic map scaling for mobile ===
function scaleMapToFit() {
    if (window.innerWidth > 768) {
    // Desktop - reset any scaling
    const mapWrap = document.getElementById("mapZones");
    if (mapWrap) {
        mapWrap.style.transform = '';
        mapWrap.style.transformOrigin = '';
        mapWrap.style.marginBottom = '';
    }
    return;
    }
    
    const mapWrap = document.getElementById("mapZones");
    if (!mapWrap || !mapWrap.children.length) return;
    
    // Reset transform first to get actual size
    mapWrap.style.transform = 'none';
    mapWrap.style.marginBottom = '0';
    
    // Wait for layout
    requestAnimationFrame(() => {
    const mapWidth = mapWrap.scrollWidth;
    const card = mapWrap.closest('.card');
    const cardPadding = 16 * 2; // padding on both sides
    const availableWidth = (card ? card.clientWidth : window.innerWidth) - cardPadding;
    
    if (mapWidth > availableWidth) {
        const scale = availableWidth / mapWidth;
        mapWrap.style.transformOrigin = 'top left';
        mapWrap.style.transform = `scale(${scale})`;
        // Adjust container height to match scaled content
        const mapHeight = mapWrap.scrollHeight;
        mapWrap.style.marginBottom = `-${mapHeight * (1 - scale)}px`;
        // console.log(`Map scaled: ${mapWidth}px → ${availableWidth}px (scale: ${scale.toFixed(3)})`);
    } else {
        mapWrap.style.transform = '';
        mapWrap.style.marginBottom = '';
    }
    });
}

// Recalculate on resize
window.addEventListener('resize', () => {
    clearTimeout(window._resizeTimer);
    window._resizeTimer = setTimeout(scaleMapToFit, 100);
});

// === User Modal ===
const modalOverlay = document.getElementById("userModalOverlay");
const modalCloseBtn = document.getElementById("userModalClose");

// === Session Modal ===
const sessionModalOverlay = document.getElementById("sessionModalOverlay");
const sessionModalCloseBtn = document.getElementById("sessionModalClose");
const sessionModalLogin = document.getElementById("sessionModalLogin");

function showSessionModal(){
    if (!sessionModalOverlay) return;
    sessionModalOverlay.classList.add("show");
    sessionModalOverlay.setAttribute("aria-hidden", "false");
}

function closeSessionModal(){
    if (!sessionModalOverlay) return;
    sessionModalOverlay.classList.remove("show");
    sessionModalOverlay.setAttribute("aria-hidden", "true");
}

if (sessionModalCloseBtn) sessionModalCloseBtn.onclick = closeSessionModal;
if (sessionModalOverlay) sessionModalOverlay.addEventListener("click", (e) => { if (e.target === sessionModalOverlay) closeSessionModal(); });
if (sessionModalLogin) sessionModalLogin.onclick = () => { location.href = `${WORKER}/login`; };

function trunc2(v){
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return (Math.floor(n * 100) / 100).toFixed(2);
}

// Get active grade from cursus_users (where end_at is null)
function getActiveGrade(cursusUsers) {
    if (!Array.isArray(cursusUsers)) return "—";
    const active = cursusUsers.find(c => c.end_at === null);
    return active?.grade || "—";
}

async function openUserModal(user) {
    if (!user) return;

    // 1) мгновенно показываем то, что есть
    document.getElementById("userModalName").textContent = user.displayname || user.login || "—";
    document.getElementById("userModalLogin").textContent = user.login ? `@${user.login}` : "—";
    document.getElementById("userModalLevel").textContent = (user.level != null) ? String(user.level) : "—";
    document.getElementById("userModalPromo").textContent = user.pool_year || "—";
    document.getElementById("userModalKind").textContent = "—"; // will be loaded from full profile

    const img = document.getElementById("userModalAvatar");
    img.src = user.avatar_large || user.avatar || "";
    img.alt = user.displayname || user.login || "";

    const profileLink = document.getElementById("userModalProfileLink");
    if (user.login) {
        profileLink.href = `https://profile.intra.42.fr/users/${encodeURIComponent(user.login)}`;
        profileLink.setAttribute("aria-disabled", "false");
    } else {
        profileLink.href = "#";
        profileLink.setAttribute("aria-disabled", "true");
    }
    
    modalOverlay.classList.add("show");

    // 2) догружаем полный профиль
    const session = getSessionFromStorageOrUrl();
    // console.log("session from storage/url =", session);

    if (!session) {
        console.warn("No session found. /user call skipped.");
        document.getElementById("userModalLevel").textContent = "—";
        return;
    }

    try {
        const url = `${WORKER}/user?session=${encodeURIComponent(session)}&id=${encodeURIComponent(user.id)}`;
        const r = await fetch(url);

        // читаем как текст, чтобы увидеть даже не-JSON ответы
        const text = await r.text();
        let j;
        try {
        j = JSON.parse(text);
        } catch (e) {
        console.error("Response is not JSON. Parse error:", e);
        return;
        }

        if (!j?.ok) return;

        const full = j.user;
        const derived = j.derived || {};

        document.getElementById("userModalLevel").textContent =
        (derived.level42 != null) ? trunc2(derived.level42) : "—";

        // Get grade from cursus_users where end_at is null
        document.getElementById("userModalKind").textContent = getActiveGrade(full?.cursus_users);

        img.src = derived.avatar_large || derived.avatar || img.src;

        console.log("full user profile:", full);
    } catch (e) {
        console.error("Failed to load full user:", e);
    }
}

function closeUserModal(){
modalOverlay.classList.remove("show");
modalOverlay.setAttribute("aria-hidden", "true");
}

modalCloseBtn.onclick = closeUserModal;
modalOverlay.addEventListener("click", (e) => {
if (e.target === modalOverlay) closeUserModal();
});
document.addEventListener("keydown", (e) => {
if (e.key === "Escape") closeUserModal();
});

// === CONFIG ===
const WORKER = "https://cluster-42.tigran-sargsyan-w.workers.dev";
const HOME_PAGE = "/";
const PROFILE_PAGE = "profile.html";
const CLUSTER_PAGE = "cluster.html";

const ROW_FIRST_POSITION = {
    // примеры:
    // "Z1:R1": "top",
    // "Z1:R2": "bottom",
    // "R3": "top",
    "Z1:R1": "bottom",
    "Z2:R1": "top",
    "Z3:R1": "bottom",
    "Z4:R1": "bottom",
};

// Io: Z1,Z2 | Discovery: Z3,Z4
let activeTab = "io";

// === UI wiring ===
document.getElementById("btn-home").onclick = () => location.href = HOME_PAGE;
document.getElementById("btn-profile").onclick = () => location.href = PROFILE_PAGE;
document.getElementById("btn-login").onclick = () => location.href = `${WORKER}/login`;
document.getElementById("btn-logout").onclick = () => { localStorage.removeItem("session"); location.href = CLUSTER_PAGE; refreshStatus(); };
document.getElementById("btn-refresh").onclick = () => load();

document.getElementById("tab-io").onclick = () => { activeTab = "io"; setTab(true); load(); };
document.getElementById("tab-disc").onclick = () => { activeTab = "discovery"; setTab(false); load(); };

function setTab(isIo){
    document.getElementById("tab-io").classList.toggle("active", isIo);
    document.getElementById("tab-disc").classList.toggle("active", !isIo);
}

// Session helpers: show/hide buttons depending on session presence
function hasSession(){
    return !!localStorage.getItem("session");
}

function refreshStatus(){
    const logged = hasSession();
    // When not logged in: show Login, hide Logout
    // When logged in: show Logout, hide Login
    const elLogin = document.getElementById("btn-login");
    const elLogout = document.getElementById("btn-logout");
    const elProfile = document.getElementById("btn-profile");
    if (elLogin) elLogin.style.display = logged ? "none" : "inline-block";
    if (elLogout) elLogout.style.display = logged ? "inline-block" : "none";
    if (elProfile) elProfile.style.display = logged ? "inline-block" : "none";
}

// Initial UI state
refreshStatus();

// === Helpers ===
function el(tag, attrs={}, ...children){
    const node = document.createElement(tag);
    for (const [k,v] of Object.entries(attrs)){
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
    }
    for (const ch of children){
    if (ch == null) continue;
    node.appendChild(typeof ch === "string" ? document.createTextNode(ch) : ch);
    }
    return node;
}

function fmtTime(iso){
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleTimeString("ru-RU", { hour:"2-digit", minute:"2-digit", second:"2-digit" });
}

function renderBars(container, obj){
    container.innerHTML = "";
    const entries = Object.entries(obj || {}).sort((a,b) => b[1]-a[1]);
    if (!entries.length) {
    container.appendChild(el("div", { class:"muted" }, "—"));
    return;
    }
    const max = Math.max(...entries.map(e => e[1]));
    for (const [k,v] of entries) {
    const row = el("div", { class:"barRow" },
        el("div", { class:"mono muted" }, k),
        (() => {
        const bar = el("div", { class:"bar" }, el("i"));
        bar.firstChild.style.width = `${Math.round((v/max)*100)}%`;
        return bar;
        })(),
        el("div", { class:"mono" }, String(v))
    );
    container.appendChild(row);
    }
}

function filterZonesByTab(zones){
    const hasZ1 = zones.some(z => z.name === "Z1");
    const hasZ2 = zones.some(z => z.name === "Z2");
    const hasZ3 = zones.some(z => z.name === "Z3");
    const hasZ4 = zones.some(z => z.name === "Z4");
    const byName = new Map(zones.map(z => [z.name, z]));

    // если это действительно схема Z1..Z4 — фильтруем красиво
    if (hasZ1 || hasZ2 || hasZ3 || hasZ4) {
    if (activeTab === "io") {
        const ordered = ["Z2","Z1"].map(n => byName.get(n)).filter(Boolean);
        return ordered.length ? ordered : zones;
    } else {
        const ordered = ["Z4","Z3"].map(n => byName.get(n)).filter(Boolean);
        return ordered.length ? ordered : zones;
    }
    }

    // иначе (неожиданные имена зон) — показываем всё
    return zones;
}

function resolveZoneStartPosition(zone){
    const zoneName = zone?.name;
    if (!zoneName) return null;

    const direct = ROW_FIRST_POSITION[zoneName];
    if (direct === "top" || direct === "bottom") return direct;

    const firstRowName = zone?.rows?.[0]?.name || "R1";
    const key = `${zoneName}:${firstRowName}`;
    const fallback = ROW_FIRST_POSITION[key];
    return (fallback === "top" || fallback === "bottom") ? fallback : null;
}

function resolveRowStartPosition(zoneName, row, zoneDefault){
    const explicit =
    row?.first_position ||
    row?.firstPosition ||
    row?.start_position ||
    row?.startPosition;
    if (explicit === "top" || explicit === "bottom") return explicit;

    const key = `${zoneName}:${row.name}`;
    return ROW_FIRST_POSITION[key]
    || zoneDefault
    || ROW_FIRST_POSITION[row.name]
    || "top";
}

function renderZoneInto(container, zone){
    const inner = el("div", { class:"zoneInner" });
    const zoneDefault = resolveZoneStartPosition(zone);

    for (const r of zone.rows) {
    const startPosition = resolveRowStartPosition(zone.name, r, zoneDefault);
    const seats = el("div", { class:"seats" },
        // ...r.seats.map(s => {
        ...r.seats.map((s, idx) => {
        const isUp = (startPosition === "bottom")
            ? idx % 2 === 1
            : idx % 2 === 0;

        const seat = el("div", { class:`seat ${s.status}` });

        if (s.status === "occupied" && s.user?.avatar) {
            seat.appendChild(el("img", { src:s.user.avatar, alt:s.user.login, referrerpolicy:"no-referrer" }));
            seat.appendChild(el("div", { class:"tooltip" },
            `${s.user.login} • promo ${s.user.pool_year || "—"}`
            ));
        } else if (s.status === "blocked") {
            seat.appendChild(el("div", { class:"ban" }, "🚫"));
        }

        if (s.status === "occupied") {
        seat.style.cursor = "pointer";
        seat.addEventListener("click", () => openUserModal(s.user));
        }

        // return el("div", { class:"seatCol" },
        return el("div", { class:`seatCol ${isUp ? "up" : "down"}` },
            seat,
            el("div", { class:"seatNum mono" }, String(s.post))
        );
        })
    );

    inner.appendChild(
        el("div", { class:"zoneRow" },
        seats,
        el("div", { class:"rowLabel" }, r.name)
        )
    );
    }

    const zoneBox = el("div", { class:"zone" },
    el("div", { class:"zoneTitle" }, zone.name),
    inner
    );

    container.appendChild(zoneBox);
}

function setStatusMsg(text){
    const box = document.getElementById("statusMsg");
    if (!text) { box.style.display = "none"; box.textContent = ""; return; }
    box.style.display = "block";
    box.textContent = text;
}

// === Session + Campus ===
function getSessionFromStorageOrUrl(){
    const url = new URL(location.href);
    return url.searchParams.get("session") || localStorage.getItem("session");
}

async function getSessionIdFromUrlOrStorage(){
    const url = new URL(location.href);
    const sessionFromUrl = url.searchParams.get("session");
    const session = sessionFromUrl || localStorage.getItem("session");

    if (!session) return null;

    localStorage.setItem("session", session);
    if (sessionFromUrl){
    url.searchParams.delete("session");
    history.replaceState({}, "", url.toString());
    }
    return session;
}

async function getPrimaryCampus(session){
    const res = await fetch(`${WORKER}/session?session=${encodeURIComponent(session)}`);
    if (!res.ok) throw new Error("Session invalid/expired");

    const data = await res.json();
    const cu = data?.me?.campus_users || [];
    const primary = cu.find(x => x?.is_primary) || cu[0] || null;
    const campusId = primary?.campus_id || null;
    const campus = (data?.me?.campus || []).find(c => c?.id === campusId) || (data?.me?.campus || [])[0];
    return { id: campusId, name: campus?.name || "—" };
}

// === Cache ===
const CACHE_TTL_MS = 30 * 1000;
const CACHE_KEY_PREFIX = "cluster-cache:";

function getCacheKey(campusId, tab){
    return `${CACHE_KEY_PREFIX}${campusId}:${tab}`;
}

function readCachedCluster(campusId, tab){
    const raw = sessionStorage.getItem(getCacheKey(campusId, tab));
    if (!raw) return null;
    try {
    const cached = JSON.parse(raw);
    if (!cached?.timestamp || !cached?.data) return null;
    if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null;
    return cached.data;
    } catch (e) {
    return null;
    }
}

function writeCachedCluster(campusId, tab, data){
    sessionStorage.setItem(getCacheKey(campusId, tab), JSON.stringify({
    timestamp: Date.now(),
    data,
    }));
}

function renderClusterData(data, { source } = {}){
    if (!data?.ok){
    document.getElementById("updated").textContent = "Bad response";
    setStatusMsg("Unexpected response from /cluster.");
    return;
    }

    document.getElementById("occ").textContent = data.stats?.occupied ?? "—";
    document.getElementById("free").textContent = data.stats?.free ?? "—";
    document.getElementById("blocked").textContent = data.stats?.blocked ?? "—";
    const updatedLabel = fmtTime(data.updated_at);
    document.getElementById("updated").textContent =
    source === "cache" ? `${updatedLabel} (cached)` : updatedLabel;

    renderBars(document.getElementById("promoBars"), data.stats?.promo);
    renderBars(document.getElementById("kindBars"), data.stats?.kind);

    const zones = Array.isArray(data.zones) ? data.zones : [];
    document.getElementById("zonesDbg").textContent =
    zones.length ? zones.map(z => z.name).join(",") : "none";

    document.getElementById("rowsDbg").textContent =
    zones.length ? zones.map(z => `${z.name}:${z.rows?.length ?? 0}`).join(" | ") : "—";

    const map = document.getElementById("mapZones");
    map.innerHTML = "";

    if (!zones.length){
    setStatusMsg(
        `Seatmap is empty (seatmap_source=${data.seatmap_source || "—"}).
        Most likely the Worker hasn't been updated to host-parsing or there are no host-coordinates in the response.`
    );
    return;
    }

    const visible = filterZonesByTab(zones);

    for (const z of visible) renderZoneInto(map, z);

    // Scale map to fit screen on mobile
    scaleMapToFit();
}

// === Main load ===
async function load(){
    setStatusMsg("");

    const session = await getSessionIdFromUrlOrStorage();
    if (!session){
    document.getElementById("updated").textContent = "No session";
    setStatusMsg("No session found.");
    showSessionModal();
    return;
    }

    let campus;
    try {
    campus = await getPrimaryCampus(session);
    } catch (e) {
    document.getElementById("updated").textContent = "Session expired";
    localStorage.removeItem("session");
    setStatusMsg("Session expired or invalid. Click Login.");
    return;
    }

    if (!campus?.id){
    document.getElementById("updated").textContent = "No campus_id";
    setStatusMsg("Failed to determine campus_id from profile (/v2/me).");
    return;
    }

    // document.getElementById("campusId").textContent = String(campusId);
    document.getElementById("campusId").textContent = String(campus.id);
    document.getElementById("campusName").textContent = campus.name || "—";



    const cached = readCachedCluster(campus.id, activeTab);
    if (cached){
    setStatusMsg("Showing cached data… Updating in background.");
    renderClusterData(cached, { source: "cache" });
    }

    const api = `${WORKER}/cluster?session=${encodeURIComponent(session)}&campus_id=${encodeURIComponent(campus.id)}`;

    const res = await fetch(api);
    if (!res.ok){
    const text = await res.text().catch(() => "");
    document.getElementById("updated").textContent = `API error ${res.status}`;
    setStatusMsg(`Worker /cluster вернул ошибку ${res.status}.\n${text}`);
    return;
    }

    const data = await res.json();

    // console.log("cluster data", data);
    // console.log("campus", campus);

    window.__lastCluster = data;
    writeCachedCluster(campus.id, activeTab, data);
    setStatusMsg("");
    renderClusterData(data, { source: "network" });
}

// старт
load();
