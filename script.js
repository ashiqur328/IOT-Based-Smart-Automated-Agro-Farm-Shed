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

const pendingCommands = new Set();
let totalCommands = 0;
const MAX_CHART_POINTS = 30;
let recordHistory = [], powerHistory = [];
let currentPowerSource = null; 
let climateChart, envChart;
let isDataListenerActive = false;
let currentActuatorData = {};

let audioAlarmEnabled = false;
let lastAudioAlertTime = 0;

// Watchdog & Offline State Variables
let lastDataReceivedTimestamp = 0;
let offlineWatchdogTimer = null;
let isEsp32CurrentlyOffline = false;

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
const solarTimerDisplay = document.getElementById('solarTimerDisplay');
const acTimerDisplay = document.getElementById('acTimerDisplay');
const powerHistoryTimeline = document.getElementById('powerHistoryTimeline');

const safeNum = (val) => (typeof val === 'number' && isFinite(val)) ? val : 0;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function formatSolarTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
}

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

function initAudioSystem() {
    const alarmBtn = document.getElementById('alarmSoundBtn');
    if (!alarmBtn) return;
    
    alarmBtn.addEventListener('click', () => {
        audioAlarmEnabled = !audioAlarmEnabled;
        alarmBtn.innerText = audioAlarmEnabled ? '🔔 Alarm: ACTIVE' : '🔇 Alarm: OFF';
        alarmBtn.classList.toggle('active', audioAlarmEnabled);
        showToast(audioAlarmEnabled ? "Audio Alarms Enabled 🔔" : "Audio Alarms Muted 🔇");
        
        if (audioAlarmEnabled) playBeep(880, 0.15); 
    });
}

function playBeep(freq = 750, duration = 0.3) {
    if (!audioAlarmEnabled) return;
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.start();
        osc.stop(ctx.currentTime + duration);
    } catch (e) {
        console.error("Audio API error", e);
    }
}

