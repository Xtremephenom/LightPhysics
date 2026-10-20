(() => {
  "use strict";

  let bearerToken = "";
  let toastTimer;

  const elements = {
    pill: document.querySelector("#connection-pill"),
    connectionLabel: document.querySelector("#connection-label"),
    tokenForm: document.querySelector("#token-form"),
    tokenInput: document.querySelector("#token-input"),
    refresh: document.querySelector("#refresh-button"),
    daemonVersion: document.querySelector("#daemon-version"),
    daemonPlatform: document.querySelector("#daemon-platform"),
    inspectorStatus: document.querySelector("#inspector-status"),
    inspectorVersion: document.querySelector("#inspector-version"),
    inspectorPlatform: document.querySelector("#inspector-platform"),
    footerStatus: document.querySelector("#footer-status"),
    footerDot: document.querySelector("#footer-dot"),
    resumeStage: document.querySelector("#resume-stage"),
    resumeBudget: document.querySelector("#resume-budget"),
    resumeDecisionCount: document.querySelector("#resume-decisions-count"),
    resumeStatus: document.querySelector("#resume-status"),
    resumeNextActions: document.querySelector("#resume-next-actions"),
    resumeGateGaps: document.querySelector("#resume-gate-gaps"),
    humanStatus: document.querySelector("#security-human-status"),
    humanNote: document.querySelector("#security-human-note"),
    humanEnroll: document.querySelector("#human-channel-enroll"),
    toast: document.querySelector("#toast"),
    modelsView: document.querySelector("#models-view"),
    modelsNav: document.querySelector('[data-nav="models"]'),
  };

  const securityControl = window.lightPhysicsShell?.securityControl;

  function setText(element, value) {
    if (element) element.textContent = value;
  }

  function renderView() {
    const showModels = window.location.hash === "#models";
    const homeSections = document.querySelectorAll("#studio-floor > section:not(#models-view)");
    for (const section of homeSections) section.hidden = showModels;
    if (elements.modelsView) elements.modelsView.hidden = !showModels;
    for (const item of document.querySelectorAll(".nav-item")) {
      const active = showModels ? item === elements.modelsNav : item.getAttribute("href") === "#studio-floor";
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    if (showModels) setText(elements.footerStatus, "Offline catalog · read-only");
  }

  function showToast(message, error = false) {
    if (!elements.toast) return;
    elements.toast.textContent = message;
    elements.toast.classList.toggle("error", error);
    elements.toast.classList.add("visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("visible"), 4200);
  }

  function setConnection(state, label) {
    elements.pill?.setAttribute("data-state", state);
    setText(elements.connectionLabel, label);
    const connected = state === "connected";
    setText(elements.footerStatus, connected ? "Daemon connected" : state === "error" ? "Connection error" : "Daemon offline");
    elements.footerDot?.classList.toggle("connected", connected);
    setText(elements.inspectorStatus, connected ? "Connected" : state === "error" ? "Error" : "Offline");
    elements.inspectorStatus?.classList.toggle("connected", connected);
  }

  async function rpc(method, params = {}) {
    if (!bearerToken) throw new Error("Enter the daemon bearer token first.");
    const response = await fetch("/rpc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Daemon returned HTTP ${response.status}.`);
    }
    if (!response.ok || body.error) {
      const message = body?.error?.data?.message ?? body?.error?.message ?? `Daemon returned HTTP ${response.status}.`;
      throw new Error(message);
    }
    return body.result;
  }

  function renderList(element, values, emptyLabel) {
    if (!element) return;
    element.replaceChildren();
    const items = Array.isArray(values) && values.length > 0 ? values : [emptyLabel];
    for (const value of items) {
      const item = document.createElement("li");
      item.textContent = String(value);
      element.appendChild(item);
    }
  }

  function renderHumanChannelStatus(status) {
    if (!status || status.available !== true) {
      const inElectron = Boolean(securityControl);
      setText(elements.humanStatus, inElectron ? "Unavailable" : "Electron shell required");
      setText(elements.humanNote, inElectron
        ? "Native enrollment is unavailable on this runtime."
        : "Enrollment is available from the Electron shell only.");
      if (elements.humanEnroll) elements.humanEnroll.disabled = true;
      return;
    }
    if (status.enrolled === true) {
      setText(elements.humanStatus, "Enrolled");
      setText(elements.humanNote, "This device is enrolled; its credential remains in Electron main.");
      if (elements.humanEnroll) elements.humanEnroll.disabled = true;
      return;
    }
    setText(elements.humanStatus, "Not enrolled");
    setText(elements.humanNote, "The Electron main process will ask for native confirmation.");
    if (elements.humanEnroll) elements.humanEnroll.disabled = false;
  }

  async function refreshHumanChannelStatus() {
    if (!securityControl || typeof securityControl.getHumanChannelStatus !== "function") {
      renderHumanChannelStatus(undefined);
      return;
    }
    try {
      renderHumanChannelStatus(await securityControl.getHumanChannelStatus());
    } catch {
      renderHumanChannelStatus(undefined);
    }
  }

  async function refreshProjectResume(showErrors = false) {
    if (!bearerToken) {
      setText(elements.resumeStage, "Waiting for daemon");
      setText(elements.resumeStatus, "Connect to load the project memory brief.");
      return;
    }
    try {
      const brief = await rpc("project.resume");
      setText(elements.resumeStage, brief.stage ?? "Unspecified");
      setText(elements.resumeDecisionCount, String(brief.pendingHumanDecisions?.length ?? 0));
      setText(elements.resumeBudget, `${brief.tokenEstimate ?? "—"} tokens`);
      setText(elements.resumeStatus, `${brief.topWorkOrders?.length ?? 0} active work order(s) · ${brief.staleEvidence?.length ?? 0} stale evidence item(s)`);
      renderList(elements.resumeNextActions, brief.nextActions, "No next action recorded.");
      renderList(elements.resumeGateGaps, brief.gateGaps, "No gate gaps recorded.");
    } catch (error) {
      setText(elements.resumeStage, "Unavailable");
      setText(elements.resumeDecisionCount, "—");
      setText(elements.resumeBudget, "—");
      setText(elements.resumeStatus, "Project memory is not available from this daemon.");
      renderList(elements.resumeNextActions, [], "Start with lp init in the project folder.");
      renderList(elements.resumeGateGaps, [], "Not loaded.");
      if (showErrors) showToast(error instanceof Error ? error.message : "Unable to load project memory.", true);
    }
  }

  async function refreshStatus(showErrors = true) {
    if (!bearerToken) {
      setConnection("idle", "Not connected");
      return;
    }
    setConnection("idle", "Connecting…");
    try {
      const info = await rpc("system.info");
      setConnection("connected", "Connected: lpd");
      setText(elements.daemonVersion, info.version ?? "Ready");
      setText(elements.daemonPlatform, `${info.platform ?? "unknown"} · ${info.nodeVersion ?? "Node"}`);
      setText(elements.inspectorVersion, info.version ?? "—");
      setText(elements.inspectorPlatform, `${info.platform ?? "—"} · ${info.arch ?? "—"}`);
      await refreshProjectResume();
    } catch (error) {
      setConnection("error", "Connection failed");
      setText(elements.daemonVersion, "Offline");
      setText(elements.daemonPlatform, "Check lpd and token");
      setText(elements.inspectorVersion, "—");
      setText(elements.inspectorPlatform, "—");
      await refreshProjectResume();
      if (showErrors) showToast(error instanceof Error ? error.message : "Unable to reach lpd.", true);
    }
  }

  elements.tokenForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = elements.tokenInput?.value?.trim() ?? "";
    if (!value) {
      showToast("Enter the token from the lpd environment.", true);
      elements.tokenInput?.focus();
      return;
    }
    // Deliberately keep the secret in memory only. A future Electron shell will
    // receive it through the Human Channel/keychain instead of this form.
    bearerToken = value;
    void refreshStatus();
  });

  elements.refresh?.addEventListener("click", () => void refreshStatus());
  elements.humanEnroll?.addEventListener("click", async () => {
    if (!securityControl || typeof securityControl.requestHumanChannelEnrollment !== "function") {
      showToast("Open the Electron shell to enroll this device.", true);
      return;
    }
    elements.humanEnroll.disabled = true;
    try {
      const result = await securityControl.requestHumanChannelEnrollment();
      if (result?.ok === true) {
        renderHumanChannelStatus(result.status);
        showToast("Human Channel device enrolled.");
      } else if (result?.code === "ELECTRON_HUMAN_CHANNEL_ENROLLMENT_REQUIRED") {
        renderHumanChannelStatus(result.status);
        showToast("Enrollment cancelled.", true);
      } else {
        renderHumanChannelStatus(result?.status);
        showToast("Human Channel enrollment is unavailable.", true);
      }
    } catch {
      await refreshHumanChannelStatus();
      showToast("Human Channel enrollment is unavailable.", true);
    }
  });
  document.querySelector("#quick-connect")?.addEventListener("click", () => {
    elements.tokenInput?.focus();
    showToast("Enter the token to test the local connection.");
  });
  document.querySelector("#quick-docs")?.addEventListener("click", () => {
    showToast("Start with the Phase 0 README and the Studio Floor guide.");
  });
  document.querySelector("#idea-button")?.addEventListener("click", () => {
    showToast("Idea intake arrives with the Memory module in Phase 1.");
  });
  document.querySelector("#new-project-button")?.addEventListener("click", () => {
    showToast("Project creation arrives with the Memory module in Phase 1.");
  });

  window.addEventListener("hashchange", renderView);
  setConnection("idle", "Not connected");
  renderView();
  void refreshHumanChannelStatus();
})();
