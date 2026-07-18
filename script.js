import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getDatabase, ref, onValue, update } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyDooeQFt1kU5j34F8CI_UZ3QuEmeAu8NG8",
    authDomain: "smartshed-cd1d0.firebaseapp.com",
    databaseURL: "https://smartshed-cd1d0-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "smartshed-cd1d0",
    storageBucket: "smartshed-cd1d0.firebasestorage.app",
    messagingSenderId: "403993629890",
    appId: "1:403993629890:web:9017ed1d73a0123c1c975b",
    measurementId: "G-6EP1RFNK41"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

// ─── ⚡ ZERO-LATENCY OPTIMISTIC UI LOCKOUT MATRIX ────────────────
const pendingCommands = new Set();
let totalCommands = 0;
const MAX_CHART_POINTS = 30;
let recordHistory = [], powerHistory = [];
let currentPowerSource = "SOLAR"; 
let powerCounters = { solar: 0, ac: 0 };
let climateChart, envChart;
let isDataListenerActive = false;

let globalCounters = { tempCount: 0, tempSum: 0, humCount: 0, humSum: 0, rainCount: 0, rainSum: 0, gasCount: 0, gasSum: 0, lightCount: 0, lightSum: 0 };
let allTimeRecords = {
    temp: { min: 99, max: -99, avg: 0, minTime: "—", maxTime: "—" },
    hum: { min: 100, max: 0, avg: 0, minTime: "—", maxTime: "—" },
    rain: { min: 100, max: 0, avg: 0, minTime: "—", maxTime: "—" },
    gas: { min: 4095, max: 0, avg: 0, minTime: "—", maxTime: "—" },
    light: { min: 4095, max: 0, avg: 0, minTime: "—", maxTime: "—" }
};

const sensorContainer = document.getElementById('sensor-container');
const actuatorsPanel = document.getElementById('actuatorsPanel');
const activityLogDiv = document.getElementById('activityLog');
const alertArea = document.getElementById('alert-area');
const previewGrid = document.getElementById('previewGrid');
const recordsFullGrid = document.getElementById('recordsFullGrid');
const historyTimeline = document.getElementById('historyTimeline');
const powerSourceBtn = document.getElementById('powerSourceBtn');
const solarCountEl = document.getElementById('solarCount');
const acCountEl = document.getElementById('acCount');
const powerHistoryTimeline = document.getElementById('powerHistoryTimeline');

const safeNum = (val) => (typeof val === 'number' && isFinite(val)) ? val : 0;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function initAuthSystem() {
    onAuthStateChanged(auth, (user) => {
        const loginPage = document.getElementById('loginPage');
        const mainApp = document.getElementById('mainApp');
        const emailDisplay = document.getElementById('adminEmailDisplay');

        if (user) {
            if(loginPage) loginPage.style.display = 'none';
            if(mainApp) mainApp.style.display = 'block';
            if(emailDisplay) emailDisplay.innerText = user.email.split('@')[0];
            showToast(`Welcome back, Admin!`);
            if (!isDataListenerActive) {
                initFirebaseListener();
                isDataListenerActive = true;
            }
        } else {
            if(loginPage) loginPage.style.display = 'flex';
            if(mainApp) mainApp.style.display = 'none';
        }
    });

    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('adminEmail').value;
            const pass = document.getElementById('adminPass').value;
            const errDiv = document.getElementById('loginError');
            const loginBtn = document.getElementById('loginSubmitBtn');

            errDiv.style.display = 'none';
            loginBtn.innerText = "Authenticating... ⚡";
            loginBtn.disabled = true;

            try {
                await signInWithEmailAndPassword(auth, email, pass);
            } catch (error) {
                errDiv.innerText = "❌ Invalid Admin Email or Password!";
                errDiv.style.display = 'block';
                showToast("Login Authentication Failed!", true);
            } finally {
                loginBtn.innerText = "Login to Dashboard ⚡";
                loginBtn.disabled = false;
            }
        });
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if (confirm("Are you sure you want to log out of the Admin Portal?")) {
                signOut(auth).then(() => showToast("Logged out successfully."));
            }
        });
    }
}

function addLog(msg) {
    if (!activityLogDiv) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.innerHTML = `<span class="log-time">${time}</span><span>${msg}</span>`;
    activityLogDiv.prepend(entry);
    if (activityLogDiv.children.length > 35) activityLogDiv.removeChild(activityLogDiv.lastChild);
}

