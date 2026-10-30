const API_HOST = window.location.hostname || "localhost";
const API_BASE = window.location.protocol + "//" + API_HOST + ":3000/api";
const SESSION_KEY = "pwa-session";
const THEME_KEY = "pwa-theme";
const WEATHER_STORAGE_KEY = "pwa-weather-snapshot";
let session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
let authMode = "login";
let installPrompt;
let conflictTaskId;
let editingTaskId;
let viewingTaskId;
let taskDetailOpener;
let syncRunning = false;
let syncRequested = false;
let syncRetryTimer;
let notificationTaskOpened = false;
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let calendarSelectedDate = localDateString(new Date());
let calendarTasks = [];

const element = function (id) {
    return document.getElementById(id);
};

function showToast(message) {
    const toast = element("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(showToast.timeout);
    showToast.timeout = window.setTimeout(function () {
        toast.classList.remove("visible");
    }, 3200);
}

function setSyncMessage(message, kind) {
    const banner = element("trangThaiDongBo");
    const messageElement = element("syncMessage");
    if (!banner || !messageElement) return;
    messageElement.textContent = message;
    banner.classList.toggle("sync-error", kind === "error");
    banner.classList.toggle("sync-success", kind === "success");
}

async function apiRequest(path, options) {
    const requestOptions = Object.assign({ method: "GET" }, options || {});
    requestOptions.headers = Object.assign({}, requestOptions.headers || {});
    if (session && session.token) {
        requestOptions.headers.Authorization = "Bearer " + session.token;
    }
    if (requestOptions.body) {
        requestOptions.headers["Content-Type"] = "application/json";
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(function () {
        controller.abort();
    }, 20000);
    requestOptions.signal = controller.signal;
    try {
        const response = await fetch(API_BASE + path, requestOptions);
        const responseText = await response.text();
        let result = {};
        try {
            result = responseText ? JSON.parse(responseText) : {};
        } catch (error) {
            result = {};
        }
        if (!response.ok) {
            const method = requestOptions.method.toUpperCase();
            const message = result.message ||
                (response.status === 404 && method === "DELETE" && path.startsWith("/tasks/")
                    ? "Backend chưa nhận API xóa công việc. Hãy khởi động lại backend rồi thử đồng bộ lại."
                    : "Máy chủ trả về lỗi HTTP " + response.status +
                        " khi " + method + " " + path + ".");
            const error = new Error(message);
            error.status = response.status;
            error.data = result;
            throw error;
        }
        return result;
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("Máy chủ không phản hồi sau 20 giây. Công việc vẫn được giữ trên thiết bị để thử lại.");
        }
        throw error;
    } finally {
        window.clearTimeout(timeout);
    }
}

function saveSession(nextSession) {
    session = nextSession;
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function authError(message) {
    element("authError").textContent = message;
}

function switchAuthMode() {
    authMode = authMode === "login" ? "register" : "login";
    const register = authMode === "register";
    element("authView").classList.toggle("register-mode", register);
    element("authTitle").textContent = register ? "Tạo tài khoản" : "Đăng nhập";
    element("authSubtitle").textContent = register
        ? "Bắt đầu sắp xếp công việc của bạn."
        : "Tiếp tục hành trình hoàn thành mục tiêu của bạn.";
    element("nameField").classList.toggle("d-none", !register);
    element("authName").classList.toggle("d-none", !register);
    element("authName").required = register;
    element("authPassword").minLength = register ? 8 : 1;
    element("authPassword").autocomplete = register ? "new-password" : "current-password";
    element("authSubmit").textContent = register ? "Tạo tài khoản" : "Đăng nhập";
    element("authSwitchText").textContent = register ? "Đã có tài khoản?" : "Chưa có tài khoản?";
    element("authSwitch").textContent = register ? "Đăng nhập" : "Tạo tài khoản";
    authError("");
}

function enterApp(user) {
    session.user = user;
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    const name = user.name || user.email.split("@")[0];
    const accountName = element("accountName");
    if (accountName) accountName.textContent = name;
    const welcomeName = element("welcomeName");
    if (welcomeName) welcomeName.textContent = name;
    const todayLabel = element("todayLabel");
    if (todayLabel) {
        todayLabel.textContent = new Intl.DateTimeFormat("vi-VN", {
            weekday: "long", day: "numeric", month: "long"
        }).format(new Date());
    }
    kiemTraMang();
    hienThiCongViec().catch(reportError);
    refreshQueueCount().catch(reportError);
    layHangDoiDongBo(session.user.id).then(function (queue) {
        if (queue.length) dangKyBackgroundSync();
    }).catch(reportError);
    if (navigator.onLine) {
        dongBoDuLieu().catch(reportError);
    }
    checkReminders();
}

function renderTaskNotifications(tasks) {
    const button = element("taskNotificationButton");
    const countElement = element("taskNotificationCount");
    const summary = element("taskNotificationSummary");
    const list = element("taskNotificationList");
    if (!button || !countElement || !summary || !list) return;

    const incomplete = tasks.filter(function (task) {
        return !task.hoanThanh && !task.deleted;
    }).sort(function (left, right) {
        const leftDue = normalizeDueDate(left.dueAt);
        const rightDue = normalizeDueDate(right.dueAt);
        if (leftDue && rightDue && leftDue !== rightDue) return leftDue.localeCompare(rightDue);
        if (leftDue) return -1;
        if (rightDue) return 1;
        return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    });

    countElement.textContent = incomplete.length > 99 ? "99+" : String(incomplete.length);
    countElement.hidden = incomplete.length === 0;
    button.setAttribute("aria-label", incomplete.length
        ? "Có " + incomplete.length + " công việc chưa hoàn thành"
        : "Không có công việc chưa hoàn thành");
    summary.textContent = incomplete.length
        ? incomplete.length + " việc chưa xong" : "Bạn đã hoàn thành mọi việc!";

    const visibleTasks = incomplete.slice(0, 6);
    if (!visibleTasks.length) {
        const empty = document.createElement("li");
        empty.className = "notification-empty";
        empty.textContent = "Hiện không còn công việc nào cần làm.";
        list.replaceChildren(empty);
        return;
    }

    const today = localDateString(new Date());
    list.replaceChildren.apply(list, visibleTasks.map(function (task) {
        const item = document.createElement("li");
        const link = document.createElement("a");
        const query = new URLSearchParams({
            status: "open",
            taskId: String(task.id)
        });
        link.className = "notification-item";
        link.href = "tasks.html?" + query.toString() + "#tasksSection";

        const title = document.createElement("strong");
        title.textContent = task.noiDung;
        const detail = document.createElement("small");
        const dueAt = normalizeDueDate(task.dueAt);
        if (!dueAt) {
            detail.textContent = "Chưa đặt hạn";
        } else if (dueAt < today) {
            detail.textContent = "Quá hạn · " + new Intl.DateTimeFormat("vi-VN", {
                day: "numeric", month: "short"
            }).format(new Date(dueAt + "T12:00:00"));
            detail.classList.add("notification-overdue");
        } else if (dueAt === today) {
            detail.textContent = "Đến hạn hôm nay";
        } else {
            detail.textContent = "Hạn · " + new Intl.DateTimeFormat("vi-VN", {
                day: "numeric", month: "short"
            }).format(new Date(dueAt + "T12:00:00"));
        }
        link.append(title, detail);
        item.appendChild(link);
        return item;
    }));
}

function initializeTaskNotifications() {
    const button = element("taskNotificationButton");
    const panel = element("taskNotificationPanel");
    if (!button || !panel) return;

    const setOpen = function (open) {
        panel.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
    };
    button.addEventListener("click", function () {
        setOpen(panel.hidden);
    });
    document.addEventListener("click", function (event) {
        if (!(event.target instanceof Node) || button.contains(event.target) ||
            panel.contains(event.target)) return;
        setOpen(false);
    });
    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && !panel.hidden) {
            setOpen(false);
            button.focus();
        }
    });
    panel.addEventListener("click", function (event) {
        if (event.target instanceof Element && event.target.closest("a")) {
            setOpen(false);
        }
    });
}

