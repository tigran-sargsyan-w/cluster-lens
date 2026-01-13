const WORKER = "https://cluster-42.tigran-sargsyan-w.workers.dev";
const PROFILE_PAGE = "profile.html";
const CLUSTER_PAGE = "cluster.html";

function hasSession(){
  return !!localStorage.getItem("session");
}

function refreshStatus(){
  const logged = hasSession();
  document.getElementById("session-state").textContent = logged ? "present" : "none";

  // Show login buttons when not logged in; show profile/dashboard when logged in
  document.getElementById("btn-login-primary").style.display = logged ? "none" : "inline-block";
  document.getElementById("btn-login-secondary").style.display = logged ? "none" : "inline-block";
  document.getElementById("btn-profile").style.display = logged ? "inline-block" : "none";
  document.getElementById("btn-dashboard-primary").style.display = logged ? "inline-block" : "none";
  document.getElementById("btn-dashboard-secondary").style.display = logged ? "inline-block" : "none";
}

document.getElementById("btn-login-primary").onclick = () => location.href = `${WORKER}/login`;
document.getElementById("btn-login-secondary").onclick = () => location.href = `${WORKER}/login`;
document.getElementById("btn-profile").onclick = () => location.href = PROFILE_PAGE;
document.getElementById("btn-dashboard-primary").onclick = () => location.href = CLUSTER_PAGE;
document.getElementById("btn-dashboard-secondary").onclick = () => location.href = CLUSTER_PAGE;

document.getElementById("btn-clear").onclick = () => {
  localStorage.removeItem("session");
  refreshStatus();
};

refreshStatus();
