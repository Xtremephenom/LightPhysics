import { contextBridge, ipcRenderer } from "electron";

const securityControl = Object.freeze({
  getHumanChannelStatus: () => ipcRenderer.invoke("lightphysics:security-control-status"),
  requestHumanChannelEnrollment: () => ipcRenderer.invoke("lightphysics:security-control-enroll"),
});

// This bridge exposes only bounded status and a request for the main process
// to show its native enrollment dialog. It does not expose process.env,
// filesystem access, the IPC sender, bearer tokens, or sensitive capabilities
// to the existing browser renderer.
const bridge = Object.freeze({
  shell: "electron",
  contextIsolation: true,
  securityControl,
});

contextBridge.exposeInMainWorld("lightPhysicsShell", bridge);