function reportError(error) {
    console.error(error);
    setSyncMessage(error.message || "Đã xảy ra lỗi. Vui lòng thử lại.", "error");
}

async function handleAuthSubmit(event) {
    event.preventDefault();
    authError("");
    const button = element("authSubmit");
    button.disabled = true;
    try {
        const payload = {
            email: element("authEmail").value.trim(),
            password: element("authPassword").value
        };
        if (authMode === "register") {
            payload.name = element("authName").value.trim();
        }
        const result = await fetch(API_BASE + "/auth/" + authMode, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const body = await result.json().catch(function () { return {}; });
        if (!result.ok) {
            throw new Error(body.message || "Không thể xác thực tài khoản.");
        }
        saveSession({ token: body.data.token, user: body.data.user });
        try {
            await luuPhienDongBo(body.data.token, body.data.user.id);
        } catch (error) {
            console.error("Không thể lưu phiên cho đồng bộ nền:", error);
        }
        window.location.replace("index.html");
    } catch (error) {
        if (!navigator.onLine) {
            authError("Đăng ký và đăng nhập cần kết nối máy chủ. Nếu đã đăng nhập trước đây, hãy tải lại để dùng ngoại tuyến.");
        } else if (error instanceof TypeError) {
            authError("Không kết nối được máy chủ đăng nhập. Hãy chạy backend bằng lệnh npm run dev trong thư mục backend rồi thử lại.");
        } else {
            authError(error.message);
        }
    } finally {
        button.disabled = false;
    }
}

async function initialize() {
    applyTheme(localStorage.getItem(THEME_KEY) || "light");
    if (element("authForm")) {
        element("authForm").addEventListener("submit", handleAuthSubmit);
        element("authSwitch").addEventListener("click", switchAuthMode);
        if (new URLSearchParams(window.location.search).has("expired")) {
            authError("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
        }
        if (session && session.token && session.user) {
            window.location.replace("index.html");
        }
        return;
    }

    if (!element("appView")) return;
    if (!session || !session.token || !session.user) {
        window.location.replace("login.html");
        return;
    }
    try {
        await luuPhienDongBo(session.token, session.user.id);
    } catch (error) {
        console.error("Không thể lưu phiên cho đồng bộ nền:", error);
        setSyncMessage("Không thể bật đồng bộ nền trên thiết bị này.", "error");
    }
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.addEventListener("message", function (event) {
            if (event.data && event.data.type === "BACKGROUND_SYNC_COMPLETE") {
                window.clearTimeout(syncRetryTimer);
                syncRetryTimer = null;
                hienThiCongViec().catch(reportError);
                refreshQueueCount().catch(reportError);
                setSyncMessage("Tiến trình đồng bộ nền đã chạy; dữ liệu trên thiết bị đã được làm mới.", "success");
            }
        });
    }

    const taskForm = element("taskForm");
    if (taskForm) taskForm.addEventListener("submit", themCongViec);
    initializeTaskNotifications();
    const syncButton = element("syncButton");
    if (syncButton) {
        syncButton.addEventListener("click", function () {
            dongBoDuLieu().catch(reportError);
        });
    }
    const themeButton = element("themeButton");
    if (themeButton) {
        themeButton.addEventListener("click", function () {
            applyTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
        });
    }
    const logoutButton = element("logoutButton");
    if (logoutButton) {
        logoutButton.addEventListener("click", function () {
            dangXuat().catch(reportError);
        });
    }
    const taskSearch = element("taskSearch");
    if (taskSearch) taskSearch.addEventListener("input", hienThiCongViec);
    const statusFilter = element("statusFilter");
    if (statusFilter) {
        const requestedStatus = new URLSearchParams(window.location.search).get("status");
        const availableStatuses = Array.from(statusFilter.options).map(function (option) {
            return option.value;
        });
        if (availableStatuses.includes(requestedStatus)) {
            statusFilter.value = requestedStatus;
        }
        const updateSyncViewLinks = function () {
            document.querySelectorAll(".sync-view-link").forEach(function (link) {
                const isActive = link.dataset.syncStatus === statusFilter.value;
                link.classList.toggle("active", isActive);
                if (isActive) link.setAttribute("aria-current", "page");
                else link.removeAttribute("aria-current");
            });
        };
        updateSyncViewLinks();
        statusFilter.addEventListener("change", function () {
            updateSyncViewLinks();
            hienThiCongViec();
        });
    }
    const categoryFilter = element("categoryFilter");
    if (categoryFilter) categoryFilter.addEventListener("change", hienThiCongViec);
    const calendarPrevious = element("calendarPrevious");
    const calendarNext = element("calendarNext");
    const calendarToday = element("calendarToday");
    if (calendarPrevious) {
        calendarPrevious.addEventListener("click", function () {
            changeCalendarMonth(-1);
        });
    }
    if (calendarNext) {
        calendarNext.addEventListener("click", function () {
            changeCalendarMonth(1);
        });
    }
    if (calendarToday) {
        calendarToday.addEventListener("click", function () {
            const today = new Date();
            calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
            calendarSelectedDate = localDateString(today);
            renderDashboardCalendar(calendarTasks);
        });
    }
    const conflictHelp = element("conflictHelp");
    if (conflictHelp) conflictHelp.addEventListener("click", openNextConflict);
    const keepLocal = element("keepLocal");
    if (keepLocal) keepLocal.addEventListener("click", resolveConflictLocal);
    const keepRemote = element("keepRemote");
    if (keepRemote) keepRemote.addEventListener("click", resolveConflictRemote);
    const editForm = element("editForm");
    if (editForm) editForm.addEventListener("submit", saveEditedTask);
    const cancelEdit = element("cancelEdit");
    if (cancelEdit) cancelEdit.addEventListener("click", closeEditDialog);
    const taskDetailModal = element("taskDetailModal");
    const closeTaskDetail = element("closeTaskDetail");
    const closeTaskDetailSecondary = element("closeTaskDetailSecondary");
    const editTaskFromDetail = element("editTaskFromDetail");
    if (closeTaskDetail) closeTaskDetail.addEventListener("click", closeTaskDetailDialog);
    if (closeTaskDetailSecondary) {
        closeTaskDetailSecondary.addEventListener("click", closeTaskDetailDialog);
    }
    if (taskDetailModal) {
        taskDetailModal.addEventListener("click", function (event) {
            if (event.target === taskDetailModal) closeTaskDetailDialog();
        });
        taskDetailModal.addEventListener("keydown", function (event) {
            if (event.key === "Escape") closeTaskDetailDialog();
        });
    }
    if (editTaskFromDetail) {
        editTaskFromDetail.addEventListener("click", function () {
            const id = viewingTaskId;
            closeTaskDetailDialog();
            if (id !== undefined && id !== null) {
                openEditDialog(id).catch(reportError);
            }
        });
    }
    const notificationButton = element("notificationButton");
    if (notificationButton) notificationButton.addEventListener("click", requestNotifications);
    const installButton = element("installButton");
    if (installButton) installButton.addEventListener("click", installApp);
    const phoneAppUrl = element("phoneAppUrl");
    const copyPhoneAppUrl = element("copyPhoneAppUrl");
    const phoneInstallButton = element("phoneInstallButton");
    if (phoneAppUrl) {
        const phoneAppOrigin = new URL(window.location.origin);
        if (["localhost", "127.0.0.1", "::1"].includes(phoneAppOrigin.hostname)) {
            phoneAppOrigin.hostname = "192.168.1.2";
        }
        phoneAppUrl.value = phoneAppOrigin.origin + window.location.pathname.replace(/index\.html$/, "");
        const help = element("phoneInstallHelp");
        if (help && (window.location.hostname === "localhost" ||
            window.location.hostname === "127.0.0.1")) {
            help.textContent = "Mở địa chỉ trên bằng điện thoại cùng Wi-Fi với máy tính. Nếu không truy cập được, hãy kiểm tra máy tính và điện thoại đang dùng cùng mạng.";
        } else if (help && !window.isSecureContext) {
            help.textContent = "Android: Chrome menu ⋮ → Thêm vào màn hình chính. iPhone: Safari → Chia sẻ → Thêm vào MH chính. Với HTTP nội bộ, đây chỉ là lối tắt; cài PWA và dùng ngoại tuyến cần HTTPS.";
        } else if (help) {
            help.textContent = "Android: mở bằng Chrome rồi chọn menu ⋮ → Cài đặt ứng dụng. iPhone: mở bằng Safari → Chia sẻ → Thêm vào MH chính.";
        }
    }
    if (copyPhoneAppUrl) {
        copyPhoneAppUrl.addEventListener("click", async function () {
            const urlInput = element("phoneAppUrl");
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(urlInput.value);
                } else {
                    urlInput.focus();
                    urlInput.select();
                    if (!document.execCommand("copy")) {
                        throw new Error("Không thể sao chép tự động.");
                    }
                }
                showToast("Đã sao chép địa chỉ ứng dụng.");
            } catch (error) {
                urlInput.focus();
                urlInput.select();
                showToast("Hãy sao chép địa chỉ đang được chọn.");
            }
        });
    }
    if (phoneInstallButton) {
        phoneInstallButton.addEventListener("click", function () {
            installApp().catch(reportError);
        });
    }
    const weatherLocate = element("weatherLocate");
    if (weatherLocate) {
        weatherLocate.addEventListener("click", function () {
            getWeatherFromLocation().catch(reportWeatherError);
        });
    }
    const weatherCityForm = element("weatherCityForm");
    if (weatherCityForm) {
        weatherCityForm.addEventListener("submit", function (event) {
            event.preventDefault();
            getWeatherForCity(element("weatherCity").value).catch(reportWeatherError);
        });
    }
    restoreWeatherSnapshot();

    window.addEventListener("online", function () {
        kiemTraMang();
        dongBoDuLieu().catch(reportError);
    });
    window.addEventListener("offline", kiemTraMang);
    window.addEventListener("beforeinstallprompt", function (event) {
        event.preventDefault();
        installPrompt = event;
        const button = element("installButton");
        if (button) button.classList.remove("d-none");
        const phoneButton = element("phoneInstallButton");
        if (phoneButton) phoneButton.classList.remove("d-none");
    });
    window.addEventListener("appinstalled", function () {
        const button = element("installButton");
        if (button) button.classList.add("d-none");
        const phoneButton = element("phoneInstallButton");
        if (phoneButton) phoneButton.classList.add("d-none");
        showToast("Đã cài ứng dụng thành công.");
    });
    window.setInterval(checkReminders, 60 * 1000);

    enterApp(session.user);
    if (navigator.onLine) {
        try {
            const result = await apiRequest("/auth/me");
            session.user = result.data.user;
            localStorage.setItem(SESSION_KEY, JSON.stringify(session));
            enterApp(session.user);
        } catch (error) {
            if (error.status === 401) {
                localStorage.removeItem(SESSION_KEY);
                session = null;
                await xoaPhienDongBo();
                window.location.replace("login.html?expired=1");
            } else {
                setSyncMessage("Đang ngoại tuyến. Thay đổi sẽ được xếp hàng trên thiết bị.", "error");
            }
        }
    }
}