function showToast(msg, isError = false) {
    const toast = document.createElement('div');
    Object.assign(toast.style, {
        position: 'fixed', bottom: '25px', right: '25px',
        background: isError ? 'var(--danger)' : 'var(--accent)',
        color: 'white', padding: '12px 24px', borderRadius: '10px',
        fontSize: '0.85rem', zIndex: '99999', fontWeight: '600',
        boxShadow: '0 10px 15px rgba(0,0,0,0.3)', transition: 'all 0.3s ease'
    });
    toast.innerText = msg; document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 2200);
}

function loadPowerSystem() {
    const savedSource = localStorage.getItem('power_current_source');
    const savedCounters = localStorage.getItem('power_counters');
    const savedPowerHistory = localStorage.getItem('power_history_logs');
    if (savedSource) currentPowerSource = savedSource;
    if (savedCounters) powerCounters = JSON.parse(savedCounters);
    if (savedPowerHistory) powerHistory = JSON.parse(savedPowerHistory);
    updatePowerUI();
}

function togglePowerSource() {
    const now = new Date();
    const timeStr = now.toLocaleDateString() + ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (currentPowerSource === "SOLAR") {
        currentPowerSource = "AC"; powerCounters.ac++;
        powerHistory.unshift({ source: "AC Grid Power", time: timeStr, icon: "🔌", color: "var(--ac)" });
    } else {
        currentPowerSource = "SOLAR"; powerCounters.solar++;
        powerHistory.unshift({ source: "Solar PV Array", time: timeStr, icon: "☀️", color: "var(--solar)" });
    }
    if (powerHistory.length > 20) powerHistory.pop();
    localStorage.setItem('power_current_source', currentPowerSource);
    localStorage.setItem('power_counters', JSON.stringify(powerCounters));
    localStorage.setItem('power_history_logs', JSON.stringify(powerHistory));
    updatePowerUI();
    showToast(`Power Grid Router Updated!`);
}

function updatePowerUI() {
    if (solarCountEl) solarCountEl.innerText = powerCounters.solar; 
    if (acCountEl) acCountEl.innerText = powerCounters.ac;
    if (powerSourceBtn) {
        powerSourceBtn.innerText = currentPowerSource === "SOLAR" ? "☀️ Source: SOLAR" : "🔌 Source: AC MAINS";
        powerSourceBtn.className = `power-btn ${currentPowerSource.toLowerCase()}`;
    }
    if (!powerHistoryTimeline) return;
    powerHistoryTimeline.innerHTML = powerHistory.map(log => `
        <div class="log-entry" style="justify-content:space-between;">
            <span style="color:${log.color}; font-weight:600">${log.icon} ${log.source} Locked</span>
            <span style="color:var(--text-muted); font-size:0.75rem;">${log.time}</span>
        </div>
    `).join('');
}

function loadHistoricalRecords() {
    const storedRecords = localStorage.getItem('all_time_sensor_records');
    const storedCounters = localStorage.getItem('global_math_counters');
    const storedHistory = localStorage.getItem('record_history_timeline');
    if (storedRecords) allTimeRecords = JSON.parse(storedRecords);
    if (storedCounters) globalCounters = JSON.parse(storedCounters);
    if (storedHistory) recordHistory = JSON.parse(storedHistory);
    updateAllUI();
}

function processSensorHistory(key, value, label, unit) {
    const now = new Date();
    const dateStr = now.toLocaleDateString() + ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let isUpdated = false;

    globalCounters[key + 'Count']++;
    globalCounters[key + 'Sum'] += value;
    allTimeRecords[key].avg = globalCounters[key + 'Sum'] / globalCounters[key + 'Count'];

    if (value > allTimeRecords[key].max) {
        allTimeRecords[key].max = value; allTimeRecords[key].maxTime = dateStr;
        isUpdated = true;
        addToHistory(`Peak Max ${label}`, `${value.toFixed(1)} ${unit}`, dateStr);
    }
    if (value < allTimeRecords[key].min) {
        allTimeRecords[key].min = value; allTimeRecords[key].minTime = dateStr;
        isUpdated = true;
        addToHistory(`Drop Min ${label}`, `${value.toFixed(1)} ${unit}`, dateStr);
    }

    if (isUpdated || globalCounters[key + 'Count'] % 5 === 0) {
        localStorage.setItem('all_time_sensor_records', JSON.stringify(allTimeRecords));
        localStorage.setItem('global_math_counters', JSON.stringify(globalCounters));
    }
}

