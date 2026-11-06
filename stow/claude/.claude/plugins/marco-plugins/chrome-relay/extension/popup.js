const $ = (id) => document.getElementById(id);

async function refresh() {
  const { connected } = await chrome.storage.session.get("connected");
  $("dot").className = connected ? "on" : "";
  $("status").textContent = connected ? "Connected to Claude" : "Waiting for Claude Code…";
}

(async () => {
  const { port } = await chrome.storage.local.get("port");
  $("port").value = port || 18765;
  refresh();
  setInterval(refresh, 1000);
})();

$("save").onclick = async () => {
  await chrome.storage.local.set({ port: Number($("port").value) || 18765 });
  chrome.runtime.sendMessage({ type: "reconnect" });
};