function applyTheme(theme) {
    document.body.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    const themeButton = element("themeButton");
    if (themeButton) {
        themeButton.innerHTML = theme === "dark"
            ? '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>'
            : '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M20.2 15.1A8.5 8.5 0 0 1 8.9 3.8 8.5 8.5 0 1 0 20.2 15.1Z"/></svg>';
    }
    document.querySelector('meta[name="theme-color"]').content =
        theme === "dark" ? "#171827" : "#0f766e";
}

function kiemTraMang() {
    const status = element("trangThaiMang");
    if (!status) return;
    status.classList.toggle("offline", !navigator.onLine);
    status.setAttribute("aria-label", navigator.onLine
        ? "Đang trực tuyến"
        : "Đang ngoại tuyến");
    status.title = navigator.onLine ? "Đang trực tuyến" : "Đang ngoại tuyến";
    status.innerHTML = navigator.onLine
        ? '<span class="status-dot"></span> Online'
        : '<span class="status-dot offline"></span> Offline';
    if (!navigator.onLine) {
        setSyncMessage("Bạn đang ngoại tuyến. Thay đổi được lưu vào hàng đợi đồng bộ.");
    }
}

function newTaskId() {
    if (crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return "task-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

async function themCongViec(event) {
    event.preventDefault();
    const input = element("congViec");
    const content = input.value.trim();
    if (!content) {
        input.focus();
        return;
    }
    if (element("taskReminder").checked && !("Notification" in window)) {
        showToast("Trình duyệt này không hỗ trợ thông báo nhắc việc.");
        element("taskReminder").checked = false;
    }
    const task = {
        id: newTaskId(),
        ownerId: String(session.user.id),
        noiDung: content,
        description: element("taskDescription").value.trim(),
        hoanThanh: false,
        category: element("taskCategory").value,
        dueAt: element("taskDueDate").value || null,
        reminder: element("taskReminder").checked,
        serverVersion: 0,
        dirty: true,
        deleted: false,
        updatedAt: new Date().toISOString()
    };
    await luuCongViec(task);
    element("taskForm").reset();
    await hienThiCongViec();
    await refreshQueueCount();
    if (!navigator.onLine) {
        await luuCongViec(task, "upsert");
        setSyncMessage("Đã lưu trên thiết bị. Sẽ đồng bộ lên máy chủ khi có mạng.");
        await refreshQueueCount();
        return;
    }

    setSyncMessage("Đang lưu công việc lên máy chủ...");
    try {
        const result = await apiRequest("/tasks/" + encodeURIComponent(task.id), {
            method: "PUT",
            body: JSON.stringify(apiTask(task))
        });
        await luuCongViec(taskFromServer(result.data.task, session.user.id, task.id));
        await hienThiCongViec();
        await refreshQueueCount();
        setSyncMessage("Đã lưu công việc vào cơ sở dữ liệu.", "success");
    } catch (error) {
        if (error.status === 409 && error.data.current &&
            taskMatchesServer(task, error.data.current)) {
            await luuCongViec(taskFromServer(error.data.current, session.user.id, task.id));
            await hienThiCongViec();
            await refreshQueueCount();
            setSyncMessage("Công việc đã có trên máy chủ và được xác nhận đồng bộ.", "success");
            return;
        }

        await luuCongViec(task, "upsert");
        await refreshQueueCount();
        setSyncMessage(
            "Chưa lưu được vào cơ sở dữ liệu; công việc đang chờ đồng bộ. " + error.message,
            "error"
        );
        if (error.status === 401) {
            console.error("Phiên đăng nhập hết hạn khi lưu công việc:", error);
        } else {
            console.error("Không thể lưu công việc lên máy chủ:", error);
        }
    }
}

function isOverdue(task) {
    const dueDate = normalizeDueDate(task.dueAt);
    return Boolean(dueDate && dueDate < localDateString(new Date()) && !task.hoanThanh);
}

function hienThiCongViecSapDenHan(tasks) {
    renderDashboardCalendar(tasks);
    const list = element("upcomingTaskList");
    if (!list) return;

    const today = localDateString(new Date());
    const lastDay = new Date();
    lastDay.setDate(lastDay.getDate() + 7);
    const lastDayString = localDateString(lastDay);
    const upcoming = tasks
        .filter(function (task) {
            if (task.hoanThanh) return false;
            const dueAt = normalizeDueDate(task.dueAt);
            return Boolean(dueAt && dueAt <= lastDayString);
        })
        .sort(function (left, right) {
            return normalizeDueDate(left.dueAt).localeCompare(normalizeDueDate(right.dueAt));
        })
        .slice(0, 3);

    if (!upcoming.length) {
        const empty = document.createElement("li");
        empty.className = "upcoming-empty";
        empty.textContent = "Chưa có công việc quá hạn hoặc sắp đến hạn trong 7 ngày tới.";
        list.replaceChildren(empty);
        return;
    }

    const dateFormatter = new Intl.DateTimeFormat("vi-VN", {
        day: "numeric",
        month: "short"
    });
    list.replaceChildren.apply(list, upcoming.map(function (task) {
        const item = document.createElement("li");
        item.className = "upcoming-task";

        const marker = document.createElement("span");
        marker.className = "upcoming-task-marker" + (isOverdue(task) ? " overdue" : "");
        marker.setAttribute("aria-hidden", "true");

        const details = document.createElement("div");
        details.className = "upcoming-task-details";

        const title = document.createElement("strong");
        title.className = "upcoming-task-title";
        title.textContent = task.noiDung;

        const dueDate = normalizeDueDate(task.dueAt);
        const date = document.createElement("small");
        date.className = "upcoming-task-date" + (isOverdue(task) ? " overdue" : "");
        date.textContent = isOverdue(task)
            ? "Quá hạn · " + dateFormatter.format(new Date(dueDate + "T12:00:00"))
            : dueDate === today
                ? "Hôm nay"
                : "Hạn · " + dateFormatter.format(new Date(dueDate + "T12:00:00"));

        details.append(title, date);
        item.append(marker, details);
        return item;
    }));
}

function changeCalendarMonth(offset) {
    calendarMonth = new Date(
        calendarMonth.getFullYear(),
        calendarMonth.getMonth() + offset,
        1
    );
    calendarSelectedDate = localDateString(calendarMonth);
    renderDashboardCalendar(calendarTasks);
}

function renderDashboardCalendar(tasks) {
    const daysContainer = element("calendarDays");
    if (!daysContainer) return;
    calendarTasks = tasks.filter(function (task) {
        return !task.deleted && Boolean(normalizeDueDate(task.dueAt));
    });

    const monthTitle = element("calendarMonth");
    monthTitle.textContent = new Intl.DateTimeFormat("vi-VN", {
        month: "long",
        year: "numeric"
    }).format(calendarMonth);

    const dueTasks = new Map();
    calendarTasks.forEach(function (task) {
        const dueAt = normalizeDueDate(task.dueAt);
        if (!dueAt) return;
        if (!dueTasks.has(dueAt)) dueTasks.set(dueAt, []);
        dueTasks.get(dueAt).push(task);
    });

    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = localDateString(new Date());
    const cells = [];
    for (let index = 0; index < firstWeekday; index += 1) {
        const blank = document.createElement("span");
        blank.className = "calendar-day-empty";
        blank.setAttribute("aria-hidden", "true");
        cells.push(blank);
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
        const date = localDateString(new Date(year, month, day));
        const tasksForDay = dueTasks.get(date) || [];
        const button = document.createElement("button");
        button.className = "calendar-day";
        button.type = "button";
        button.textContent = day;
        button.setAttribute("aria-pressed", String(date === calendarSelectedDate));
        button.setAttribute("aria-label",
            new Intl.DateTimeFormat("vi-VN", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric"
            }).format(new Date(year, month, day)) +
            (tasksForDay.length ? ", " + tasksForDay.length + " công việc đến hạn" : ""));
        if (date === today) button.classList.add("is-today");
        if (date === calendarSelectedDate) button.classList.add("is-selected");
        if (tasksForDay.length) {
            button.classList.add("has-tasks");
            const marker = document.createElement("span");
            marker.className = "calendar-day-marker";
            marker.setAttribute("aria-hidden", "true");
            button.appendChild(marker);
        }
        button.addEventListener("click", function () {
            calendarSelectedDate = date;
            renderDashboardCalendar(calendarTasks);
        });
        cells.push(button);
    }

    daysContainer.replaceChildren.apply(daysContainer, cells);
    renderCalendarAgenda(dueTasks);
}

function renderCalendarAgenda(dueTasks) {
    const label = element("calendarSelectedLabel");
    const list = element("calendarTaskList");
    if (!label || !list) return;
    label.textContent = new Intl.DateTimeFormat("vi-VN", {
        weekday: "long",
        day: "numeric",
        month: "long"
    }).format(new Date(calendarSelectedDate + "T12:00:00"));
    const tasks = dueTasks.get(calendarSelectedDate) || [];
    if (!tasks.length) {
        const empty = document.createElement("li");
        empty.className = "calendar-empty";
        empty.textContent = "Không có công việc đến hạn trong ngày này.";
        list.replaceChildren(empty);
        return;
    }

    list.replaceChildren.apply(list, tasks.map(function (task) {
        const item = document.createElement("li");
        item.className = "calendar-task" + (task.hoanThanh ? " is-completed" : "");
        const marker = document.createElement("span");
        marker.className = "calendar-task-marker";
        marker.setAttribute("aria-hidden", "true");
        const title = document.createElement("span");
        title.textContent = task.noiDung;
        item.append(marker, title);
        return item;
    }));
}

function localDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function normalizeDueDate(value) {
    if (!value) return null;
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        return localDateString(value);
    }
    const text = String(value);
    const isoDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoDate) {
        const [year, month, day] = isoDate[1].split("-").map(Number);
        const parsedDate = new Date(year, month - 1, day);
        if (parsedDate.getFullYear() !== year ||
            parsedDate.getMonth() !== month - 1 ||
            parsedDate.getDate() !== day) {
            return null;
        }
        return isoDate[1];
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : localDateString(parsed);
}

