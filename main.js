const API_BASE = '/api';

let map;
let heatmapLayer;

const markers = {
    teams: [],
    disasters: []
};

const appState = {
    teams: [],
    disasters: [],
    stats: {
        teamCount: 0,
        disasterCount: 0,
        responseMinutes: null
    },
    currentTab: 'disasters',
    currentDisasterId: null,
    currentChatRoom: null,
    mapClickLocation: null,
    pollTimer: null
};

document.addEventListener('DOMContentLoaded', async function () {
    initMap();
    initDateTime();

    const loaded = await loadState();
    startPolling();

    if (loaded) {
        showNotification('Sistem Hazır', 'MVP veri servisine bağlanıldı', 'success');
    }
});

function initMap() {
    map = L.map('map').setView([39.9334, 32.8597], 6);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    map.zoomControl.setPosition('bottomright');
    map.on('click', function (event) {
        openReportModalWithLocation(event.latlng.lat, event.latlng.lng);
    });
}

function initDateTime() {
    updateDateTime();
    setInterval(updateDateTime, 1000);
}

function updateDateTime() {
    const now = new Date();
    document.getElementById('datetime').textContent = now.toLocaleString('tr-TR', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

async function loadState(options = {}) {
    const { silent = false } = options;

    try {
        setSyncStatus('Veriler guncelleniyor', 'warning');
        const response = await fetch(`${API_BASE}/state`, { cache: 'no-store' });
        const payload = await response.json();

        if (!response.ok) {
            throw new Error(payload.error || 'Durum verisi alınamadı.');
        }

        appState.teams = payload.teams.map(normalizeTeam);
        appState.disasters = payload.disasters.map(normalizeDisaster);
        appState.stats = payload.stats || appState.stats;

        renderAll();
        setSyncStatus('Sistem bagli ve guncel', 'success');
        return true;
    } catch (error) {
        console.error(error);
        setSyncStatus('Baglanti su anda kurulamiyor', 'error');
        if (!silent) {
            showNotification('Bağlantı Hatası', error.message || 'Sunucuya ulaşılamadı', 'error');
        }
        return false;
    }
}

function startPolling() {
    if (appState.pollTimer) {
        clearInterval(appState.pollTimer);
    }

    appState.pollTimer = setInterval(() => {
        loadState({ silent: true });
    }, 15000);
}

function normalizeTeam(team) {
    return {
        ...team,
        location: Array.isArray(team.location) ? team.location : [39.9334, 32.8597]
    };
}

function normalizeDisaster(disaster) {
    return {
        ...disaster,
        time: parseDate(disaster.time),
        resolvedTime: parseDate(disaster.resolvedTime),
        assignedTeams: disaster.assignedTeams || [],
        messages: (disaster.messages || []).map(message => ({
            ...message,
            time: parseDate(message.time)
        })),
        activity: (disaster.activity || []).map(item => ({
            ...item,
            time: parseDate(item.time)
        }))
    };
}

function parseDate(value) {
    return value ? new Date(value) : null;
}

function renderAll() {
    updateStats();
    updateTeamsList();
    updateDisastersList();
    updateMap();
    updateChatRooms();

    if (appState.currentDisasterId) {
        const disaster = getDisasterById(appState.currentDisasterId);
        if (disaster) {
            fillDisasterDetails(disaster);
        } else {
            closeDisasterDetailsModal();
        }
    }

    if (appState.currentChatRoom) {
        const disaster = getDisasterById(appState.currentChatRoom);
        if (disaster) {
            updateCurrentChatRoom();
        } else {
            closeChatRoom();
        }
    }
}

function switchTab(tabName) {
    appState.currentTab = tabName;

    document.querySelectorAll('.tab-btn').forEach(button => {
        button.classList.remove('active');
    });
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');

    if (tabName !== 'chat') {
        closeChatRoom();
    }
}

function updateStats() {
    const responseLabel = appState.stats.responseMinutes == null
        ? '--'
        : `${appState.stats.responseMinutes} dk`;

    document.getElementById('team-count').textContent = appState.stats.teamCount;
    document.getElementById('disaster-count').textContent = appState.stats.disasterCount;
    document.getElementById('response-time').textContent = responseLabel;
}

function updateTeamsList() {
    const teamsList = document.getElementById('teams-list');
    teamsList.innerHTML = '';

    if (appState.teams.length === 0) {
        teamsList.innerHTML = '<div class="empty-state">Kayıtlı ekip bulunmuyor</div>';
        return;
    }

    appState.teams.forEach(team => {
        const item = document.createElement('li');
        item.className = 'item-card';
        item.innerHTML = `
            <div class="item-header">
                <span class="item-title">
                    <i class="fas fa-users"></i>
                    ${escapeHtml(team.name)}
                </span>
                <span class="item-badge ${team.status}">
                    ${team.status === 'active' ? 'Aktif' : 'Beklemede'}
                </span>
            </div>
            <div class="item-details">
                <span><i class="fas fa-briefcase"></i> ${escapeHtml(team.mission)}</span>
                <span><i class="fas fa-user"></i> ${team.members} kişi</span>
            </div>
        `;
        item.onclick = () => centerOnTeam(team);
        teamsList.appendChild(item);
    });
}

function updateDisastersList() {
    const disastersList = document.getElementById('disasters-list');
    disastersList.innerHTML = '';

    const activeDisasters = getActiveDisasters();
    if (activeDisasters.length === 0) {
        disastersList.innerHTML = '<div class="empty-state">Aktif olay bulunmuyor</div>';
        return;
    }

    activeDisasters.forEach(disaster => {
        const item = document.createElement('li');
        item.className = 'item-card';
        item.innerHTML = `
            <div class="item-header">
                <span class="item-title">
                    ${getDisasterIcon(disaster.type)}
                    ${escapeHtml(disaster.type)}
                </span>
                <span class="item-badge ${disaster.severity}">
                    ${getSeverityText(disaster.severity)}
                </span>
            </div>
            <div class="item-details">
                <span><i class="fas fa-location-dot"></i> ${escapeHtml(formatLocation(disaster))}</span>
                <span><i class="fas fa-clock"></i> ${getTimeAgo(disaster.time)}</span>
            </div>
        `;
        item.onclick = () => showDisasterDetails(disaster.id);
        disastersList.appendChild(item);
    });
}

function updateMap() {
    clearMarkers();

    appState.teams.forEach(team => {
        const icon = L.divIcon({
            className: 'custom-marker',
            html: '<div style="background:#2563eb;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(37,99,235,0.4);border:2px solid white;"><i class="fas fa-users" style="color:white;font-size:14px;"></i></div>',
            iconSize: [32, 32]
        });

        const marker = L.marker(team.location, { icon }).addTo(map);
        marker.__entityId = team.id;
        marker.bindPopup(`
            <div style="font-family:'Poppins',sans-serif;min-width:210px;">
                <h3 style="margin:0 0 10px 0;color:#0a0e1a;font-size:14px;">
                    <i class="fas fa-users" style="color:#2563eb;"></i> ${escapeHtml(team.name)}
                </h3>
                <p style="margin:6px 0;color:#64748b;font-size:12px;"><strong>Görev:</strong> ${escapeHtml(team.mission)}</p>
                <p style="margin:6px 0;color:#64748b;font-size:12px;"><strong>Durum:</strong> ${team.status === 'active' ? 'Aktif' : 'Beklemede'}</p>
                <p style="margin:6px 0;color:#64748b;font-size:12px;"><strong>Üye:</strong> ${team.members} kişi</p>
            </div>
        `);
        markers.teams.push(marker);
    });

    getActiveDisasters().forEach(disaster => {
        const color = getSeverityColor(disaster.severity);
        const icon = L.divIcon({
            className: 'custom-marker',
            html: `<div style="background:${color};width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px ${color}80;border:2px solid white;"><i class="${getDisasterIconFA(disaster.type)}" style="color:white;font-size:16px;"></i></div>`,
            iconSize: [38, 38]
        });

        const assignedTeams = getAssignedTeams(disaster).map(team => team.name).join(', ') || 'Henüz ekip yok';
        const marker = L.marker(disaster.location, { icon }).addTo(map);
        marker.__entityId = disaster.id;
        marker.bindPopup(`
            <div style="font-family:'Poppins',sans-serif;min-width:250px;">
                <h3 style="margin:0 0 10px 0;color:#0a0e1a;font-size:14px;">${getDisasterIcon(disaster.type)} ${escapeHtml(disaster.type)}</h3>
                <p style="margin:6px 0;color:#64748b;font-size:12px;"><strong>Konum:</strong> ${escapeHtml(formatLocation(disaster))}</p>
                <p style="margin:6px 0;color:#64748b;font-size:12px;"><strong>Durum:</strong> ${escapeHtml(getStatusText(disaster.status))}</p>
                <p style="margin:6px 0;color:#64748b;font-size:12px;"><strong>Ekipler:</strong> ${escapeHtml(assignedTeams)}</p>
                <p style="margin:6px 0;color:#64748b;font-size:12px;"><strong>Açıklama:</strong> ${escapeHtml(disaster.description)}</p>
                <p style="margin:6px 0;color:#94a3b8;font-size:11px;"><i class="fas fa-clock"></i> ${getTimeAgo(disaster.time)}</p>
            </div>
        `);
        marker.on('click', () => {
            appState.currentDisasterId = disaster.id;
        });
        markers.disasters.push(marker);
    });

    updateHeatmapLayer();
}

function clearMarkers() {
    markers.teams.forEach(marker => map.removeLayer(marker));
    markers.disasters.forEach(marker => map.removeLayer(marker));
    markers.teams = [];
    markers.disasters = [];
}

function updateHeatmapLayer() {
    if (!appState.heatmapVisible) {
        if (heatmapLayer) {
            map.removeLayer(heatmapLayer);
        }
        return;
    }

    if (heatmapLayer) {
        map.removeLayer(heatmapLayer);
    }

    const circles = getActiveDisasters().map(disaster => L.circle(disaster.location, {
        radius: getHeatRadius(disaster.severity),
        color: getSeverityColor(disaster.severity),
        fillColor: getSeverityColor(disaster.severity),
        fillOpacity: 0.12,
        weight: 1
    }));

    heatmapLayer = L.layerGroup(circles).addTo(map);
}

function openReportModal() {
    document.getElementById('report-form').reset();
    document.getElementById('report-modal').classList.add('active');
}

function closeReportModal() {
    document.getElementById('report-modal').classList.remove('active');
    appState.mapClickLocation = null;
}

function openTeamModal() {
    document.getElementById('team-form').reset();
    document.getElementById('team-lat').value = '39.9334';
    document.getElementById('team-lng').value = '32.8597';
    document.getElementById('team-status').value = 'active';
    document.getElementById('team-modal').classList.add('active');
}

function closeTeamModal() {
    document.getElementById('team-modal').classList.remove('active');
}

async function submitDisasterReport(event) {
    event.preventDefault();

    const type = document.getElementById('disaster-type').value;
    const city = document.getElementById('disaster-city').value.trim();
    const district = document.getElementById('disaster-district').value.trim();
    const severity = document.getElementById('disaster-severity').value;
    const description = document.getElementById('disaster-description').value.trim();
    const contact = document.getElementById('disaster-contact').value.trim();
    const phone = document.getElementById('disaster-phone').value.trim();

    const center = appState.mapClickLocation || map.getCenter();

    try {
        const payload = await apiRequest('/disasters', {
            method: 'POST',
            body: JSON.stringify({
                type,
                city,
                district,
                severity,
                description,
                contact,
                phone,
                lat: center.lat,
                lng: center.lng
            })
        });

        closeReportModal();
        switchTab('disasters');
        await loadState({ silent: true });

        const createdDisaster = getDisasterById(payload.disasterId);
        if (createdDisaster) {
            map.setView(createdDisaster.location, 11);
            showDisasterDetails(createdDisaster.id);
        }

        showNotification('Afet Kaydedildi', `${city} için kayıt açıldı`, 'success');
    } catch (error) {
        showNotification('Kayıt Başarısız', error.message || 'Olay kaydı oluşturulamadı', 'error');
    }
}

function centerMap() {
    map.setView([39.9334, 32.8597], 6);
    showNotification('Harita', 'Türkiye görünümüne dönüldü', 'success');
}

function toggleHeatmap() {
    appState.heatmapVisible = !appState.heatmapVisible;
    updateHeatmapLayer();
    showNotification('Yoğunluk Katmanı', appState.heatmapVisible ? 'Yoğunluk katmanı açıldı' : 'Yoğunluk katmanı kapatıldı', 'success');
}

function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
        showNotification('Tam Ekran', 'Tam ekran modu etkin', 'success');
    } else {
        document.exitFullscreen();
        showNotification('Tam Ekran', 'Tam ekran modu kapatıldı', 'success');
    }
}