function addToHistory(type, val, time) {
    recordHistory.unshift({ type, value: val, timestamp: time });
    if (recordHistory.length > 40) recordHistory.pop();
    localStorage.setItem('record_history_timeline', JSON.stringify(recordHistory));
}

function updatePreviewGrid() {
    if (!previewGrid) return;
    previewGrid.innerHTML = `
        <div class="preview-card"><div class="preview-label">🌡️ Max Temperature</div><div class="preview-value">${allTimeRecords.temp.max.toFixed(1)}°C</div><div style="font-size:0.7rem; color:var(--text-muted);">${allTimeRecords.temp.maxTime}</div></div>
        <div class="preview-card"><div class="preview-label">💧 Max Humidity</div><div class="preview-value">${allTimeRecords.hum.max.toFixed(1)}%</div><div style="font-size:0.7rem; color:var(--text-muted);">${allTimeRecords.hum.maxTime}</div></div>
        <div class="preview-card"><div class="preview-label">🌧️ Max Rainfall</div><div class="preview-value">${allTimeRecords.rain.max.toFixed(1)}%</div><div style="font-size:0.7rem; color:var(--text-muted);">${allTimeRecords.rain.maxTime}</div></div>
        <div class="preview-card"><div class="preview-label">☣️ Peak Gas Leak</div><div class="preview-value">${allTimeRecords.gas.max.toFixed(0)} ppm</div><div style="font-size:0.7rem; color:var(--text-muted);">${allTimeRecords.gas.maxTime}</div></div>
    `;
    document.querySelectorAll('.preview-card').forEach(c => c.addEventListener('click', () => switchToRecordsPage()));
}

function updateRecordsFullPage() {
    if (!recordsFullGrid) return;
    const targetSensors = [
        { key: 'temp', title: '🌡️ Temperature History', unit: '°C' },
        { key: 'hum', title: '💧 Humidity History', unit: '%' },
        { key: 'rain', title: '🌧️ Rainfall History', unit: '%' },
        { key: 'gas', title: '☣️ Gas Concentration', unit: 'ppm' },
        { key: 'light', title: '☀️ Light Level (LDR)', unit: 'lux' }
    ];

    recordsFullGrid.innerHTML = targetSensors.map(s => {
        const data = allTimeRecords[s.key];
        const minVal = (data.min === 4095 || data.min === 99) ? 0 : data.min;
        return `
            <div class="record-full-card" style="border-top: 4px solid var(--accent)">
                <div class="record-full-title" style="color:var(--text-main); font-size:1rem; margin-bottom:10px;">${s.title}</div>
                <div style="font-size:0.85rem; margin: 4px 0;">🟢 <strong>Minimum:</strong> ${minVal.toFixed(1)} ${s.unit} <span style="font-size:0.75rem;color:var(--text-muted)">(${data.minTime})</span></div>
                <div style="font-size:0.85rem; margin: 4px 0;">🔴 <strong>Maximum:</strong> ${data.max.toFixed(1)} ${s.unit} <span style="font-size:0.75rem;color:var(--text-muted)">(${data.maxTime})</span></div>
                <div style="font-size:0.85rem; margin: 4px 0; color:var(--success);">📊 <strong>Rolling Avg:</strong> ${data.avg.toFixed(1)} ${s.unit}</div>
            </div>
        `;
    }).join('');
}

function updateHistoryTimeline() {
    if (!historyTimeline || recordHistory.length === 0) return;
    historyTimeline.innerHTML = recordHistory.map(r => `<div class="log-entry" style="justify-content:space-between;"><span>🏆 ${r.type}: <strong>${r.value}</strong></span><span style="font-size:0.75rem; color:var(--text-muted);">${r.timestamp}</span></div>`).join('');
}

function updateAllUI() { updatePreviewGrid(); updateRecordsFullPage(); updateHistoryTimeline(); }

function resetAllRecords() {
    if (confirm("⚠️ Erase entire records, averages, and localized cache systems permanently?")) {
        localStorage.clear();
        location.reload();
    }
}