function makeTaskElement(task) {
    const li = document.createElement("li");
    li.className = "list-group-item task-item" + (task.hoanThanh ? " completed" : "");

    const main = document.createElement("div");
    main.className = "task-main";
    const checkbox = document.createElement("input");
    checkbox.className = "form-check-input task-checkbox";
    checkbox.type = "checkbox";
    checkbox.checked = task.hoanThanh;
    checkbox.setAttribute("aria-label", "Đánh dấu hoàn thành");
    checkbox.addEventListener("change", function () {
        doiTrangThai(task.id).catch(reportError);
    });
    const details = document.createElement("div");
    details.className = "task-details";
    details.setAttribute("role", "button");
    details.tabIndex = 0;
    details.setAttribute("aria-label", "Xem chi tiết: " + task.noiDung);
    details.title = "Nhấn để xem chi tiết công việc";
    details.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            taskDetailOpener = event.currentTarget;
            openTaskDetail(task.id).catch(reportError);
        }
    });
    const title = document.createElement("span");
    title.className = "task-title";
    title.textContent = task.noiDung;
    details.appendChild(title);
    if (task.description) {
        const description = document.createElement("p");
        description.className = "task-description";
        description.textContent = task.description;
        details.appendChild(description);
    }
    const metadata = document.createElement("div");
    metadata.className = "task-metadata";
    const category = document.createElement("span");
    category.className = "category-chip";
    category.textContent = task.category || "Cá nhân";
    metadata.appendChild(category);
    const dueAt = normalizeDueDate(task.dueAt);
    if (dueAt) {
        const due = document.createElement("span");
        due.className = "due-chip" + (isOverdue(task) ? " overdue" : "");
        due.textContent = (isOverdue(task) ? "Trễ hạn · " : "Hạn · ") +
            new Intl.DateTimeFormat("vi-VN", { day: "numeric", month: "short" })
                .format(new Date(dueAt + "T12:00:00"));
        metadata.appendChild(due);
    }
    if (task.reminder) {
        const reminder = document.createElement("span");
        reminder.className = "reminder-chip";
        reminder.textContent = "♧ Nhắc";
        metadata.appendChild(reminder);
    }
    details.appendChild(metadata);
    main.append(checkbox, details);

    const actions = document.createElement("div");
    actions.className = "task-actions";
    const syncState = document.createElement("span");
    syncState.className = "task-sync-state " + (task.dirty ? "pending" : "synced");
    syncState.textContent = task.dirty ? "Chờ đồng bộ" : "Đã đồng bộ";
    actions.appendChild(syncState);
    if (task.conflict) {
        const conflictButton = document.createElement("button");
        conflictButton.className = "btn btn-sm conflict-button";
        conflictButton.textContent = "Xung đột";
        conflictButton.addEventListener("click", function () { openConflict(task.id); });
        actions.appendChild(conflictButton);
    }
    const editButton = document.createElement("button");
    editButton.className = "btn btn-sm edit-button";
    editButton.textContent = "Sửa";
    editButton.addEventListener("click", function () {
        openEditDialog(task.id).catch(reportError);
    });
    const deleteButton = document.createElement("button");
    deleteButton.className = "btn btn-sm delete-button";
    deleteButton.textContent = "Xóa";
    deleteButton.addEventListener("click", function () {
        xoaCongViec(task.id).catch(reportError);
    });
    actions.append(editButton, deleteButton);
    li.append(main, actions);
    li.addEventListener("click", function (event) {
        if (event.target.closest("button, input")) return;
        taskDetailOpener = details;
        openTaskDetail(task.id).catch(reportError);
    });
    return li;
}