function centerOnTeam(team) {
    map.setView(team.location, 11);
    const marker = markers.teams.find(item => item.__entityId === team.id);
    if (marker) {
        marker.openPopup();
    }
}

async function refreshDisasters() {
    const loaded = await loadState();
    if (loaded) {
        showNotification('Güncellendi', 'Olay listesi yenilendi', 'success');
    }
}

function showDisasterDetails(disasterId) {
    const disaster = typeof disasterId === 'object' ? disasterId : getDisasterById(disasterId);
    if (!disaster) {
        return;
    }

    appState.currentDisasterId = disaster.id;
    fillDisasterDetails(disaster);
    document.getElementById('disaster-details-modal').classList.add('active');

    map.setView(disaster.location, 11);
    const marker = markers.disasters.find(item => item.__entityId === disaster.id);
    if (marker) {
        marker.openPopup();
    }
}

function fillDisasterDetails(disaster) {
    document.getElementById('detail-type').textContent = disaster.type;
    document.getElementById('detail-location').textContent = formatLocation(disaster);
    document.getElementById('detail-severity').textContent = getSeverityText(disaster.severity);
    document.getElementById('detail-severity').style.color = getSeverityColor(disaster.severity);
    document.getElementById('detail-status').textContent = getStatusText(disaster.status);
    document.getElementById('detail-status').style.color = getStatusColor(disaster.status);
    document.getElementById('detail-time').textContent = disaster.time ? disaster.time.toLocaleString('tr-TR') : '-';
    document.getElementById('detail-description').textContent = disaster.description || '-';

    const contactSection = document.getElementById('contact-section');
    if (disaster.contact || disaster.phone) {
        contactSection.style.display = 'block';
        document.getElementById('detail-contact').textContent = disaster.contact || '-';
        document.getElementById('detail-phone').textContent = disaster.phone || '-';
    } else {
        contactSection.style.display = 'none';
    }

    const resolveButton = document.getElementById('resolve-disaster-btn');
    resolveButton.disabled = disaster.status === 'resolved';
    populateTeamDropdown(disaster);
    updateAssignedTeamsList(disaster);
    updateActivityLog(disaster);
}