function switchToDashboard() {
    document.getElementById('dashboardPage')?.classList.add('active');
    document.getElementById('recordsPage')?.classList.remove('active');
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === 'dashboard'));
}

function switchToRecordsPage() {
    document.getElementById('recordsPage')?.classList.add('active');
    document.getElementById('dashboardPage')?.classList.remove('active');
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === 'records'));
    updateAllUI(); updatePowerUI();
}

function initNavigation() {
    document.querySelectorAll('.nav-tab').forEach(t => t.addEventListener('click', (e) => { if (e.target.dataset.page === 'dashboard') switchToDashboard(); else switchToRecordsPage(); }));
    document.getElementById('homeLogoBtn')?.addEventListener('click', switchToDashboard);
    document.getElementById('gotoRecordsBtn')?.addEventListener('click', switchToRecordsPage);
    document.getElementById('resetRecordsPageBtn')?.addEventListener('click', resetAllRecords);
    if (powerSourceBtn) powerSourceBtn.addEventListener('click', togglePowerSource);
}

function initTheme() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const isDark = document.body.classList.contains('dark-theme');
        document.body.className = isDark ? 'light-theme' : 'dark-theme';
        btn.textContent = isDark ? '🌙 Dark Mode' : '☀️ Light Mode';
    });
}

function renderSensors(data) {
    const list = [
        { label: 'Temperature', unit: '°C', icon: '🌡️', max: 60, warn: 38, value: data.temp },
        { label: 'Humidity', unit: '%', icon: '💧', max: 100, warn: 85, value: data.hum },
        { label: 'Rain Level', unit: '%', icon: '🌧️', max: 100, warn: 40, value: data.rain },
        { label: 'Gas Index', unit: 'ppm', icon: '🔬', max: 4095, warn: 2200, value: data.gas },
        { label: 'Light Level', unit: 'lux', icon: '☀️', max: 4095, warn: null, value: data.light }
    ];

    if (sensorContainer) {
        sensorContainer.innerHTML = list.map(s => {
            const val = safeNum(s.value);
            const ratio = clamp((val / s.max) * 100, 0, 100);
            const warn = (s.warn && val > s.warn) ? 'warn' : 'ok';
            return `<div class="sensor-card">
                        <div class="sensor-header"><span>${s.icon} ${s.label}</span><span class="sensor-badge ${warn}">${warn.toUpperCase()}</span></div>
                        <div class="sensor-value">${val.toFixed(1)}<span class="sensor-unit">${s.unit}</span></div>
                        <div class="progress-bar"><div class="progress-fill" style="width:${ratio}%; background:${warn === 'warn' ? 'var(--danger)' : 'var(--success)'};"></div></div>
                    </div>`;
        }).join('');
    }
}