async function openTaskDetail(id) {
    const task = await layCongViecLocal(session.user.id, id);
    if (!task) {
        showToast("Không tìm thấy công việc này.");
        return;
    }
    viewingTaskId = id;
    element("taskDetailTitle").textContent = task.noiDung;
    element("taskDetailDescription").textContent = task.description || "Chưa có mô tả cho công việc này.";
    element("taskDetailStatus").textContent = task.hoanThanh ? "Đã hoàn thành" : "Chưa hoàn thành";
    element("taskDetailCategory").textContent = task.category || "Cá nhân";
    const dueAt = normalizeDueDate(task.dueAt);
    element("taskDetailDueDate").textContent = dueAt
        ? new Intl.DateTimeFormat("vi-VN", {
            day: "numeric",
            month: "long",
            year: "numeric"
        }).format(new Date(dueAt + "T12:00:00")) + (isOverdue(task) ? " · Trễ hạn" : "")
        : "Chưa đặt hạn";
    element("taskDetailReminder").textContent = task.reminder ? "Đã bật" : "Chưa bật";
    element("taskDetailSync").textContent = task.dirty ? "Đang chờ đồng bộ" : "Đã đồng bộ";
    element("taskDetailModal").classList.remove("d-none");
    element("closeTaskDetail").focus();
}

function closeTaskDetailDialog() {
    const modal = element("taskDetailModal");
    if (modal) modal.classList.add("d-none");
    viewingTaskId = null;
    if (taskDetailOpener && taskDetailOpener.isConnected) taskDetailOpener.focus();
    taskDetailOpener = null;
}

function weatherDescription(code) {
    const descriptions = {
        0: ["Trời quang", "☀"],
        1: ["Ít mây", "🌤"],
        2: ["Có mây", "⛅"],
        3: ["Nhiều mây", "☁"],
        45: ["Sương mù", "〰"],
        48: ["Sương muối", "〰"],
        51: ["Mưa phùn nhẹ", "🌦"],
        53: ["Mưa phùn", "🌦"],
        55: ["Mưa phùn dày", "🌧"],
        56: ["Mưa phùn lạnh", "🌧"],
        57: ["Mưa phùn lạnh dày", "🌧"],
        61: ["Mưa nhẹ", "🌧"],
        63: ["Mưa vừa", "🌧"],
        65: ["Mưa lớn", "🌧"],
        66: ["Mưa lạnh nhẹ", "🌧"],
        67: ["Mưa lạnh lớn", "🌧"],
        71: ["Tuyết nhẹ", "🌨"],
        73: ["Tuyết vừa", "🌨"],
        75: ["Tuyết lớn", "❄"],
        77: ["Mưa tuyết", "🌨"],
        80: ["Mưa rào nhẹ", "🌦"],
        81: ["Mưa rào", "🌧"],
        82: ["Mưa rào lớn", "⛈"],
        85: ["Tuyết rào nhẹ", "🌨"],
        86: ["Tuyết rào lớn", "❄"],
        95: ["Dông", "⛈"],
        96: ["Dông, mưa đá nhẹ", "⛈"],
        99: ["Dông, mưa đá", "⛈"]
    };
    return descriptions[code] || ["Không rõ thời tiết", "☁"];
}

function reportWeatherError(error) {
    console.error("Không thể tải dự báo thời tiết:", error);
    const message = element("weatherMessage");
    if (message) message.textContent = error.message || "Không thể tải thời tiết. Hãy thử lại.";
}

function restoreWeatherSnapshot() {
    try {
        const snapshot = JSON.parse(localStorage.getItem(WEATHER_STORAGE_KEY) || "null");
        if (snapshot && snapshot.current && Array.isArray(snapshot.days)) {
            renderWeather(snapshot, "Đang dùng dự báo đã lưu trên thiết bị.");
        }
    } catch (error) {
        console.warn("Không đọc được dự báo thời tiết đã lưu:", error);
    }
}

function getWeatherFromLocation() {
    if (!navigator.geolocation) {
        return Promise.reject(new Error(
            "Trình duyệt này không hỗ trợ xác định vị trí. Hãy nhập tên thành phố."
        ));
    }
    const message = element("weatherMessage");
    message.textContent = "Đang xác định vị trí…";
    return new Promise(function (resolve, reject) {
        navigator.geolocation.getCurrentPosition(function (position) {
            fetchWeather(position.coords.latitude, position.coords.longitude, "Vị trí hiện tại")
                .then(resolve, reject);
        }, function (error) {
            const messages = {
                1: "Bạn chưa cấp quyền vị trí. Hãy nhập tên thành phố để xem thời tiết.",
                2: "Không xác định được vị trí. Hãy thử lại hoặc nhập tên thành phố.",
                3: "Xác định vị trí quá lâu. Hãy thử lại hoặc nhập tên thành phố."
            };
            reject(new Error(messages[error.code] || "Không lấy được vị trí thiết bị."));
        }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 });
    });
}

