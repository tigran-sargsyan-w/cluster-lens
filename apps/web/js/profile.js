const WORKER = "https://cluster-42.tigran-sargsyan-w.workers.dev";
const HOME_PAGE = "/";
const CLUSTER_PAGE = "cluster.html";

document.getElementById("btn-home").onclick = () => location.href = HOME_PAGE;
document.getElementById("btn-cluster").onclick = () => location.href = CLUSTER_PAGE;

document.getElementById("btn-login").onclick = () => {
  location.href = `${WORKER}/login`;
};

document.getElementById("btn-logout").onclick = () => {
  localStorage.removeItem("session");
  location.href = HOME_PAGE;
};

function hasSession() {
  return !!localStorage.getItem("session");
}

function refreshStatus() {
  const logged = hasSession();
  const elLogin = document.getElementById("btn-login");
  const elLogout = document.getElementById("btn-logout");
  const elCluster = document.getElementById("btn-cluster");
  if (elLogin) elLogin.style.display = logged ? "none" : "inline-block";
  if (elLogout) elLogout.style.display = logged ? "inline-block" : "none";
  if (elCluster) elCluster.style.display = logged ? "inline-block" : "none";
}

refreshStatus();

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const ch of children) {
    if (ch == null) continue;
    node.appendChild(typeof ch === "string" ? document.createTextNode(ch) : ch);
  }
  return node;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString("ru-RU", { year: "numeric", month: "short", day: "2-digit" });
}

function pickMainCursus(me) {
  // Main cursus is 42cursus (slug) or id=21, but better to check slug first
  const cu = me?.cursus_users || [];
  const main = cu.find(x => x?.cursus?.slug === "42cursus") || cu.find(x => x?.cursus_id === 21) || null;
  return main;
}

function primaryCampusName(me) {
  const primary = (me?.campus_users || []).find(x => x?.is_primary);
  const campusId = primary?.campus_id;
  const campus = (me?.campus || []).find(c => c?.id === campusId) || (me?.campus || [])[0];
  return campus?.name || "—";
}

function statusDot(ok) { return el("span", { class: `dot ${ok ? "good" : "bad"}` }); }