// ─── 🟢 DYNAMIC ACTUATOR & WATER SPRAY SERVO PANEL ─────────────────
function updateDeviceControls(data) {
    if (!actuatorsPanel) return;
    
    // Do NOT redraw controls if user is actively clicking a button (prevents flicker)
    if (pendingCommands.size > 0) return;

    const systems = [
        { path: 'actuators/fan1', autoPath: 'automation/autoFan1', label: 'Ceiling Fan', icon: '🌀', val: !!data.fan1, auto: !!data.autoFan1 },
        { path: 'actuators/fan2', autoPath: 'automation/autoFan2', label: 'Exhaust Fan', icon: '🌬️', val: !!data.fan2, auto: !!data.autoFan2 },
        { path: 'actuators/heatlight', autoPath: 'automation/autoHeat', label: 'Heat Lamp', icon: '☀️', val: !!data.heatlight, auto: !!data.autoHeat },
        { path: 'actuators/nightlight', autoPath: 'automation/autoNightLight', label: 'Night Light', icon: '🌙', val: !!data.nightlight, auto: !!data.autoNightLight },
       
    ];

    actuatorsPanel.innerHTML = systems.map(s => `
        <div class="device-item">
            <div class="device-info">
                <div class="device-icon">${s.icon}</div>
                <div>
                    <div class="device-title">${s.label}</div>
                    <div class="device-sub">${s.auto ? '🤖 AUTO MODE' : '✋ MANUAL MODE'}</div>
                </div>
            </div>
            <div class="button-group">
                <button class="ctrl-btn ${s.auto ? 'active' : ''}" onclick="window.toggleFirebaseFlag('${s.autoPath}', ${!s.auto}, this, 'auto')">
                    ${s.auto ? 'Auto ON' : 'Auto OFF'}
                </button>
                <button class="ctrl-btn ${s.val ? 'on' : ''}" ${s.auto ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="window.toggleFirebaseFlag('${s.path}', ${!s.val}, this, 'pwr')">
                    ${s.val ? 'PWR ON' : 'PWR OFF'}
                </button>
            </div>
        </div>
    `).join('');

    // --- Standalone Devices: Pump & Automated Water Spray Servo ---
    actuatorsPanel.innerHTML += `
        <div class="device-item">
            <div class="device-info">
                <div class="device-icon">🚰</div>
                <div>
                    <div class="device-title">Water Pump</div>
                    <div class="device-sub">Direct Cloud Override</div>
                </div>
            </div>
            <div style="width: 150px; flex-shrink: 0;">
                <button class="pump-btn ${data.pump ? 'on' : ''}" onclick="window.toggleFirebaseFlag('actuators/pump', ${!data.pump}, this, 'pump')">
                    ${data.pump ? 'PUMP RUNNING' : 'START PUMP'}
                </button>
            </div>
        </div>

        <!-- 🟢 WATER SPRAY SERVO (AUTO LOW-HUMIDITY + MANUAL TRIGGER) -->
        <div class="device-item" style="border: 1px solid var(--accent); background: rgba(59, 130, 246, 0.05);">
            <div class="device-info">
                <div class="device-icon" style="background: rgba(59, 130, 246, 0.2);">💦</div>
                <div>
                    <div class="device-title" style="color: var(--accent);">Water Spray Servo </div>
                    <div class="device-sub">${data.autoSpray ? '🤖 AUTO: SPRAYS IF HUMIDITY < 30%' : '✋ MANUAL OVERRIDE'}</div>
                </div>
            </div>
            <div class="button-group" style="width: auto; gap: 8px;">
                <button class="ctrl-btn ${data.autoSpray ? 'active' : ''}" onclick="window.toggleFirebaseFlag('automation/autoSpray', ${!data.autoSpray}, this, 'auto')">
                    ${data.autoSpray ? 'Auto ON' : 'Auto OFF'}
                </button>
                <button class="pump-btn ${data.spray ? 'on' : ''}" id="sprayBtn" style="padding: 10px 16px;" ${data.spray ? 'disabled' : ''} onclick="window.triggerWaterSprayServo(this)">
                    ${data.spray ? '💦 SPRAYING...' : 'Click Manual Water SPRAY'}
                </button>
            </div>
        </div>

        <!-- Automated Curtains -->
        <div class="device-item" style="grid-column: 1 / -1;">
            <div class="device-info">
                <div class="device-icon">🪟</div>
                <div>
                    <div class="device-title">Automated Shed Curtains</div>
                    <div class="device-sub">${data.autoCurtain ? '🤖 AUTO MODE ACTIVE' : '✋ MANUAL OVERRIDE'}</div>
                </div>
            </div>
            <div class="button-group">
                <button class="ctrl-btn ${data.autoCurtain ? 'active' : ''}" onclick="window.toggleFirebaseFlag('automation/autoCurtain', ${!data.autoCurtain}, this, 'auto')">
                    ${data.autoCurtain ? 'Auto ON' : 'Auto OFF'}
                </button>
                <button class="ctrl-btn ${data.curtainStatus === 1 ? 'on' : ''}" ${data.autoCurtain ? 'disabled style="opacity:0.5"' : ''} onclick="window.setCurtainState(1, this)">
                    ▲ Open Curtains
                </button>
                <button class="ctrl-btn ${data.curtainStatus === 0 ? 'on' : ''}" ${data.autoCurtain ? 'disabled style="opacity:0.5"' : ''} onclick="window.setCurtainState(0, this)">
                    ▼ Close Curtains
                </button>
            </div>
        </div>
    `;
}