async function getWeatherForCity(city) {
    const name = city.trim();
    if (!name) throw new Error("Hãy nhập tên thành phố trước khi tìm.");
    if (!navigator.onLine) {
        throw new Error("Bạn đang ngoại tuyến. Hãy kết nối Internet để tìm thành phố.");
    }
    element("weatherMessage").textContent = "Đang tìm thành phố…";
    const response = await fetch(
        "https://geocoding-api.open-meteo.com/v1/search?name=" +
        encodeURIComponent(name) + "&count=1&language=vi&format=json"
    );
    if (!response.ok) throw new Error("Không tìm được thành phố. Vui lòng thử lại.");
    const result = await response.json();
    const place = result.results && result.results[0];
    if (!place) throw new Error("Không tìm thấy thành phố này. Hãy kiểm tra tên và thử lại.");
    const location = [place.name, place.admin1].filter(function (part, index, values) {
        return part && values.indexOf(part) === index;
    }).join(", ");
    await fetchWeather(place.latitude, place.longitude, location);
}

async function fetchWeather(latitude, longitude, location) {
    if (!navigator.onLine) throw new Error("Bạn đang ngoại tuyến. Hãy kết nối Internet để cập nhật dự báo.");
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" +
        encodeURIComponent(latitude) + "&longitude=" + encodeURIComponent(longitude) +
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
        "&timezone=auto&forecast_days=3";
    const response = await fetch(url);
    if (!response.ok) throw new Error("Dịch vụ thời tiết tạm thời không khả dụng.");
    const data = await response.json();
    if (!data.current || !data.daily || !Array.isArray(data.daily.time)) {
        throw new Error("Dữ liệu dự báo thời tiết không hợp lệ.");
    }
    const snapshot = {
        location: location,
        current: {
            temperature: data.current.temperature_2m,
            apparentTemperature: data.current.apparent_temperature,
            humidity: data.current.relative_humidity_2m,
            code: data.current.weather_code
        },
        days: data.daily.time.map(function (date, index) {
            return {
                date: date,
                code: data.daily.weather_code[index],
                high: data.daily.temperature_2m_max[index],
                low: data.daily.temperature_2m_min[index],
                precipitation: data.daily.precipitation_probability_max[index]
            };
        })
    };
    renderWeather(snapshot, "Dự báo 3 ngày · Open-Meteo");
    try {
        localStorage.setItem(WEATHER_STORAGE_KEY, JSON.stringify(snapshot));
    } catch (error) {
        console.warn("Không lưu được dự báo thời tiết trên thiết bị:", error);
    }
}

function renderWeather(snapshot, message) {
    const current = snapshot.current;
    const condition = weatherDescription(Number(current.code));
    element("weatherIcon").textContent = condition[1];
    element("weatherTemperature").textContent = Math.round(Number(current.temperature)) + "°";
    element("weatherCondition").textContent = condition[0] +
        (Number.isFinite(Number(current.apparentTemperature))
            ? " · Cảm giác " + Math.round(Number(current.apparentTemperature)) + "°"
            : "");
    element("weatherLocation").textContent = snapshot.location || "Thời tiết";
    const forecast = element("weatherForecast");
    forecast.replaceChildren.apply(forecast, snapshot.days.map(function (day, index) {
        const item = document.createElement("div");
        item.className = "weather-day";
        const label = document.createElement("span");
        label.textContent = index === 0 ? "Hôm nay" : new Intl.DateTimeFormat("vi-VN", {
            weekday: "short"
        }).format(new Date(day.date + "T12:00:00"));
        const icon = document.createElement("span");
        icon.className = "weather-day-icon";
        icon.textContent = weatherDescription(Number(day.code))[1];
        const temperatures = document.createElement("strong");
        temperatures.textContent = Math.round(Number(day.high)) + "° / " +
            Math.round(Number(day.low)) + "°";
        item.append(label, icon, temperatures);
        if (day.precipitation !== null && day.precipitation !== undefined &&
            Number.isFinite(Number(day.precipitation))) {
            const rain = document.createElement("small");
            rain.textContent = "Mưa " + Math.round(Number(day.precipitation)) + "%";
            item.appendChild(rain);
        }
        return item;
    }));
    element("weatherMessage").textContent = message;
}

async function hienThiCongViec() {
    if (!session || !session.user) return;
    const tasks = await layTatCaCongViec(session.user.id);
    renderTaskNotifications(tasks);
    const doneCount = tasks.filter(function (task) { return task.hoanThanh; }).length;
    const overdueCount = tasks.filter(isOverdue).length;
    const statTotal = element("statTotal");
    const statDone = element("statDone");
    const statOpen = element("statOpen");
    const statProgress = element("statProgress");
    const statOverdue = element("statOverdue");
    if (statTotal) statTotal.textContent = tasks.length;
    if (statDone) statDone.textContent = doneCount;
    if (statOpen) statOpen.textContent = tasks.length - doneCount;
    if (statProgress) {
        statProgress.textContent = (tasks.length
            ? Math.round(doneCount / tasks.length * 100) : 0) + "% hoàn thành";
    }
    if (statOverdue) {
        statOverdue.textContent = overdueCount
            ? overdueCount + " việc quá hạn" : "Không có việc trễ hạn";
    }
    hienThiCongViecSapDenHan(tasks);
    const list = element("danhSach");
    if (!list) {
        await refreshQueueCount();
        return;
    }
    const searchElement = element("taskSearch");
    const statusElement = element("statusFilter");
    const categoryElement = element("categoryFilter");
    const search = searchElement ? searchElement.value.trim().toLocaleLowerCase("vi") : "";
    const status = statusElement ? statusElement.value : "all";
    const category = categoryElement ? categoryElement.value : "all";
    const queuedIds = status === "sync" || status === "synced"
        ? new Set((await layHangDoiDongBo(session.user.id)).map(function (entry) {
            return String(entry.id);
        }))
        : null;
    const visible = tasks.filter(function (task) {
        const searchableText = [task.noiDung, task.description || ""]
            .join(" ").toLocaleLowerCase("vi");
        const matchSearch = searchableText.includes(search);
        const matchCategory = category === "all" || (task.category || "Cá nhân") === category;
        const matchStatus = status === "all" ||
            (status === "open" && !task.hoanThanh) ||
            (status === "done" && task.hoanThanh) ||
            (status === "overdue" && isOverdue(task)) ||
            (status === "sync" && (task.dirty || queuedIds.has(String(task.id)))) ||
            (status === "synced" && !task.dirty && !queuedIds.has(String(task.id)));
        return matchSearch && matchCategory && matchStatus;
    }).sort(function (left, right) {
        if (left.hoanThanh !== right.hoanThanh) {
            return Number(left.hoanThanh) - Number(right.hoanThanh);
        }
        if (left.dueAt && right.dueAt && left.dueAt !== right.dueAt) {
            return left.dueAt.localeCompare(right.dueAt);
        }
        if (left.dueAt) return -1;
        if (right.dueAt) return 1;
        return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    });

    list.replaceChildren.apply(list, visible.map(makeTaskElement));
    if (!notificationTaskOpened && window.location.search) {
        const taskId = new URLSearchParams(window.location.search).get("taskId");
        if (taskId && visible.some(function (task) {
            return String(task.id) === taskId;
        })) {
            notificationTaskOpened = true;
            const query = new URLSearchParams(window.location.search);
            query.delete("taskId");
            const remainingQuery = query.toString();
            const nextUrl = window.location.pathname +
                (remainingQuery ? "?" + remainingQuery : "") + window.location.hash;
            window.history.replaceState(null, "", nextUrl);
            await openTaskDetail(taskId);
        }
    }
    const emptyState = element("emptyState");
    if (emptyState) {
        emptyState.classList.toggle("d-none", visible.length !== 0);
        const emptyTitle = emptyState.querySelector("strong");
        const emptyDescription = emptyState.querySelector("small");
        const emptyMessages = {
            done: ["Chưa có công việc hoàn thành", "Các công việc đã hoàn thành sẽ hiển thị ở đây."],
            open: ["Bạn đã hoàn thành tất cả", "Hiện không còn công việc nào cần xử lý."],
            overdue: ["Không có công việc trễ hạn", "Các công việc quá hạn sẽ hiển thị ở đây."],
            sync: ["Không có công việc chờ đồng bộ", "Các thay đổi offline sẽ xuất hiện ở đây."],
            synced: ["Chưa có công việc đã đồng bộ", "Công việc sẽ xuất hiện ở đây sau khi gửi thành công."]
        };
        const message = emptyMessages[status] || [
            "Chưa có công việc phù hợp",
            "Thêm một việc mới hoặc thử đổi bộ lọc nhé."
        ];
        if (emptyTitle) emptyTitle.textContent = message[0];
        if (emptyDescription) emptyDescription.textContent = message[1];
    }
    const taskCount = element("taskCount");
    if (taskCount) taskCount.textContent = visible.length + " việc";
    await refreshQueueCount();
}