function closeDisasterDetailsModal() {
    document.getElementById('disaster-details-modal').classList.remove('active');
    appState.currentDisasterId = null;
}

function populateTeamDropdown(disaster) {
    const dropdown = document.getElementById('team-select-dropdown');
    dropdown.innerHTML = '<option value="">Ekip seçin...</option>';

    appState.teams.forEach(team => {
        const option = document.createElement('option');
        option.value = team.id;
        option.textContent = `${team.name} - ${team.mission} (${team.members} kişi)`;
        if (disaster.assignedTeams.includes(team.id)) {
            option.disabled = true;
        }
        dropdown.appendChild(option);
    });
}

function updateAssignedTeamsList(disaster) {
    const container = document.getElementById('assigned-teams-container');
    container.innerHTML = '';

    const assignedTeams = getAssignedTeams(disaster);
    if (assignedTeams.length === 0) {
        container.innerHTML = '<div class="empty-state">Henüz ekip atanmamış</div>';
        return;
    }

    assignedTeams.forEach(team => {
        const card = document.createElement('div');
        card.className = 'assigned-team-card';
        card.innerHTML = `
            <div class="assigned-team-info">
                <i class="fas fa-users"></i>
                <span><strong>${escapeHtml(team.name)}</strong> - ${escapeHtml(team.mission)}</span>
            </div>
            <button class="btn-remove-team" onclick="removeTeamFromDisaster(${team.id})">
                <i class="fas fa-times"></i>
            </button>
        `;
        container.appendChild(card);
    });
}