function exportTelemetryCSV() {
    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "SMARTSHED TELEMETRY EXPORT REPORT\n";
    csvContent += `Generated Date: ${new Date().toLocaleString()}\n\n`;
    
    csvContent += "Sensor Metric,Min Reading,Max Reading,Rolling Average,Max Recorded Time\n";
    for (const [key, val] of Object.entries(allTimeRecords)) {
        csvContent += `${key.toUpperCase()},${val.min},${val.max},${val.avg.toFixed(2)},"${val.maxTime}"\n`;
    }
    
    csvContent += `\nPower Grid Metrics,Current Active Source: ${currentPowerSource}\n`;
    
    csvContent += "\nHistorical Extreme Event Logs\n";
    csvContent += "Timestamp,Event Details\n";
    if (recordHistory && recordHistory.length > 0) {
        recordHistory.forEach(item => {
            csvContent += `"${item.timestamp}","${item.type}: ${item.value}"\n`;
        });
    }

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `smartshed_analytics_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast("📥 CSV Report Downloaded!");
    addLog("System Action: Historical telemetry report exported to CSV.");
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

function addPowerLog(msg) {
    if (!powerHistoryTimeline) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `<span class="log-time">${time}</span><span>${msg}</span>`;
    powerHistoryTimeline.prepend(entry);
    if (powerHistoryTimeline.children.length > 35) powerHistoryTimeline.removeChild(powerHistoryTimeline.lastChild);

    powerHistory.unshift({ msg, timestamp: time });
    if (powerHistory.length > 35) powerHistory.pop();
    localStorage.setItem('power_grid_history', JSON.stringify(powerHistory));
}

function renderSavedPowerLogs() {
    if (!powerHistoryTimeline) return;
    powerHistoryTimeline.innerHTML = '';
    if (powerHistory.length === 0) {
        powerHistoryTimeline.innerHTML = `<div class="log-entry"><span class="log-time">--:--</span><span>Grid history logging active...</span></div>`;
        return;
    }
    powerHistory.forEach(item => {
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `<span class="log-time">${item.timestamp}</span><span>${item.msg}</span>`;
        powerHistoryTimeline.appendChild(entry);
    });
}

function showToast(msg, isError = false) {
    const toast = document.createElement('div');
    Object.assign(toast.style, {
        position: 'fixed', bottom: '25px', right: '25px',
        background: isError ? '#ef4444' : 'var(--accent)',
        color: 'white', padding: '14px 24px', borderRadius: '10px',
        fontSize: '0.9rem', zIndex: '99999', fontWeight: '600',
        boxShadow: '0 10px 20px rgba(0,0,0,0.4)', transition: 'all 0.3s ease',
        borderLeft: isError ? '6px solid #7f1d1d' : '6px solid #1e3a8a'
    });
    toast.innerText = msg; document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
}

function updatePowerUI(powerData) {
    if (!powerData) return;
    
    const sourceStr = powerData.source || "AC Power 🔌";
    const isSolar = sourceStr.includes("Solar");

    if (currentPowerSource !== null && currentPowerSource !== sourceStr) {
        addPowerLog(`Grid Switch: Routing active on ${sourceStr}`);
        showToast(`⚡ Power Grid Switched to ${sourceStr}`);
    }
    currentPowerSource = sourceStr;

    if (powerSourceBtn) {
        powerSourceBtn.innerText = isSolar ? "☀️ Source: SOLAR POWER" : "🔌 Source: AC MAINS";
        powerSourceBtn.className = `power-btn ${isSolar ? 'solar' : 'ac'}`;
    }

    if (solarTimerDisplay) {
        const sec = safeNum(powerData.solarRuntimeSec);
        solarTimerDisplay.innerText = formatSolarTime(sec);
    }

    if (acTimerDisplay) {
        const sec = safeNum(powerData.acRuntimeSec);
        acTimerDisplay.innerText = formatSolarTime(sec);
    }
}

function loadHistoricalRecords() {
    const storedRecords = localStorage.getItem('all_time_sensor_records');
    const storedCounters = localStorage.getItem('global_math_counters');
    const storedHistory = localStorage.getItem('record_history_timeline');
    const storedPowerLogs = localStorage.getItem('power_grid_history');

    if (storedRecords) allTimeRecords = JSON.parse(storedRecords);
    if (storedCounters) globalCounters = JSON.parse(storedCounters);
    if (storedHistory) recordHistory = JSON.parse(storedHistory);
    if (storedPowerLogs) powerHistory = JSON.parse(storedPowerLogs);

    renderSavedPowerLogs();
    updateAllUI();
}

function processSensorHistory(key, value, label, unit) {
    if (isEsp32CurrentlyOffline || value === 0) return; // Do not mix zero-resets into min/max records

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
    updateAllUI();
}

function initNavigation() {
    document.querySelectorAll('.nav-tab').forEach(t => t.addEventListener('click', (e) => { 
        if (e.target.dataset.page === 'dashboard') switchToDashboard(); 
        else if (e.target.dataset.page === 'records') switchToRecordsPage(); 
    }));
    document.getElementById('homeLogoBtn')?.addEventListener('click', switchToDashboard);
    document.getElementById('gotoRecordsBtn')?.addEventListener('click', switchToRecordsPage);
    document.getElementById('resetRecordsPageBtn')?.addEventListener('click', resetAllRecords);
    document.getElementById('exportCsvBtn')?.addEventListener('click', exportTelemetryCSV);
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
            return `<div class="sensor-card ${isEsp32CurrentlyOffline ? 'sensor-offline' : ''}">
                        <div class="sensor-header"><span>${s.icon} ${s.label}</span><span class="sensor-badge ${isEsp32CurrentlyOffline ? 'warn' : warn}">${isEsp32CurrentlyOffline ? 'OFFLINE' : warn.toUpperCase()}</span></div>
                        <div class="sensor-value" style="${isEsp32CurrentlyOffline ? 'color:#ef4444;' : ''}">${val.toFixed(1)}<span class="sensor-unit">${s.unit}</span></div>
                        <div class="progress-bar"><div class="progress-fill" style="width:${ratio}%; background:${isEsp32CurrentlyOffline ? '#ef4444' : (warn === 'warn' ? 'var(--danger)' : 'var(--success)')};"></div></div>
                    </div>`;
        }).join('');
    }
}

function initActuatorsPanelOnce() {
    if (!actuatorsPanel) return;
    actuatorsPanel.innerHTML = `
        <div class="device-item">
            <div class="device-info">
                <div class="device-icon">🌀</div>
                <div>
                    <div class="device-title">Ceiling Fan</div>
                    <div class="device-sub" id="sub-fan1">🤖 AUTO MODE</div>
                </div>
            </div>
            <div class="button-group">
                <button id="auto-fan1-btn" class="ctrl-btn">Auto OFF</button>
                <button id="pwr-fan1-btn" class="ctrl-btn">PWR OFF</button>
            </div>
        </div>

        <div class="device-item">
            <div class="device-info">
                <div class="device-icon">🌬️</div>
                <div>
                    <div class="device-title">Exhaust Fan</div>
                    <div class="device-sub" id="sub-fan2">🤖 AUTO MODE</div>
                </div>
            </div>
            <div class="button-group">
                <button id="auto-fan2-btn" class="ctrl-btn">Auto OFF</button>
                <button id="pwr-fan2-btn" class="ctrl-btn">PWR OFF</button>
            </div>
        </div>

        <div class="device-item">
            <div class="device-info">
                <div class="device-icon">☀️</div>
                <div>
                    <div class="device-title">Heat Lamp</div>
                    <div class="device-sub" id="sub-heatlight">🤖 AUTO MODE</div>
                </div>
            </div>
            <div class="button-group">
                <button id="auto-heatlight-btn" class="ctrl-btn">Auto OFF</button>
                <button id="pwr-heatlight-btn" class="ctrl-btn">PWR OFF</button>
            </div>
        </div>

        <div class="device-item">
            <div class="device-info">
                <div class="device-icon">🌙</div>
                <div>
                    <div class="device-title">Night Light</div>
                    <div class="device-sub" id="sub-nightlight">🤖 AUTO MODE</div>
                </div>
            </div>
            <div class="button-group">
                <button id="auto-nightlight-btn" class="ctrl-btn">Auto OFF</button>
                <button id="pwr-nightlight-btn" class="ctrl-btn">PWR OFF</button>
            </div>
        </div>

        <div class="device-item">
            <div class="device-info">
                <div class="device-icon">🚰</div>
                <div>
                    <div class="device-title">Water Pump</div>
                    <div class="device-sub">Direct Cloud Override</div>
                </div>
            </div>
            <div style="width: 150px; flex-shrink: 0;">
                <button id="pump-btn" class="pump-btn">START PUMP</button>
            </div>
        </div>

        <div class="device-item" style="border: 1px solid var(--accent); background: rgba(59, 130, 246, 0.05);">
            <div class="device-info">
                <div class="device-icon" style="background: rgba(59, 130, 246, 0.2);">💦</div>
                <div>
                    <div class="device-title" style="color: var(--accent);">Water Spray Servo</div>
                    <div class="device-sub" id="sub-spray">🤖 AUTO MODE</div>
                </div>
            </div>
            <div class="button-group" style="width: auto; gap: 8px;">
                <button id="auto-spray-btn" class="ctrl-btn">Auto OFF</button>
                <button id="sprayBtn" class="pump-btn" style="padding: 10px 16px;">Click Manual Water SPRAY</button>
            </div>
        </div>

        <div class="device-item" style="grid-column: 1 / -1;">
            <div class="device-info">
                <div class="device-icon">🪟</div>
                <div>
                    <div class="device-title">Automated Shed Curtains</div>
                    <div class="device-sub" id="sub-curtain">🤖 AUTO MODE</div>
                </div>
            </div>
            <div class="button-group">
                <button id="auto-curtain-btn" class="ctrl-btn">Auto OFF</button>
                <button id="curtain-open-btn" class="ctrl-btn">▲ Open Curtains</button>
                <button id="curtain-close-btn" class="ctrl-btn">▼ Close Curtains</button>
            </div>
        </div>
    `;

    bindActuatorEventsOnce();
}

function bindActuatorEventsOnce() {
    document.getElementById('auto-fan1-btn')?.addEventListener('click', function() {
        window.toggleFirebaseFlag('automation/autoFan1', !currentActuatorData.autoFan1, this, 'auto');
    });
    document.getElementById('pwr-fan1-btn')?.addEventListener('click', function() {
        window.toggleFirebaseFlag('actuators/fan1', !currentActuatorData.fan1, this, 'pwr');
    });

    document.getElementById('auto-fan2-btn')?.addEventListener('click', function() {
        window.toggleFirebaseFlag('automation/autoFan2', !currentActuatorData.autoFan2, this, 'auto');
    });
    document.getElementById('pwr-fan2-btn')?.addEventListener('click', function() {
        window.toggleFirebaseFlag('actuators/fan2', !currentActuatorData.fan2, this, 'pwr');
    });

    document.getElementById('auto-heatlight-btn')?.addEventListener('click', function() {
        window.toggleFirebaseFlag('automation/autoHeat', !currentActuatorData.autoHeat, this, 'auto');
    });
    document.getElementById('pwr-heatlight-btn')?.addEventListener('click', function() {
        window.toggleFirebaseFlag('actuators/heatlight', !currentActuatorData.heatlight, this, 'pwr');
    });

    document.getElementById('auto-nightlight-btn')?.addEventListener('click', function() {
        window.toggleFirebaseFlag('automation/autoNightLight', !currentActuatorData.autoNightLight, this, 'auto');
    });
    document.getElementById('pwr-nightlight-btn')?.addEventListener('click', function() {
        window.toggleFirebaseFlag('actuators/nightlight', !currentActuatorData.nightlight, this, 'pwr');
    });

    document.getElementById('pump-btn')?.addEventListener('click', function() {
        window.toggleFirebaseFlag('actuators/pump', !currentActuatorData.pump, this, 'pump');
    });

    document.getElementById('auto-spray-btn')?.addEventListener('click', function() {
        window.toggleFirebaseFlag('automation/autoSpray', !currentActuatorData.autoSpray, this, 'auto');
    });
    document.getElementById('sprayBtn')?.addEventListener('click', function() {
        window.triggerWaterSprayServo(this);
    });

    document.getElementById('auto-curtain-btn')?.addEventListener('click', function() {
        window.toggleFirebaseFlag('automation/autoCurtain', !currentActuatorData.autoCurtain, this, 'auto');
    });
    document.getElementById('curtain-open-btn')?.addEventListener('click', function() {
        window.setCurtainState(1, this);
    });
    document.getElementById('curtain-close-btn')?.addEventListener('click', function() {
        window.setCurtainState(0, this);
    });
}

function updateDeviceControls(data) {
    currentActuatorData = data;
    if (pendingCommands.size > 0) return;

    const updateDeviceUI = (key, autoKey, subId, autoBtnId, pwrBtnId) => {
        const isAuto = !!data[autoKey];
        const isPwr = !!data[key];

        const sub = document.getElementById(subId);
        if (sub) sub.innerText = isAuto ? '🤖 AUTO MODE' : '✋ MANUAL MODE';

        const autoBtn = document.getElementById(autoBtnId);
        if (autoBtn) {
            autoBtn.classList.toggle('active', isAuto);
            autoBtn.innerText = isAuto ? 'Auto ON' : 'Auto OFF';
        }

        const pwrBtn = document.getElementById(pwrBtnId);
        if (pwrBtn) {
            pwrBtn.classList.toggle('on', isPwr);
            pwrBtn.innerText = isPwr ? 'PWR ON' : 'PWR OFF';
            pwrBtn.disabled = isAuto;
            pwrBtn.style.opacity = isAuto ? '0.5' : '1';
            pwrBtn.style.cursor = isAuto ? 'not-allowed' : 'pointer';
        }
    };

    updateDeviceUI('fan1', 'autoFan1', 'sub-fan1', 'auto-fan1-btn', 'pwr-fan1-btn');
    updateDeviceUI('fan2', 'autoFan2', 'sub-fan2', 'auto-fan2-btn', 'pwr-fan2-btn');
    updateDeviceUI('heatlight', 'autoHeat', 'sub-heatlight', 'auto-heatlight-btn', 'pwr-heatlight-btn');
    updateDeviceUI('nightlight', 'autoNightLight', 'sub-nightlight', 'auto-nightlight-btn', 'pwr-nightlight-btn');

    const pumpBtn = document.getElementById('pump-btn');
    if (pumpBtn) {
        pumpBtn.classList.toggle('on', !!data.pump);
        pumpBtn.innerText = data.pump ? 'PUMP RUNNING' : 'START PUMP';
    }

    const subSpray = document.getElementById('sub-spray');
    if (subSpray) subSpray.innerText = data.autoSpray ? '🤖 AUTO: HUMIDITY < 30%' : '✋ MANUAL OVERRIDE';
    const autoSprayBtn = document.getElementById('auto-spray-btn');
    if (autoSprayBtn) {
        autoSprayBtn.classList.toggle('active', !!data.autoSpray);
        autoSprayBtn.innerText = data.autoSpray ? 'Auto ON' : 'Auto OFF';
    }
    const sprayBtn = document.getElementById('sprayBtn');
    if (sprayBtn && !pendingCommands.has('actuators/spray')) {
        sprayBtn.classList.toggle('on', !!data.spray);
        sprayBtn.innerText = data.spray ? '💦 SPRAYING (3 CLICKS)...' : 'Click Manual Water SPRAY';
        sprayBtn.disabled = !!data.spray;
    }

    const subCurtain = document.getElementById('sub-curtain');
    if (subCurtain) subCurtain.innerText = data.autoCurtain ? '🤖 AUTO MODE ACTIVE' : '✋ MANUAL OVERRIDE';
    const autoCurtainBtn = document.getElementById('auto-curtain-btn');
    if (autoCurtainBtn) {
        autoCurtainBtn.classList.toggle('active', !!data.autoCurtain);
        autoCurtainBtn.innerText = data.autoCurtain ? 'Auto ON' : 'Auto OFF';
    }
    const curtainOpenBtn = document.getElementById('curtain-open-btn');
    const curtainCloseBtn = document.getElementById('curtain-close-btn');
    if (curtainOpenBtn && curtainCloseBtn) {
        curtainOpenBtn.disabled = !!data.autoCurtain;
        curtainCloseBtn.disabled = !!data.autoCurtain;
        curtainOpenBtn.style.opacity = data.autoCurtain ? '0.5' : '1';
        curtainCloseBtn.style.opacity = data.autoCurtain ? '0.5' : '1';
        curtainOpenBtn.classList.toggle('on', data.curtainStatus === 1);
        curtainCloseBtn.classList.toggle('on', data.curtainStatus === 0);
    }
}

// ─── ROBUST ERROR-HANDLED COMMAND DISPATCHERS ───────────────────────
window.toggleFirebaseFlag = async (path, value, btnElement, type) => {
    try {
        pendingCommands.add(path);

        if (btnElement) {
            btnElement.disabled = true;
            if (type === 'auto') {
                btnElement.classList.toggle('active', value);
                btnElement.innerText = value ? 'Auto ON' : 'Auto OFF';
            } else if (type === 'pwr') {
                btnElement.classList.toggle('on', value);
                btnElement.innerText = value ? 'PWR ON' : 'PWR OFF';
            } else if (type === 'pump') {
                btnElement.classList.toggle('on', value);
                btnElement.innerText = value ? 'PUMP RUNNING' : 'START PUMP';
            }
        }

        const updates = {};
        updates[`/FarmData/${path}`] = value;
        
        await update(ref(db), updates);
        
        if (path.startsWith('actuators/') && path !== 'actuators/pump' && path !== 'actuators/spray') {
            const autoKey = path.replace('actuators/', 'auto').replace('heatlight', 'Heat').replace('nightlight', 'NightLight').replace('fan1', 'Fan1').replace('fan2', 'Fan2');
            const autoUpdates = {};
            autoUpdates[`/FarmData/automation/${autoKey}`] = false;
            await update(ref(db), autoUpdates);
        }
        
        showToast(`Command Sent: ${path.split('/')[1]} ➔ ${value ? 'ON' : 'OFF'}`);
        addLog(`Manual Command: Set ${path.split('/')[1]} to ${value ? 'ON' : 'OFF'}`);

        setTimeout(() => {
            pendingCommands.delete(path);
            if (btnElement) btnElement.disabled = false;
        }, 1200);

    } catch (error) {
        pendingCommands.delete(path);
        if (btnElement) btnElement.disabled = false;
        
        // Fail / Error Message UI Feedback
        const failMessage = `❌ Command Failed: Unable to update ${path.split('/')[1]} (${error.message || 'Network Error'})`;
        showToast(failMessage, true);
        addLog(`❌ Command Execution Failure: [${path}] ${error.message || 'Check connection'}`);
        
        // Revert controls
        updateDeviceControls(currentActuatorData);
    }
};

window.triggerWaterSprayServo = async (btnElement) => {
    const btn = btnElement || document.getElementById('sprayBtn');
    try {
        pendingCommands.add('actuators/spray');

        if (btn) {
            btn.classList.add('on');
            btn.innerText = "💦 SPRAYING (3 CLICKS)...";
            btn.disabled = true;
        }
        
        await update(ref(db), { "/FarmData/actuators/spray": true });
        showToast("💦 Pulsing Water Spray Servo (3 Clicks)...");
        addLog("Actuator Trigger: Water Spray Servo Pulsed (3 Rapid Clicks)");

        setTimeout(() => {
            pendingCommands.delete('actuators/spray');
            if (btn) {
                btn.classList.remove('on');
                btn.innerText = "Click Manual Water SPRAY";
                btn.disabled = false;
            }
        }, 2500);

    } catch (error) {
        pendingCommands.delete('actuators/spray');
        if (btn) {
            btn.classList.remove('on');
            btn.innerText = "Click Manual Water SPRAY";
            btn.disabled = false;
        }
        showToast(`❌ Water Spray Servo Command Failed! (${error.message || 'Network Disconnected'})`, true);
        addLog(`❌ Command Error: Water spray trigger failed.`);
    }
};

window.setCurtainState = async (targetState, btnElement) => {
    try {
        pendingCommands.add('actuators/curtainStatus');
        
        if (btnElement) {
            const siblings = btnElement.parentElement.querySelectorAll('button');
            siblings.forEach(b => b.classList.remove('on'));
            btnElement.classList.add('on');
        }

        await update(ref(db), {
            "/FarmData/automation/autoCurtain": false,
            "/FarmData/actuators/curtainStatus": targetState
        });
        showToast(`Curtain Motor Triggered: ${targetState === 1 ? 'OPENING' : 'CLOSING'}`);
        addLog(`Actuator Trigger: Curtains set to ${targetState === 1 ? 'OPEN' : 'CLOSED'}`);

        setTimeout(() => pendingCommands.delete('actuators/curtainStatus'), 1500);

    } catch (error) {
        pendingCommands.delete('actuators/curtainStatus');
        showToast(`❌ Curtain Motor Command Failed! (${error.message || 'Cloud Sync Error'})`, true);
        addLog(`❌ Command Failure: Curtain motor operation unsuccessful.`);
        updateDeviceControls(currentActuatorData);
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

// ─── ESP32 DISCONNECTION / OFFLINE WATCHDOG ───────────────────────────
function handleESP32OfflineState() {
    if (isEsp32CurrentlyOffline) return;
    isEsp32CurrentlyOffline = true;

    const led = document.getElementById('conn-led');
    const label = document.getElementById('conn-label');

    if (led) led.className = 'led-dot offline';
    if (label) label.innerText = 'ESP32 Offline / Disconnected ⚠️';

    // Set website sensor display to 0
    renderSensors({ temp: 0, hum: 0, rain: 0, gas: 0, light: 0 });

    if (alertArea) {
        alertArea.style.display = 'block';
        alertArea.innerHTML = `⚠️ <strong>SYSTEM ALERT:</strong> ESP32 hardware lost connection! Sensor display reset to 0.`;
    }

    showToast("⚠️ ESP32 disconnected! Sensor values reset to 0.", true);
    addLog("⚠️ System Alert: ESP32 telemetry lost. Sensor values defaulted to 0.");
}

function initFirebaseListener() {
    const farmDataRef = ref(db, '/FarmData');
    
    // Watchdog check every 2 seconds: if no data received for 5 seconds -> set sensors to 0
    if (!offlineWatchdogTimer) {
        offlineWatchdogTimer = setInterval(() => {
            if (lastDataReceivedTimestamp > 0 && (Date.now() - lastDataReceivedTimestamp > 5000)) {
                handleESP32OfflineState();
            }
        }, 2000);
    }

    onValue(farmDataRef, (snapshot) => {
        const val = snapshot.val();
        const led = document.getElementById('conn-led');
        const label = document.getElementById('conn-label');
        const syncEl = document.getElementById('lastSync');
        const cmdEl = document.getElementById('stat-cmds');

        if (!val) {
            handleESP32OfflineState();
            return;
        }

        // ESP32 is actively sending data
        lastDataReceivedTimestamp = Date.now();
        if (isEsp32CurrentlyOffline) {
            isEsp32CurrentlyOffline = false;
            showToast("⚡ ESP32 Connection Re-established!");
            addLog("System Status: ESP32 re-connected to cloud.");
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

        if (val.power) {
            updatePowerUI(val.power);
        }

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
                alertArea.innerHTML = `⚠️ CRITICAL ALERT: High Gas Concentration (${sensorData.gas} ppm)! Exhaust fans engaged.`;
                
                const now = Date.now();
                if (now - lastAudioAlertTime > 3000) {
                    playBeep(950, 0.4);
                    lastAudioAlertTime = now;
                }
            } else if (!isEsp32CurrentlyOffline) {
                alertArea.style.display = 'none';
            }
        }
    }, (error) => {
        handleESP32OfflineState();
        showToast(`❌ Cloud Listener Failed: ${error.message}`, true);
    });
}

window.addEventListener('DOMContentLoaded', () => {
    initAuthSystem();
    initAudioSystem();
    initNavigation();
    initTheme();
    initCharts();
    initActuatorsPanelOnce();
    loadHistoricalRecords();
    
    addLog("Dashboard initialized. Waiting for Admin authentication...");
});