async function refreshQueueCount() {
    if (!session || !session.user) return;
    const queue = await layHangDoiDongBo(session.user.id);
    const statQueue = element("statQueue");
    const statSyncHint = element("statSyncHint");
    if (statQueue) statQueue.textContent = queue.length;
    if (statSyncHint) {
        statSyncHint.textContent = queue.length
            ? "Đang chờ kết nối để gửi" : "Tất cả thay đổi đã gửi";
    }
}

async function openEditDialog(id) {
    const task = await layCongViecLocal(session.user.id, id);
    if (!task) return;
    editingTaskId = id;
    element("editContent").value = task.noiDung;
    element("editDescription").value = task.description || "";
    element("editCategory").value = task.category || "Cá nhân";
    element("editDueDate").value = task.dueAt || "";
    element("editReminder").checked = Boolean(task.reminder);
    element("editModal").classList.remove("d-none");
    element("editContent").focus();
}

function closeEditDialog() {
    editingTaskId = null;
    element("editModal").classList.add("d-none");
}

async function saveEditedTask(event) {
    event.preventDefault();
    const task = await layCongViecLocal(session.user.id, editingTaskId);
    if (!task) return closeEditDialog();
    task.noiDung = element("editContent").value.trim();
    task.description = element("editDescription").value.trim();
    task.category = element("editCategory").value;
    task.dueAt = element("editDueDate").value || null;
    task.reminder = element("editReminder").checked;
    task.dirty = true;
    task.updatedAt = new Date().toISOString();
    await luuCongViec(task, "upsert");
    closeEditDialog();
    await hienThiCongViec();
    if (navigator.onLine) await dongBoDuLieu();
}

async function doiTrangThai(id) {
    const task = await layCongViecLocal(session.user.id, id);
    if (!task) return;
    task.hoanThanh = !task.hoanThanh;
    task.dirty = true;
    task.updatedAt = new Date().toISOString();
    await luuCongViec(task, "upsert");
    await hienThiCongViec();
    if (navigator.onLine) await dongBoDuLieu();
}

async function xoaCongViec(id) {
    if (!window.confirm("Bạn có chắc muốn xóa công việc này?")) return;
    await xoaCongViecDB(id, session.user.id);
    await hienThiCongViec();
    if (navigator.onLine) await dongBoDuLieu();
}

function apiTask(task) {
    const content = typeof task.noiDung === "string"
        ? task.noiDung.trim()
        : typeof task.content === "string"
            ? task.content.trim()
            : typeof task.name === "string"
                ? task.name.trim()
                : "";
    const categories = ["Cá nhân", "Công việc", "Học tập", "Khác"];
    const category = categories.includes(task.category) ? task.category : "Khác";
    const dueAt = normalizeDueDate(task.dueAt);
    const version = Number(task.serverVersion);
    return {
        content: content,
        description: typeof task.description === "string" ? task.description.trim() : "",
        completed: task.hoanThanh,
        category: category,
        dueAt: dueAt,
        reminder: Boolean(task.reminder),
        deleted: Boolean(task.deleted),
        version: Number.isSafeInteger(version) && version >= 0 ? version : 0
    };
}

function taskMatchesServer(task, remote) {
    const local = apiTask(task);
    return remote.content === local.content &&
        (remote.description || "") === local.description &&
        Boolean(remote.completed) === Boolean(local.completed) &&
        remote.category === local.category &&
        normalizeDueDate(remote.dueAt) === local.dueAt &&
        Boolean(remote.reminder) === local.reminder &&
        !remote.deleted;
}

function taskFromServer(remote, ownerId, localId) {
    return {
        id: localId === undefined ? remote.clientId : localId,
        ownerId: String(ownerId),
        noiDung: remote.content,
        description: remote.description || "",
        hoanThanh: remote.completed,
        category: remote.category,
        dueAt: remote.dueAt,
        reminder: remote.reminder,
        deleted: remote.deleted,
        serverVersion: remote.version,
        dirty: false,
        updatedAt: remote.updatedAt || new Date().toISOString()
    };
}