function updateActivityLog(disaster) {
    const container = document.getElementById('activity-log-container');
    container.innerHTML = '';

    if (!disaster.activity || disaster.activity.length === 0) {
        container.innerHTML = '<div class="empty-state">Henüz kayıtlı aktivite yok</div>';
        return;
    }

    disaster.activity.slice(0, 10).forEach(item => {
        const activity = document.createElement('div');
        activity.className = 'activity-item';
        activity.innerHTML = `
            <div class="activity-item-title">${escapeHtml(item.message)}</div>
            <div class="activity-item-time">${formatDateTime(item.time)}</div>
        `;
        container.appendChild(activity);
    });
}

async function assignTeamToDisaster() {
    if (!appState.currentDisasterId) {
        return;
    }

    const dropdown = document.getElementById('team-select-dropdown');
    const teamId = Number(dropdown.value);
    if (!teamId) {
        showNotification('Uyarı', 'Lütfen bir ekip seçin', 'warning');
        return;
    }

    try {
        await apiRequest(`/disasters/${appState.currentDisasterId}/assignments`, {
            method: 'POST',
            body: JSON.stringify({ teamId })
        });
        await loadState({ silent: true });
        showNotification('Ekip Atandı', 'Ekip operasyon kaydına eklendi', 'success');
    } catch (error) {
        showNotification('Atama Hatası', error.message || 'Ekip atanamadı', 'error');
    }
}