function render(me) {
  const main = pickMainCursus(me);
  const campus = primaryCampusName(me);

  const avatar = me?.image?.versions?.medium || me?.image?.link || "";
  const isActive = !!me["active?"];
  const isAlumni = !!me["alumni?"];
  const kind = me?.kind || "—";

  const header = el("div", { class: "profile" },
    el("img", { class: "avatar", src: avatar, alt: "avatar", referrerpolicy: "no-referrer" }),
    el("div", {},
      el("div", { class: "name" }, me?.displayname || `${me?.first_name ?? ""} ${me?.last_name ?? ""}`),
      el("div", { class: "sub mono" }, `@${me?.login || "—"}`),
      el("div", { class: "row" },
        el("span", { class: "chip" }, statusDot(isActive), `active: ${isActive ? "yes" : "no"}`),
        el("span", { class: "chip" }, el("span", { class: "dot warn" }), `kind: ${kind}`),
        el("span", { class: "chip" }, statusDot(!isAlumni), `alumni: ${isAlumni ? "yes" : "no"}`),
        el("span", { class: "chip" }, el("span", { class: "dot" }), `campus: ${campus}`),
      )
    )
  );

  const quick = el("div", { class: "row" },
    el("span", { class: "chip" }, `pool: ${me?.pool_month ?? "—"} ${me?.pool_year ?? "—"}`),
    el("span", { class: "chip" }, `wallet: ${me?.wallet ?? "—"}`),
    el("span", { class: "chip" }, `correction pts: ${me?.correction_point ?? "—"}`),
  );

  const cursusDetails = el("details", { open: true },
    el("summary", {}, el("span", {}, "🎓 42cursus"), el("span", { class: "muted" }, main ? `${main.grade ?? "—"} • lvl ${main.level ?? "—"}` : "—")),
    el("div", { class: "details-body" },
      el("div", { class: "kvs" },
        el("div", { class: "k" }, "Grade"), el("div", {}, main?.grade ?? "—"),
        el("div", { class: "k" }, "Level"), el("div", {}, String(main?.level ?? "—")),
        el("div", { class: "k" }, "Begin"), el("div", {}, fmtDate(main?.begin_at)),
        el("div", { class: "k" }, "Blackhole"), el("div", {}, fmtDate(main?.blackholed_at)),
      )
    )
  );

  const projects = (me?.projects_users || []).slice();

  const inProgress = projects
    .filter(p => p?.status === "in_progress")
    .sort((a, b) => (b?.created_at || "").localeCompare(a?.created_at || ""));

  const finished = projects
    .filter(p => p?.status === "finished")
    .sort((a, b) => (b?.marked_at || b?.updated_at || "").localeCompare(a?.marked_at || a?.updated_at || ""))
    .slice(0, 8);

  const projCard = el("details", { open: true },
    el("summary", {}, el("span", {}, "📦 Projects"), el("span", { class: "muted" }, `${inProgress.length} in progress • ${finished.length} recent finished`)),
    el("div", { class: "details-body" },
      el("div", { class: "muted", style: "margin-bottom:10px;" }, "In progress"),
      inProgress.length ? el("ul", { class: "list" },
        ...inProgress.map(p => el("li", { class: "item" },
          el("div", {},
            el("div", { class: "item-title" }, p?.project?.name || p?.project?.slug || "—"),
            el("div", { class: "item-sub" }, `started: ${fmtDate(p?.created_at)}`)
          ),
          el("span", { class: "pill" }, "in_progress")
        ))
      ) : el("div", { class: "muted" }, "—"),

      el("div", { class: "muted", style: "margin:14px 0 10px;" }, "Recent finished"),
      finished.length ? el("ul", { class: "list" },
        ...finished.map(p => el("li", { class: "item" },
          el("div", {},
            el("div", { class: "item-title" }, p?.project?.name || p?.project?.slug || "—"),
            el("div", { class: "item-sub" },
              `mark: ${p?.final_mark ?? "—"} • validated: ${p["validated?"] ? "yes" : "no"} • ${fmtDate(p?.marked_at)}`
            )
          ),
          el("span", { class: "pill" }, `${p?.final_mark ?? "—"}`)
        ))
      ) : el("div", { class: "muted" }, "—"),
    )
  );

  const rawDetails = el("details", {},
    el("summary", {}, el("span", {}, "🧾 Raw JSON (debug)"), el("span", { class: "muted" }, "expand/collapse")),
    el("div", { class: "details-body" },
      el("pre", { class: "mono", style: "white-space:pre-wrap; overflow:auto; max-height:320px; margin:0;" },
        JSON.stringify({ ok: true, me }, null, 2)
      )
    )
  );

  return el("div", {},
    header,
    quick,
    el("div", { class: "grid", style: "margin-top:14px;" },
      el("div", { class: "card" }, cursusDetails, el("div", { style: "height:12px;" }), projCard),
      el("div", { class: "card" }, rawDetails)
    )
  );
}

async function main() {
  const root = document.getElementById("root");

  // Take session from URL or localStorage
  const u = new URL(location.href);
  const sessionFromUrl = u.searchParams.get("session");
  const session = sessionFromUrl || localStorage.getItem("session");

  if (!session) {
    root.innerHTML = "";
    root.appendChild(el("div", { class: "error" }, `No session found. Please Login.`));
    return;
  }

  // Save session to localStorage and clean URL
  localStorage.setItem("session", session);
  if (sessionFromUrl) {
    u.searchParams.delete("session");
    history.replaceState({}, "", u.toString());
  }

  root.textContent = "Loading profile…";

  const res = await fetch(`${WORKER}/session?session=${encodeURIComponent(session)}`);
  if (!res.ok) {
    localStorage.removeItem("session");
    root.innerHTML = "";
    root.appendChild(el("div", { class: "error" }, "Session expired or invalid. Click Login."));
    return;
  }

  const data = await res.json();
  const me = data?.me;
  if (!data?.ok || !me) {
    root.innerHTML = "";
    root.appendChild(el("div", { class: "error" }, "Unexpected server response."));
    return;
  }

  root.innerHTML = "";
  root.appendChild(render(me));
}

main();