async function dongBoDuLieu() {
    if (!session || !session.user) return;
    if (syncRunning) {
        syncRequested = true;
        return;
    }
    if (!navigator.onLine) {
        setSyncMessage("Bạn đang ngoại tuyến. Các thay đổi được giữ trong hàng đợi.");
        await refreshQueueCount();
        return;
    }
    syncRunning = true;
    const syncButton = element("syncButton");
    if (syncButton) syncButton.disabled = true;
    const lockOwner = "page-" + newTaskId();
    let lockAcquired = false;
    let lockHeartbeat;
    try {
        lockAcquired = await khoaDongBo(lockOwner);
        if (!lockAcquired) {
            setSyncMessage("Đang đồng bộ dữ liệu ở một tiến trình khác. Sẽ tự thử lại.");
            if (!syncRetryTimer) {
                syncRetryTimer = window.setTimeout(function () {
                    syncRetryTimer = null;
                    if (navigator.onLine) {
                        dongBoDuLieu().catch(reportError);
                    }
                }, 5000);
            }
            return;
        }
        window.clearTimeout(syncRetryTimer);
        syncRetryTimer = null;
        lockHeartbeat = window.setInterval(function () {
            giaHanKhoaDongBo(lockOwner).catch(function (error) {
                console.error("Không thể gia hạn khóa đồng bộ:", error);
            });
        }, 15000);
        setSyncMessage("Đang gửi hàng đợi thay đổi...");
        const ownerId = session.user.id;
        const queue = await layHangDoiDongBo(ownerId);
        for (const entry of queue) {
            const task = await layCongViecLocal(ownerId, entry.id);
            if (!task) {
                await xoaKhoiHangDoi(entry.id);
                continue;
            }
            try {
                const result = task.deleted
                    ? await apiRequest("/tasks/" + encodeURIComponent(task.id), {
                        method: "DELETE",
                        body: JSON.stringify({ version: Number(task.serverVersion) || 0 })
                    })
                    : await apiRequest("/tasks/" + encodeURIComponent(task.id), {
                        method: "PUT",
                        body: JSON.stringify(apiTask(task))
                    });
                const saved = taskFromServer(result.data.task, ownerId, task.id);
                await luuCongViec(saved);
                await xoaKhoiHangDoi(task.id);
            } catch (error) {
                if (error.status === 409 && error.data.current) {
                    task.conflict = taskFromServer(error.data.current, ownerId);
                    await luuCongViec(task);
                    continue;
                }
                if (error.status === 401) {
                    throw new Error("Phiên đăng nhập hết hạn. Hãy đăng nhập lại khi có mạng.");
                }
                if (error.status === 400) {
                    console.error("Công việc không hợp lệ, vẫn giữ trong hàng đợi:", {
                        id: task.id,
                        message: error.message,
                        details: error.data && error.data.details
                    });
                    await capNhatLoiHangDoi(entry, error.message);
                    continue;
                }
                throw error;
            }
        }

        const result = await apiRequest("/tasks");
        const localTasks = await layTatCaBanGhi(ownerId);
        for (const remote of result.data.tasks) {
            const local = localTasks.find(function (task) {
                return String(task.id) === String(remote.clientId);
            });
            if (!local) {
                await luuCongViec(taskFromServer(remote, ownerId));
            } else if (!local.dirty && (remote.version !== local.serverVersion ||
                remote.updatedAt !== local.updatedAt)) {
                await luuCongViec(taskFromServer(remote, ownerId, local.id));
            } else if (local.dirty && remote.version > (local.serverVersion || 0)) {
                local.conflict = taskFromServer(remote, ownerId, local.id);
                await luuCongViec(local);
            }
        }
        await hienThiCongViec();
        const remaining = await layHangDoiDongBo(ownerId);
        const failedEntry = remaining.find(function (entry) {
            return Boolean(entry.lastError);
        });
        const conflicts = (await layTatCaBanGhi(ownerId)).filter(function (task) {
            return Boolean(task.conflict);
        });
        const conflictHelp = element("conflictHelp");
        if (conflictHelp) conflictHelp.classList.toggle("d-none", conflicts.length === 0);
        setSyncMessage(conflicts.length
            ? "Có thay đổi trùng nhau trên thiết bị khác. Chọn phiên bản muốn giữ."
            : remaining.length
                ? failedEntry
                    ? "Một công việc cũ có dữ liệu không hợp lệ, vẫn nằm trong hàng đợi. Hãy mở Sửa và lưu lại công việc đó."
                    : "Đã đồng bộ một phần. Một số thay đổi vẫn đang chờ."
                : "Đồng bộ hoàn tất. Dữ liệu trên các thiết bị đã được cập nhật.",
        conflicts.length ? "error" : "success");
    } catch (error) {
        setSyncMessage("Chưa đồng bộ được: " + error.message, "error");
        console.error("Lỗi đồng bộ:", error);
    } finally {
        if (lockHeartbeat) {
            window.clearInterval(lockHeartbeat);
        }
        try {
            if (lockAcquired) {
                await moKhoaDongBo(lockOwner);
            }
        } catch (error) {
            console.error("Không thể giải phóng khóa đồng bộ:", error);
        } finally {
            syncRunning = false;
            if (syncButton) syncButton.disabled = false;
            await refreshQueueCount();
            if (syncRequested && navigator.onLine) {
                syncRequested = false;
                window.setTimeout(function () {
                    dongBoDuLieu().catch(reportError);
                }, 0);
            }
        }
    }
}

function openNextConflict() {
    layTatCaBanGhi(session.user.id).then(function (tasks) {
        const conflict = tasks.find(function (task) { return Boolean(task.conflict); });
        if (conflict) openConflict(conflict.id);
    }).catch(reportError);
}

async function openConflict(id) {
    const task = await layCongViecLocal(session.user.id, id);
    if (!task || !task.conflict) return;
    conflictTaskId = id;
    element("localVersion").textContent = task.deleted
        ? "Công việc đã bị xóa trên thiết bị này."
        : task.description
            ? task.noiDung + "\n" + task.description
            : task.noiDung;
    element("remoteVersion").textContent = task.conflict.deleted
        ? "Công việc đã bị xóa trên thiết bị khác."
        : task.conflict.description
            ? task.conflict.noiDung + "\n" + task.conflict.description
            : task.conflict.noiDung;
    element("conflictModal").classList.remove("d-none");
}

async function resolveConflictLocal() {
    const task = await layCongViecLocal(session.user.id, conflictTaskId);
    if (!task || !task.conflict) return;
    task.serverVersion = task.conflict.serverVersion;
    delete task.conflict;
    task.dirty = true;
    await luuCongViec(task, "upsert");
    element("conflictModal").classList.add("d-none");
    await dongBoDuLieu();
}

async function resolveConflictRemote() {
    const task = await layCongViecLocal(session.user.id, conflictTaskId);
    if (!task || !task.conflict) return;
    const remote = task.conflict;
    delete remote.conflict;
    await luuCongViec(remote);
    await xoaKhoiHangDoi(task.id);
    element("conflictModal").classList.add("d-none");
    await hienThiCongViec();
    showToast("Đã dùng phiên bản mới nhất trên máy chủ.");
}

async function dangXuat() {
    if (navigator.onLine) {
        try {
            await apiRequest("/auth/logout", { method: "POST" });
        } catch (error) {
            console.error("Không thể kết thúc phiên trên máy chủ:", error);
        }
    }
    await xoaPhienDongBo();
    localStorage.removeItem(SESSION_KEY);
    session = null;
    window.location.replace("login.html");
}

async function requestNotifications() {
    if (!("Notification" in window)) {
        showToast("Trình duyệt này không hỗ trợ thông báo.");
        return;
    }
    const permission = await Notification.requestPermission();
    showToast(permission === "granted"
        ? "Đã bật thông báo nhắc việc trên thiết bị."
        : "Bạn chưa cấp quyền thông báo. Có thể bật lại trong cài đặt trình duyệt.");
}

async function checkReminders() {
    if (!session || !session.user || !("Notification" in window) ||
        Notification.permission !== "granted") return;
    const today = new Date().toISOString().slice(0, 10);
    const tasks = await layTatCaCongViec(session.user.id);
    for (const task of tasks) {
        if (!task.reminder || task.hoanThanh || task.dueAt !== today) continue;
        const key = "pwa-reminder-" + session.user.id + "-" + task.id + "-" + today;
        if (localStorage.getItem(key)) continue;
        new Notification("Công việc đến hạn hôm nay", {
            body: task.noiDung,
            icon: "./images/icon.svg?v=2",
            tag: key
        });
        localStorage.setItem(key, "1");
    }
}

async function installApp() {
    if (!installPrompt) {
        showToast("Hãy dùng menu trình duyệt để thêm ứng dụng vào màn hình chính.");
        return;
    }
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    element("installButton").classList.add("d-none");
}

document.addEventListener("keydown", function (event) {
    if (!element("taskSearch")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        element("taskSearch").focus();
    }
    if (event.key === "Escape") {
        element("conflictModal").classList.add("d-none");
        closeEditDialog();
    }
});

window.addEventListener("load", function () {
    initialize().catch(reportError);
});