async function removeTeamFromDisaster(teamId) {
    if (!appState.currentDisasterId) {
        return;
    }

    try {
        await apiRequest(`/disasters/${appState.currentDisasterId}/assignments/${teamId}`, {
            method: 'DELETE'
        });
        await loadState({ silent: true });
        showNotification('Ekip Kaldırıldı', 'Ekip görevden çıkarıldı', 'success');
    } catch (error) {
        showNotification('Güncelleme Hatası', error.message || 'Ekip çıkarılamadı', 'error');
    }
}

async function resolveCurrentDisaster() {
    if (!appState.currentDisasterId) {
        return;
    }

    const approved = window.confirm('Bu olayı çözüldü olarak işaretlemek istiyor musunuz?');
    if (!approved) {
        return;
    }

    try {
        await apiRequest(`/disasters/${appState.currentDisasterId}/resolve`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        await loadState({ silent: true });
        closeDisasterDetailsModal();
        showNotification('Olay Kapatıldı', 'Kayıt çözüldü durumuna alındı', 'success');
    } catch (error) {
        showNotification('İşlem Başarısız', error.message || 'Olay kapatılamadı', 'error');
    }
}

function updateChatRooms() {
    const roomsList = document.getElementById('chat-rooms-list');
    roomsList.innerHTML = '';

    const activeDisasters = getActiveDisasters();
    if (activeDisasters.length === 0) {
        roomsList.innerHTML = '<div class="empty-state">Aktif afet için sohbet odası yok</div>';
        return;
    }

    activeDisasters.forEach(disaster => {
        const latestMessage = disaster.messages[disaster.messages.length - 1];
        const room = document.createElement('div');
        room.className = 'chat-room-card';
        if (appState.currentChatRoom === disaster.id) {
            room.classList.add('active');
        }

        room.innerHTML = `
            <div class="chat-room-info">
                <div class="chat-room-title">
                    ${getDisasterIcon(disaster.type)}
                    ${escapeHtml(disaster.city)} - ${escapeHtml(disaster.type)}
                </div>
                <div class="chat-room-subtitle">${escapeHtml(getAssignedTeamNames(disaster) || 'Ekip ataması bekleniyor')}</div>
                ${latestMessage ? `<div class="chat-room-subtitle">Son mesaj: ${escapeHtml(latestMessage.text)}</div>` : ''}
            </div>
            <div class="chat-room-badge">${disaster.messages.length}</div>
        `;

        room.onclick = () => openChatRoom(disaster.id);
        roomsList.appendChild(room);
    });
}

function openChatRoom(disasterId) {
    const disaster = getDisasterById(disasterId);
    if (!disaster) {
        return;
    }

    appState.currentChatRoom = disaster.id;
    document.getElementById('chat-rooms-list').style.display = 'none';
    document.getElementById('chat-interface').style.display = 'flex';
    document.querySelector('#chat-tab .section-header').style.display = 'none';
    document.getElementById('chat-room-name').textContent = `${disaster.city} - ${disaster.type} (${getAssignedTeamNames(disaster) || 'Ekip Yok'})`;
    updateCurrentChatRoom();
    updateChatRooms();
}

function closeChatRoom() {
    appState.currentChatRoom = null;
    document.getElementById('chat-rooms-list').style.display = 'flex';
    document.getElementById('chat-interface').style.display = 'none';
    document.querySelector('#chat-tab .section-header').style.display = 'flex';
}

function updateCurrentChatRoom() {
    const disaster = getDisasterById(appState.currentChatRoom);
    const chatWindow = document.getElementById('chat-window');
    chatWindow.innerHTML = '';

    if (!disaster) {
        return;
    }

    disaster.messages.forEach(message => {
        const bubble = document.createElement('div');
        if (message.isSystem) {
            bubble.className = 'chat-message received';
            bubble.style.background = 'rgba(37, 99, 235, 0.1)';
            bubble.style.borderLeft = '3px solid var(--primary)';
        } else {
            bubble.className = `chat-message ${message.author === 'Koordinatör' ? 'sent' : 'received'}`;
        }

        bubble.innerHTML = `
            ${message.author === 'Koordinatör' || message.isSystem ? '' : `<div class="chat-message-author"><i class="fas fa-user-circle"></i> ${escapeHtml(message.author)}</div>`}
            ${message.isSystem ? `<div class="chat-message-author"><i class="fas fa-info-circle"></i> ${escapeHtml(message.author)}</div>` : ''}
            <div class="chat-message-text">${escapeHtml(message.text)}</div>
            <div class="chat-message-time">${formatTime(message.time)}</div>
        `;
        chatWindow.appendChild(bubble);
    });

    chatWindow.scrollTop = chatWindow.scrollHeight;
}

async function sendMessage() {
    if (!appState.currentChatRoom) {
        showNotification('Uyarı', 'Önce bir afet odası açın', 'warning');
        return;
    }

    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) {
        return;
    }

    try {
        await apiRequest(`/disasters/${appState.currentChatRoom}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                author: 'Koordinatör',
                text
            })
        });

        input.value = '';
        await loadState({ silent: true });
    } catch (error) {
        showNotification('Mesaj Gönderilemedi', error.message || 'Mesaj kaydedilemedi', 'error');
    }
}

function handleChatKeyPress(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        sendMessage();
    }
}

async function refreshChatRooms() {
    const loaded = await loadState();
    if (loaded) {
        showNotification('Sohbet Güncellendi', 'Afet odaları yenilendi', 'success');
    }
}

async function submitTeamForm(event) {
    event.preventDefault();

    const payload = {
        name: document.getElementById('team-name').value.trim(),
        members: Number(document.getElementById('team-members').value),
        status: document.getElementById('team-status').value,
        mission: document.getElementById('team-mission').value.trim(),
        lat: Number(document.getElementById('team-lat').value),
        lng: Number(document.getElementById('team-lng').value)
    };

    try {
        await apiRequest('/teams', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        closeTeamModal();
        await loadState({ silent: true });
        switchTab('teams');
        showNotification('Ekip Oluşturuldu', 'Yeni ekip başarıyla kaydedildi', 'success');
    } catch (error) {
        showNotification('Kayıt Hatası', error.message || 'Ekip oluşturulamadı', 'error');
    }
}

function openDisasterChat() {
    if (!appState.currentDisasterId) {
        return;
    }

    switchTab('chat');
    const disasterId = appState.currentDisasterId;
    closeDisasterDetailsModal();
    setTimeout(() => openChatRoom(disasterId), 60);
}

function openReportModalWithLocation(lat, lng) {
    appState.mapClickLocation = { lat, lng };
    openReportModal();
    showNotification('Konum Seçildi', 'Yeni olay seçilen koordinat ile açılacak', 'success');
}

function getDisasterById(disasterId) {
    return appState.disasters.find(disaster => disaster.id === disasterId);
}

function getAssignedTeams(disaster) {
    return disaster.assignedTeams
        .map(teamId => appState.teams.find(team => team.id === teamId))
        .filter(Boolean);
}

function getAssignedTeamNames(disaster) {
    return getAssignedTeams(disaster).map(team => team.name).join(', ');
}

function getActiveDisasters() {
    return appState.disasters
        .filter(disaster => disaster.status !== 'resolved')
        .sort((left, right) => {
            const severityOrder = { high: 0, medium: 1, low: 2 };
            const severityDifference = severityOrder[left.severity] - severityOrder[right.severity];
            if (severityDifference !== 0) {
                return severityDifference;
            }
            return (right.time || 0) - (left.time || 0);
        });
}

function getHeatRadius(severity) {
    const radii = {
        high: 35000,
        medium: 25000,
        low: 18000
    };
    return radii[severity] || 15000;
}

function formatLocation(disaster) {
    return disaster.district ? `${disaster.city}, ${disaster.district}` : disaster.city;
}

function formatDateTime(date) {
    return date ? date.toLocaleString('tr-TR') : '-';
}

function formatTime(date) {
    return date ? date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '--:--';
}

function getDisasterIcon(type) {
    const icons = {
        Deprem: '<i class="fas fa-house-crack"></i>',
        Yangın: '<i class="fas fa-fire"></i>',
        Sel: '<i class="fas fa-water"></i>',
        Heyelan: '<i class="fas fa-mountain"></i>',
        Fırtına: '<i class="fas fa-wind"></i>',
        Kar: '<i class="fas fa-snowflake"></i>',
        Diğer: '<i class="fas fa-triangle-exclamation"></i>'
    };
    return icons[type] || '<i class="fas fa-triangle-exclamation"></i>';
}

function getDisasterIconFA(type) {
    const icons = {
        Deprem: 'fas fa-house-crack',
        Yangın: 'fas fa-fire',
        Sel: 'fas fa-water',
        Heyelan: 'fas fa-mountain',
        Fırtına: 'fas fa-wind',
        Kar: 'fas fa-snowflake',
        Diğer: 'fas fa-triangle-exclamation'
    };
    return icons[type] || 'fas fa-triangle-exclamation';
}

function getSeverityColor(severity) {
    const colors = {
        high: '#ef4444',
        medium: '#f59e0b',
        low: '#10b981'
    };
    return colors[severity] || '#6b7280';
}

function getSeverityText(severity) {
    const textMap = {
        high: 'Yüksek',
        medium: 'Orta',
        low: 'Düşük'
    };
    return textMap[severity] || 'Bilinmiyor';
}

function getStatusText(status) {
    const textMap = {
        new: 'Yeni Kayıt',
        in_progress: 'Müdahale Sürüyor',
        resolved: 'Çözüldü',
        archived: 'Arşivlendi'
    };
    return textMap[status] || 'Bilinmiyor';
}

function getStatusColor(status) {
    const colorMap = {
        new: '#f59e0b',
        in_progress: '#2563eb',
        resolved: '#10b981',
        archived: '#64748b'
    };
    return colorMap[status] || '#64748b';
}

function getTimeAgo(date) {
    if (!date) {
        return '--';
    }

    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `${seconds} sn önce`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} dk önce`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} sa önce`;
    return `${Math.floor(seconds / 86400)} gün önce`;
}

async function apiRequest(path, options = {}) {
    const requestOptions = {
        method: options.method || 'GET',
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        },
        body: options.body
    };

    if (!options.body) {
        delete requestOptions.body;
    }

    const response = await fetch(`${API_BASE}${path}`, requestOptions);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || 'İstek başarısız oldu');
    }

    return payload;
}

function setSyncStatus(message, type) {
    const syncStatus = document.getElementById('sync-status');
    const liveStatusText = document.getElementById('live-status-text');
    const liveStatusPill = document.getElementById('live-status-pill');
    const palette = {
        success: { color: '#10b981', background: 'rgba(16, 185, 129, 0.12)' },
        warning: { color: '#f59e0b', background: 'rgba(245, 158, 11, 0.12)' },
        error: { color: '#ef4444', background: 'rgba(239, 68, 68, 0.12)' }
    };
    const currentPalette = palette[type] || palette.warning;

    syncStatus.textContent = message;
    syncStatus.style.color = currentPalette.color;
    liveStatusText.textContent = type === 'success' ? 'Canli' : type === 'error' ? 'Sorun' : 'Guncel';
    liveStatusPill.style.color = currentPalette.color;
    liveStatusPill.style.background = currentPalette.background;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function showNotification(title, message, type = 'success') {
    const container = document.getElementById('notification-container');
    const icons = {
        success: '<i class="fas fa-circle-check"></i>',
        warning: '<i class="fas fa-triangle-exclamation"></i>',
        error: '<i class="fas fa-circle-xmark"></i>'
    };

    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <div class="notification-title">${icons[type] || ''} ${escapeHtml(title)}</div>
        <div class="notification-message">${escapeHtml(message)}</div>
    `;
    container.appendChild(notification);

    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => notification.remove(), 300);
    }, 3500);
}

document.addEventListener('click', function (event) {
    const reportModal = document.getElementById('report-modal');
    const detailsModal = document.getElementById('disaster-details-modal');
    const teamModal = document.getElementById('team-modal');

    if (event.target === reportModal) {
        closeReportModal();
    }

    if (event.target === detailsModal) {
        closeDisasterDetailsModal();
    }

    if (event.target === teamModal) {
        closeTeamModal();
    }
});