// ─── ⚡ ZERO-LATENCY EXPORTED FIREBASE ACTIONS ──────────────────────
window.toggleFirebaseFlag = async (path, value, btnElement, type) => {
    try {
        // 1. Lock command to prevent onValue overwriting UI during network transit
        pendingCommands.add(path);

        // 2. OPTIMISTIC UI UPDATE: Immediately change button style & text (0ms delay)
        if (btnElement) {
            btnElement.disabled = true;
            if (type === 'auto') {
                btnElement.classList.toggle('active', value);
                btnElement.innerText = value ? 'Auto ON' : 'Auto OFF';
                // If turning Auto ON, disable the companion PWR button visually
                const pwrBtn = btnElement.nextElementSibling;
                if (pwrBtn) { pwrBtn.disabled = value; pwrBtn.style.opacity = value ? '0.5' : '1'; }
            } else if (type === 'pwr') {
                btnElement.classList.toggle('on', value);
                btnElement.innerText = value ? 'PWR ON' : 'PWR OFF';
            } else if (type === 'pump') {
                btnElement.classList.toggle('on', value);
                btnElement.innerText = value ? 'PUMP RUNNING' : 'START PUMP';
            }
        }

        // 3. Dispatch to Firebase Cloud
        const updates = {};
        updates[`/FarmData/${path}`] = value;
        await update(ref(db), updates);
        
        if (path.startsWith('actuators/') && path !== 'actuators/pump' && path !== 'actuators/spray') {
            const autoKey = path.replace('actuators/', 'auto').replace('heatlight', 'Heat').replace('nightlight', 'NightLight').replace('led', 'LED').replace('fan1', 'Fan1').replace('fan2', 'Fan2');
            const autoUpdates = {};
            autoUpdates[`/FarmData/automation/${autoKey}`] = false;
            await update(ref(db), autoUpdates);
        }
        
        showToast(`Command sent: ${path.split('/')[1]} ➔ ${value ? 'ON' : 'OFF'}`);
        addLog(`Manual Override: Set ${path.split('/')[1]} to ${value ? 'ON' : 'OFF'}`);

        // 4. Release lockout after 1.5s (gives ESP32 time to sync hardware)
        setTimeout(() => {
            pendingCommands.delete(path);
            if (btnElement) btnElement.disabled = false;
        }, 1500);

    } catch (error) {
        pendingCommands.delete(path);
        if (btnElement) btnElement.disabled = false;
        showToast("Error sending command to cloud!", true);
    }
};

// 🟢 INSTANT MOMENTARY SPRAY TRIGGER
window.triggerWaterSprayServo = async (btnElement) => {
    try {
        const btn = btnElement || document.getElementById('sprayBtn');
        pendingCommands.add('actuators/spray');

        // Optimistic UI change
        if (btn) {
            btn.classList.add('on');
            btn.innerText = "💦 SPRAYING...";
            btn.disabled = true;
        }
        
        await update(ref(db), { "/FarmData/actuators/spray": true });
        showToast("💦 Triggering Water Spray Servo (30°)...");
        addLog("Actuator Trigger: Water Spray Servo Pulsed (0° ➔ 30° ➔ 0°)");

        // Release UI after 2.5 seconds (covers ESP32 physical rotation time)
        setTimeout(() => {
            pendingCommands.delete('actuators/spray');
            if (btn) {
                btn.classList.remove('on');
                btn.innerText = "⚡ TRIGGER SPRAY";
                btn.disabled = false;
            }
        }, 2500);
    } catch (error) {
        pendingCommands.delete('actuators/spray');
        showToast("Failed to trigger Water Spray Servo!", true);
    }
};

window.setCurtainState = async (targetState, btnElement) => {
    try {
        pendingCommands.add('actuators/curtainStatus');
        
        // Optimistic UI change
        if (btnElement) {
            const siblings = btnElement.parentElement.querySelectorAll('button');
            siblings.forEach(b => b.classList.remove('on'));
            btnElement.classList.add('on');
        }

        await update(ref(db), {
            "/FarmData/automation/autoCurtain": false,
            "/FarmData/actuators/curtainStatus": targetState
        });
        showToast(`Curtain motor triggered: ${targetState === 1 ? 'OPENING' : 'CLOSING'}`);
        addLog(`Actuator Trigger: Curtains set to ${targetState === 1 ? 'OPEN' : 'CLOSED'}`);

        setTimeout(() => pendingCommands.delete('actuators/curtainStatus'), 2000);
    } catch (error) {
        pendingCommands.delete('actuators/curtainStatus');
        showToast("Failed to drive curtain motor!", true);
    }
};

