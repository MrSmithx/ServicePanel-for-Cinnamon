const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Mainloop = imports.mainloop;
const Util = imports.misc.util;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Settings = imports.ui.settings;

class ServiceManagerApplet extends Applet.IconApplet {

    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);

        this.pkexecAvailable = this.checkPkexec();

        this.settings.bind(
            "refresh-interval",
            "refreshInterval",
            this.onSettingsChanged.bind(this)
        );

        this.settings.bind(
            "show-header",
            "showHeader",
            this.onSettingsChanged.bind(this)
        );

        this.settings.bind(
            "show-edit",
            "showEdit",
            this.onSettingsChanged.bind(this)
        );

        this.settings.bind(
            "show-system-monitor",
            "showSystemMonitor",
            this.onSettingsChanged.bind(this)
        );

        this.settings.bind(
            "show-refresh",
            "showRefresh",
            this.onSettingsChanged.bind(this)
        );

        this.settings.bind(
            "show-restartAll",
            "showRestartAll",
            this.onSettingsChanged.bind(this)
        );

        this.settings.bind(
            "show-footer",
            "showFooter",
            this.onSettingsChanged.bind(this)
        );

        this.configFile = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            "service-manager-applet.json"
        ]);

        this.set_applet_icon_name("system-run");
        this.set_applet_tooltip("Service Manager");

        this.services = this.loadServices() || [
            { name: "Firewall", type: "ufw" },

            { name: "Pi-Hole", type: "systemd", unit: "pihole-FTL" },
            { name: "JellyFin", type: "systemd", unit: "jellyfin" },
            { name: "RustDesk", type: "systemd", unit: "rustdesk" },
            { name: "Tailscale", type: "systemd", unit: "tailscaled" }
        ];

        this._refreshTimer = null;
        this._lastUpdated = null;

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this.buildMenu();
        this._menuBuilt = true;
        this.startLoop();
    }

    checkPkexec() {
        try {
            let [ok] = GLib.spawn_command_line_sync("command -v pkexec");
            return ok && ok.toString().trim().length > 0;
        } catch (e) {
            global.logError("pkexec check failed: " + e);
            return false;
        }
    }

    onSettingsChanged() {
        this.startLoop(); // restart timer with new value
    }

    loadServices() {
        try {
            if (!GLib.file_test(this.configFile, GLib.FileTest.EXISTS))
                return null;

            let [ok, contents] = GLib.file_get_contents(this.configFile);
            if (ok) {
                let data = JSON.parse(contents);
                return data.map(s => ({
                    ...s,
                    last: null,
                    lastRestart: 0,
                    busy: false
                }));
            }
        } catch (e) {
            global.logError("Failed to load services: " + e);
        }
        return null;
    }

    saveServices() {
        try {
            let data = this.services.map(s => ({
                name: s.name,
                type: s.type,
                unit: s.unit
            }));

            GLib.file_set_contents(
                this.configFile,
                JSON.stringify(data, null, 2)
            );
        } catch (e) {
            global.logError("Failed to save services: " + e);
        }
        global.log("Saving services to: " + this.configFile);
    }

    on_applet_clicked(event) {
        if (event.get_button() !== 1) return;

        this.refresh(); // instant update when opening
        this.menu.toggle();
    }

    confirmAction(title, message, callback) {
        let dialog = new ModalDialog.ModalDialog();
        dialog.contentLayout.add_child(new St.Label({ text: title }));
        dialog.contentLayout.add_child(new St.Label({ text: message }));

        dialog.setButtons([
            { label: "Cancel", action: () => dialog.close() },
            { label: "OK", action: () => { dialog.close(); callback(); } }
        ]);

        dialog.open();
    }

    buildMenu() {
        if (this.menu.isOpen) {
            if (this.showFooter) {
                this.updateFooter();
            }
            return; // don't rebuild while visible → prevents flicker
        }

        this.menu.removeAll();

        if (this._header)
            this._header.destroy();

        this._header = new St.Label({
            text: `Service Manager`,
            x_align: Clutter.ActorAlign.CENTER,
            style: `font-size: 16pt; color: #888888; padding: 6px 12px;`
        });
        
        if (this.showHeader) {
            this.menu.box.add_child(this._header);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Services ---
        this.services.forEach(service => {
            let sub = new PopupMenu.PopupSubMenuMenuItem(service.name);
            service.menuItem = sub;

            sub.actor.set_style(`
                margin-bottom: 4px;
                border-radius: 6px;
            `);

            service.startItem = new PopupMenu.PopupIconMenuItem(_("Start Service"), "media-playback-start-symbolic", St.IconType.SYMBOLIC);
            service.stopItem = new PopupMenu.PopupIconMenuItem(_("Stop Service"), "media-playback-stop-symbolic", St.IconType.SYMBOLIC);
            service.restartItem = new PopupMenu.PopupIconMenuItem(_("Restart Service"), "view-refresh-symbolic", St.IconType.SYMBOLIC);

            service.startItem.setSensitive(false);
            service.stopItem.setSensitive(false);
            service.restartItem.setSensitive(false);

            service.startItem.connect("activate", () => this.runAction(service, "start"));
            service.stopItem.connect("activate", () => this.runAction(service, "stop"));
            service.restartItem.connect("activate", () => {
                this.confirmAction("Confirm Restart", `Restart ${service.name}?`, () => this.runAction(service, "restart"));
            });

            if (service.unit === "ufw") {
                service.restartItem.visible = false;
            }

            sub.menu.addMenuItem(service.startItem);
            sub.menu.addMenuItem(service.stopItem);
            sub.menu.addMenuItem(service.restartItem);

            this.menu.addMenuItem(sub);
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Settings section ---
        const editItem = new PopupMenu.PopupIconMenuItem(_("Edit Services"), "document-edit-symbolic", St.IconType.SYMBOLIC);
        editItem.connect("activate", () => this.openEditDialog());
        if (this.showEdit) {
            this.menu.addMenuItem(editItem);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Process Monitor button
        let processMonitor = new PopupMenu.PopupIconMenuItem(_("System Monitor"), "utilities-system-monitor-symbolic", St.IconType.SYMBOLIC);
        processMonitor.connect("activate", () => {
            // Launch system monitor (gnome-system-monitor)
            try {
                Util.spawn(["gnome-system-monitor"]);
            } catch (e) {
                global.logError("Failed to launch System Monitor: " + e);
            }
        });

        // Refresh button
        let refresh = new PopupMenu.PopupIconMenuItem(_("Refresh"), "view-refresh-symbolic", St.IconType.SYMBOLIC);
        refresh.connect("activate", () => this.refresh());

        // Restart All button
        let restartAll = new PopupMenu.PopupIconMenuItem(_("Restart All Services"), "system-reboot-symbolic", St.IconType.SYMBOLIC);
        restartAll.connect("activate", () => {
            this.confirmAction("Confirm Restart", "Restart ALL services?", () => {
                this.services.forEach(s => this.runAction(s, "restart"));
            });
        });

        if (this.showSystemMonitor) {
            this.menu.addMenuItem(processMonitor);
        }
        if (this.showRefresh) {
            this.menu.addMenuItem(refresh);
        }
        if (this.showRestartAll) {
            this.menu.addMenuItem(restartAll);
        }
        if (this.showFooter) {
            this._addFooter();
        }
    }

    _addFooter() {
        if (this._footer) {
            this.menu.box.remove_child(this._footer); // remove old footer if exists
            this._footer.destroy();
        }

        this._footer = new St.BoxLayout({ style_class: "menu-footer",
            vertical: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER});

        let statusLabel = new St.Label({ text: `Last updated : ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`,
            style: `
                font-size: 9pt;
                color: #888888;
                opacity: 0.7;
                padding: 6px 12px;
            `
        });
        this._footer.add_child(statusLabel);

        this.menu.box.add_child(this._footer);
    }

    updateFooter() {
        if (!this._footer) return;

        // Clear existing children
        this._footer.get_children().forEach(child => this._footer.remove_child(child));

        // Add new content
        let statusLabel = new St.Label({ text: `Last updated : ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`,
            style: `
                font-size: 9pt;
                color: #888888;
                opacity: 0.7;
                padding: 6px 12px;
            `
        });
        this._footer.add_child(statusLabel);
    }

    startLoop() {
        if (this._refreshTimer)
            Mainloop.source_remove(this._refreshTimer);

        // Enforce safe bounds
        let interval = Math.min(300, Math.max(5, this.refreshInterval || 15));

        this.refresh();

        this._refreshTimer = Mainloop.timeout_add_seconds(interval, () => {
            this.refresh();
            return true;
        });
    }

    getStatusMeta(status) {
        switch (status) { //🟢🟡🟠🔴
            case "active": return { icon: "🟢", style: "" };
            case "inactive": case "failed": return { icon: "🟡", style: "color:#cc3333;" };
            case "activating": case "deactivating": return { icon: "🟠", style: "color:#cc3333;" };
            default: return { icon: "🔴", style: "color:#cc3333; opacity:0.6;" }; 
        }
    }

    checkService(service) {

        switch (service.type) {

            case "ufw":
                return this.checkUfw(service);

            case "systemd":
            default:
                return this.checkSystemd(service);
        }

        let status = "unknown";
        let exists = false;

        let unit = service.unit.endsWith(".service")
            ? service.unit
            : service.unit + ".service";

        try {
            let [okList, stdoutList] =
                GLib.spawn_command_line_sync(`systemctl list-unit-files ${unit}`);

            if (okList && stdoutList.toString().includes(unit)) {
                exists = true;

                let [okActive, stdoutActive] =
                    GLib.spawn_command_line_sync(`systemctl is-active ${unit}`);

                status = (okActive && stdoutActive)
                    ? stdoutActive.toString().trim()
                    : "inactive";
            }
        } catch (e) {
            global.logError(e);
        }

        this._handleServiceResult(service, status, exists);
    }

    checkUfw(service) {

        let exists =
            GLib.file_test("/usr/sbin/ufw", GLib.FileTest.EXISTS) ||
            GLib.file_test("/usr/bin/ufw", GLib.FileTest.EXISTS);

        let status = "inactive";

        if (exists) {
            try {
                let [ok, out] = GLib.spawn_command_line_sync(
                    "grep '^ENABLED=' /etc/ufw/ufw.conf"
                );

                if (ok && out.toString().includes("yes"))
                    status = "active";

            } catch (e) {
                global.logError(e);
            }
        }

        this._handleServiceResult(service, status, exists);
    }

    checkSystemd(service) {

        let status = "unknown";
        let exists = false;

        let unit = service.unit.endsWith(".service")
            ? service.unit
            : service.unit + ".service";

        try {
            let [okList, stdoutList] =
                GLib.spawn_command_line_sync(`systemctl list-unit-files ${unit}`);

            if (okList && stdoutList.toString().includes(unit)) {
                exists = true;

                let [okActive, stdoutActive] =
                    GLib.spawn_command_line_sync(`systemctl is-active ${unit}`);

                status = (okActive && stdoutActive)
                    ? stdoutActive.toString().trim()
                    : "inactive";
            }
        } catch (e) {
            global.logError(e);
        }

        this._handleServiceResult(service, status, exists);
    }

    refresh() {

        this._failureCount = 0;
        this._hasNotFound = false;

        this.services.forEach(service => {

            if (service.busy)
                return;

            Mainloop.idle_add(() => {
                this.checkService(service);
                return false;
            });

        });

        Mainloop.timeout_add_seconds(1, () => {
            this.updateGlobalStatus(this._failureCount, this._hasNotFound);
            return false;
        });

        this._lastUpdated = new Date();
        this.buildMenu();
    }

    _handleServiceResult(service, status, exists) {
        if (!service.menuItem || !service.menuItem.label) return;

        if (!exists) {
            this._hasNotFound = true;

            // Disable submenu interaction
            service.menuItem.setSensitive(false);

            // Close it if somehow open
            if (service.menuItem.menu)
                service.menuItem.menu.close();

            // Greyed out + consistent spacing
            service.menuItem.label.set_style("color:#cc3333; opacity:0.6;");
            service.menuItem.label.text = `🔴    ${service.name} (Not Found)`;

            return;
        }

        // Re-enable if previously disabled
        service.menuItem.setSensitive(true);

        let { icon, style } = this.getStatusMeta(status);

        if (status === "inactive" || status === "failed")
            this._failureCount++;

        service.menuItem.label.set_style(style);
        service.menuItem.label.text = `${icon}    ${service.name}`;
        service.menuItem.actor.queue_relayout();
        service.menuItem.actor.queue_redraw();

        // Enable/disable buttons
        if (service.startItem && service.stopItem && service.restartItem) {
            if (status === "active") {
                service.startItem.setSensitive(false);
                service.stopItem.setSensitive(true);
                service.restartItem.setSensitive(true);
            } else if (status === "inactive" || status === "failed") {
                service.startItem.setSensitive(true);
                service.stopItem.setSensitive(false);
                service.restartItem.setSensitive(false);
            } else {
                service.startItem.setSensitive(false);
                service.stopItem.setSensitive(false);
                service.restartItem.setSensitive(false);
            }
        }

        service.last = status;
    }

    updateGlobalStatus(failureCount, hasNotFound) {
        let tooltip = "Service Manager";
        if (failureCount > 0) tooltip += ` (${failureCount} issue${failureCount > 1 ? "s" : ""})`;

        if (hasNotFound) this.set_applet_icon_name("dialog-warning");
        else if (failureCount > 0) this.set_applet_icon_name("dialog-error");
        else this.set_applet_icon_name("emblem-default");

        this.set_applet_tooltip(tooltip);
    }

    runAction(service, action) {

        if (!this.pkexecAvailable) {
            if (!this._pkexecWarned) {
                this._pkexecWarned = true;

                this.confirmAction(
                    "Missing dependency",
                    "pkexec is not installed. Install policykit-1 to enable service control.",
                    () => {}
                );
                 this.set_applet_tooltip("pkexec not found - cannot manage services");
            }
            return;
        }

        if (service.busy)
            return;

        service.busy = true;

        switch (service.type) {

            // --------------------
            // UFW FIREWALL
            // --------------------
            case "ufw": {

                let command;

                switch (action) {
                    case "start":
                        command = ["pkexec", "ufw", "enable"];
                        break;

                    case "stop":
                        command = ["pkexec", "ufw", "disable"];
                        break;

                    default:
                        service.busy = false;
                        return;
                }

                Util.spawn_async(command, () => {
                    Mainloop.timeout_add_seconds(1, () => {
                        service.busy = false;
                        this.refresh();
                        return false;
                    });
                });

                return;
            }

            // --------------------
            // SYSTEMD SERVICES
            // --------------------
            case "systemd":
            default: {

                let unit = service.unit.endsWith(".service")
                    ? service.unit
                    : service.unit + ".service";

                let command;

                switch (action) {
                    case "start":
                    case "stop":
                    case "restart":
                        command = ["pkexec", "systemctl", action, unit];
                        break;

                    default:
                        service.busy = false;
                        return;
                }

                // UI feedback
                if (service.menuItem?.label) {
                    service.menuItem.label.text = `⏳ ${service.name}`;
                    service.menuItem.label.set_style("opacity:0.6;");
                }

                if (service.startItem && service.stopItem && service.restartItem) {
                    service.startItem.setSensitive(false);
                    service.stopItem.setSensitive(false);
                    service.restartItem.setSensitive(false);
                }

                // Failsafe timeout
                let timeoutId = Mainloop.timeout_add_seconds(5, () => {
                    service.busy = false;
                    this.refresh();
                    return false;
                });

                Util.spawn_async(command, () => {

                    if (timeoutId)
                        Mainloop.source_remove(timeoutId);

                    Mainloop.timeout_add_seconds(1, () => {
                        service.busy = false;
                        this.refresh();
                        return false;
                    });
                });

                return;
            }
        }
    }

    // --- Edit Services ---
    openEditDialog() {
        const dialog = new ModalDialog.ModalDialog();

        const scrollView = new St.ScrollView({
            x_expand: true,
            y_expand: true,
            style: "padding: 10px;"
        });

        dialog.contentLayout.add_child(scrollView);

        const contentBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: "spacing: 10px;"
        });

        scrollView.add_actor(contentBox);

        const header = new St.Label({
            text: 'Service Configuration',
            x_align: Clutter.ActorAlign.START
        });

        header.set_style(`
            font-weight: 600;
            font-size: 13pt;
            margin-bottom: 6px;
            color: #e6e6e6;
        `);

        contentBox.add_child(header);

        // Add button (more subtle + full width feel)
        const addNewBtn = new St.Button({
            label: '＋ Add Service'
        });

        addNewBtn.set_style(`
            padding: 8px;
            border-radius: 8px;
            background-color: rgba(255,255,255,0.08);
            text-align: center;
        `);

        addNewBtn.connect('clicked', () => {
            addServiceRow('', '', true);
        });

        contentBox.add_child(addNewBtn);

        this.serviceEntries = [];

        const addServiceRow = (name = '', unit = '', focus = false) => {
            const row = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style: `
                    padding: 8px;
                    spacing: 10px;
                    border-radius: 8px;
                    background-color: rgba(255,255,255,0.05);
                `
            });

            const inputBox = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style: "spacing: 8px;"
            });

            const nameEntry = new St.Entry({
                text: name,
                can_focus: true,
                hint_text: 'New Display Name'
            });
            nameEntry.set_x_expand(true);
            nameEntry.set_style('min-width: 130px;');

            const unitEntry = new St.Entry({
                text: unit,
                can_focus: true,
                hint_text: 'New Process Name'
            });
            unitEntry.set_x_expand(true);
            unitEntry.set_style('min-width: 130px;');

            inputBox.add_child(nameEntry);
            inputBox.add_child(unitEntry);

            const delBtn = new St.Button({
                label: '🗑'
            });

            delBtn.set_style(`
                padding: 4px 8px;
                border-radius: 6px;
                background-color: rgba(255,80,80,0.15);
            `);

            delBtn.connect('enter-event', () => {
                delBtn.set_style(`
                    padding: 4px 8px;
                    border-radius: 6px;
                    background-color: rgba(255,80,80,0.3);
                `);
            });

            delBtn.connect('leave-event', () => {
                delBtn.set_style(`
                    padding: 4px 8px;
                    border-radius: 6px;
                    background-color: rgba(255,80,80,0.15);
                `);
            });

            const entry = { row, nameEntry, unitEntry };
            this.serviceEntries.push(entry);

            delBtn.connect('clicked', () => {
                this.confirmAction(
                    "Delete Service",
                    `Remove "${nameEntry.text || "this service"}"?`,
                    () => {
                        contentBox.remove_child(row);
                        this.serviceEntries = this.serviceEntries.filter(e => e !== entry);
                    }
                );
            });

            row.add_child(inputBox);
            row.add_child(delBtn);
            contentBox.add_child(row);

            if (focus) {
                Mainloop.idle_add(() => {
                    nameEntry.grab_key_focus();
                    return false;
                });
            }
        };

        // Existing services
        this.services.forEach(s => addServiceRow(s.name, s.unit));

        // Buttons
        dialog.setButtons([
            {
                label: 'Cancel',
                action: () => dialog.close()
            },
            {
                label: 'Save',
                action: () => {
                    const newServices = [];

                    this.serviceEntries.forEach(entry => {
                        const name = entry.nameEntry.text.trim();
                        const unit = entry.unitEntry.text.trim();

                        if (name && unit) {
                            newServices.push({
                                name,
                                unit,
                                last: null,
                                lastRestart: 0,
                                busy: false
                            });
                        }
                    });

                    this.services = newServices;
                    this.saveServices();
                    this.buildMenu();
                    this.refresh();

                    dialog.close();
                }
            }
        ]);

        dialog.open();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new ServiceManagerApplet(metadata, orientation, panelHeight, instanceId);
}
