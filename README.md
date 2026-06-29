# Service Manager Applet (Cinnamon)

A Cinnamon panel applet for managing **systemd services** and **UFW firewall** directly from the desktop.  
Designed for quick control, status visibility, and lightweight system administration.

---

## Features

- 🔄 Start / Stop / Restart systemd services
- 🔥 Control UFW firewall (enable / disable)
- 📊 Live service status indicators (active / inactive / failed)
- ⚠️ Global status icon (warning/error when services fail or are missing)
- 🧠 Editable service list via built-in UI dialog
- 💾 Persistent configuration saved locally
- 🔐 Uses `pkexec` for privileged actions
- 🕒 Auto-refresh with configurable interval
- 🧩 Clean submenu per service
- 🧰 Optional system tools (System Monitor, Refresh, Restart All)

---

## Supported Service Types

### systemd services
Any `.service` unit can be managed:

- `jellyfin`
- `tailscaled`
- `rustdesk`
- custom services

### UFW firewall
Special handling for:

- `ufw enable`
- `ufw disable`

---

## Requirements

- Linux with Cinnamon Desktop (Linux Mint or compatible)
- `systemd`
- `pkexec` (from `policykit-1`)
- UFW (optional, if using firewall control)

Install dependency:

```bash
sudo apt install policykit-1