function initCharts() {
    const chartConfig = (title, color1, color2, label1, label2) => ({
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: label1, borderColor: color1, backgroundColor: color1 + '20', data: [], tension: 0.4, fill: true },
                { label: label2, borderColor: color2, backgroundColor: color2 + '20', data: [], tension: 0.4, fill: true }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: '#94a3b8' } } },
            scales: {
                x: { grid: { color: '#334155' }, ticks: { color: '#94a3b8' } },
                y: { grid: { color: '#334155' }, ticks: { color: '#94a3b8' } }
            }
        }
    });

    const ctxClimate = document.getElementById('climateChart')?.getContext('2d');
    const ctxEnv = document.getElementById('envChart')?.getContext('2d');

    if (ctxClimate) climateChart = new Chart(ctxClimate, chartConfig('Climate', '#3b82f6', '#10b981', 'Temp (°C)', 'Humidity (%)'));
    if (ctxEnv) envChart = new Chart(ctxEnv, chartConfig('Environment', '#f59e0b', '#ef4444', 'Light (lux)', 'Gas (ppm)'));
}

function updateCharts(temp, hum, light, gas) {
    if (!climateChart || !envChart) return;
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    [climateChart, envChart].forEach(chart => {
        chart.data.labels.push(timeStr);
        if (chart.data.labels.length > MAX_CHART_POINTS) chart.data.labels.shift();
    });

    climateChart.data.datasets[0].data.push(temp);
    climateChart.data.datasets[1].data.push(hum);
    if (climateChart.data.datasets[0].data.length > MAX_CHART_POINTS) {
        climateChart.data.datasets[0].data.shift();
        climateChart.data.datasets[1].data.shift();
    }
    climateChart.update('none');

    envChart.data.datasets[0].data.push(light);
    envChart.data.datasets[1].data.push(gas);
    if (envChart.data.datasets[0].data.length > MAX_CHART_POINTS) {
        envChart.data.datasets[0].data.shift();
        envChart.data.datasets[1].data.shift();
    }
    envChart.update('none');
}

function initFirebaseListener() {
    const farmDataRef = ref(db, '/FarmData');
    
    onValue(farmDataRef, (snapshot) => {
        const val = snapshot.val();
        const led = document.getElementById('conn-led');
        const label = document.getElementById('conn-label');
        const syncEl = document.getElementById('lastSync');
        const cmdEl = document.getElementById('stat-cmds');

        if (!val) {
            if (led) led.className = 'led-dot offline';
            if (label) label.innerText = 'Offline / No Data';
            return;
        }

        if (led) led.className = 'led-dot live';
        if (label) label.innerText = 'System Online ⚡';
        if (syncEl) syncEl.innerText = new Date().toLocaleTimeString();
        
        totalCommands++;
        if (cmdEl) cmdEl.innerText = totalCommands;

        const sensorData = {
            temp: safeNum(val.temp),
            hum: safeNum(val.hum),
            rain: safeNum(val.rain),
            gas: safeNum(val.gas),
            light: safeNum(val.light)
        };

        const mergedActuatorData = {
            ...(val.actuators || {}),
            ...(val.automation || {})
        };

        renderSensors(sensorData);
        updateDeviceControls(mergedActuatorData);
        updateCharts(sensorData.temp, sensorData.hum, sensorData.light, sensorData.gas);

        processSensorHistory('temp', sensorData.temp, 'Temperature', '°C');
        processSensorHistory('hum', sensorData.hum, 'Humidity', '%');
        processSensorHistory('rain', sensorData.rain, 'Rainfall', '%');
        processSensorHistory('gas', sensorData.gas, 'Gas Index', 'ppm');
        processSensorHistory('light', sensorData.light, 'Light Level', 'lux');
        
        if (alertArea) {
            if (sensorData.gas > 2500) {
                alertArea.style.display = 'block';
                alertArea.innerHTML = `⚠️ CRITICAL ALERT: High Gas Concentration Detected (${sensorData.gas} ppm)! Exhaust fans engaged.`;
            } else {
                alertArea.style.display = 'none';
            }
        }
    }, (error) => {
        const led = document.getElementById('conn-led');
        if (led) led.className = 'led-dot offline';
        showToast("Connection lost to Firebase!", true);
    });
}

window.addEventListener('DOMContentLoaded', () => {
    initAuthSystem();
    initNavigation();
    initTheme();
    initCharts();
    loadPowerSystem();
    loadHistoricalRecords();
    
    addLog("Dashboard initialized. Waiting for Admin authentication...");
});