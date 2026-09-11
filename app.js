/**
 * LINE Meeting Queue App - Frontend Logic
 * Supports LINE LIFF v2, 4-Status Calendar, Branch Duty & Leave, Role-based permissions
 */

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
];

const THAI_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

const MOCK_USERS = {
  employee1: {
    id: 'U_USER_SOMCHAI',
    name: 'สมชาย ใจดี (ฝ่าย IT)',
    picture: 'https://api.dicebear.com/7.x/bottts/svg?seed=Somchai',
    role: 'employee'
  },
  employee2: {
    id: 'U_USER_SOMYING',
    name: 'สมหญิง รักเรียน (การตลาด)',
    picture: 'https://api.dicebear.com/7.x/bottts/svg?seed=Somying',
    role: 'employee'
  },
  teamLeader1: {
    id: 'U_LEADER_SOMSAK',
    leaderId: 'tl-somsak',
    name: 'สมศักดิ์ นำทีม (หัวหน้า IT)',
    picture: 'https://api.dicebear.com/7.x/bottts/svg?seed=SomsakLead',
    role: 'team_leader'
  },
  host: {
    id: 'U_ADMIN_MONTIEN',
    name: 'คุณมณเทียร (Host/Manager)',
    picture: 'https://api.dicebear.com/7.x/bottts/svg?seed=Montien',
    role: 'host'
  }
};

class MeetingQueueApp {
  constructor() {
    this.currentDate = new Date();
    this.viewYear = this.currentDate.getFullYear();
    this.viewMonth = this.currentDate.getMonth() + 1; // 1-12
    
    // Default user is employee1 (Dev test mode)
    this.currentUser = JSON.parse(localStorage.getItem('liff_mock_user') || 'null') || MOCK_USERS.employee1;
    this.liffId = localStorage.getItem('liff_app_id') || '2011528927-vtciodOy';

    this.selectedDate = null;
    this.selectedSlot = null;
    this.branches = [];
    this.eventTypes = [];
    this.monthData = null;
    this.inlineHostMode = 'work';
    this.inlineLeaderMode = 'work';
    this.currentDayData = null;

    this.init();
  }

  timeToMinutes(t) {
    if (!t || typeof t !== 'string' || !t.includes(':')) return 0;
    const parts = t.split(':');
    return (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  }

  minutesToTime(m) {
    const h = Math.floor(m / 60);
    const min = m % 60;
    return `${h < 10 ? '0' + h : h}:${min < 10 ? '0' + min : min}`;
  }

  formatThaiDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
  }

  async init() {
    try {
      this.setupDropdown();
    } catch (e) {
      console.warn('setupDropdown error:', e);
    }

    try {
      this.updateUserUI();
    } catch (e) {
      console.warn('updateUserUI error:', e);
    }

    // 1. Load Calendar, My Bookings, and All Bookings immediately!
    try {
      this.loadMonthCalendar();
    } catch (e) {
      console.warn('loadMonthCalendar error:', e);
    }

    try {
      this.loadMyBookings();
    } catch (e) {
      console.warn('loadMyBookings error:', e);
    }

    try {
      this.loadHostBookings();
    } catch (e) {
      console.warn('loadHostBookings error:', e);
    }

    // 2. Initialize LINE LIFF in background
    this.setupLiff().catch(e => console.warn('setupLiff background catch:', e));
  }

  // -------------------------------------------------------------
  // LINE LIFF Initialization
  // -------------------------------------------------------------
  async setupLiff() {
    if (!this.liffId) {
      this.liffId = '2011528927-vtciodOy';
    }

    if (typeof liff === 'undefined') {
      console.warn('LINE LIFF SDK not available.');
      return;
    }

    try {
      // 3-second safety timeout so desktop browsers and slow connections never hang
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('LIFF init timeout (3s)')), 3000)
      );

      await Promise.race([
        liff.init({ liffId: this.liffId }),
        timeoutPromise
      ]);

      if (liff.isLoggedIn()) {
        const profile = await liff.getProfile();

        // Check user role from server
        let role = 'employee';
        let leaderId = null;

        try {
          const [resLeaders, resSettings] = await Promise.all([
            fetch('/api/team-leaders'),
            fetch('/api/settings')
          ]);
          const leadersData = await resLeaders.json();
          const settingsData = await resSettings.json();

          const adminId = settingsData.settings?.adminUserId;
          const isHost = (adminId && adminId === profile.userId) || profile.userId === 'U0547143d0738f92fe64497e5f49dcefe' || profile.userId === 'U_ADMIN_MONTIEN';
          const matchedLeader = (leadersData.leaders || []).find(l => l.lineUserId === profile.userId);

          if (isHost) {
            role = 'host';
          } else if (matchedLeader) {
            role = 'team_leader';
            leaderId = matchedLeader.id;
          }
        } catch (e) {
          console.warn('Could not verify server role:', e);
        }

        this.currentUser = {
          id: profile.userId,
          leaderId,
          name: profile.displayName,
          picture: profile.pictureUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${profile.userId}`,
          role,
          isLiffUser: true
        };
        localStorage.setItem('liff_mock_user', JSON.stringify(this.currentUser));
        this.updateUserUI();

        // Check-in member to server directory
        try {
          fetch('/api/users/checkin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: profile.userId,
              displayName: profile.displayName,
              pictureUrl: profile.pictureUrl
            })
          }).catch(() => {});
        } catch (e) {}

        this.showToast('success', `ยินดีต้อนรับคุณ ${profile.displayName} (${role === 'host' ? '👑 Host' : role === 'team_leader' ? '👤 หัวหน้าทีม' : 'พนักงาน'})`);
        
        // Refresh with real verified profile data
        this.loadMonthCalendar();
        this.loadMyBookings();
        this.loadHostBookings();
      } else if (typeof liff.isInClient === 'function' && liff.isInClient()) {
        liff.login();
      }
    } catch (err) {
      console.warn('LIFF init notice:', err.message);
      if (typeof liff !== 'undefined' && typeof liff.isInClient === 'function' && liff.isInClient()) {
        this.showToast('error', 'ไม่สามารถเชื่อมต่อ LINE LIFF ได้: ' + err.message);
      }
    }
  }

  openLiffConfigModal() {
    document.getElementById('liffIdInput').value = this.liffId || '';
    document.getElementById('liffConfigModal').classList.remove('hidden');
  }

  closeLiffConfigModal() {
    document.getElementById('liffConfigModal').classList.add('hidden');
  }

  saveLiffId() {
    const val = document.getElementById('liffIdInput').value.trim();
    this.liffId = val;
    localStorage.setItem('liff_app_id', val);
    this.closeLiffConfigModal();
    this.showToast('success', 'บันทึก LIFF ID เรียบร้อยแล้ว กำลังโหลดใหม่...');
    setTimeout(() => location.reload(), 1000);
  }

  // -------------------------------------------------------------
  // User Management & UI
  // -------------------------------------------------------------
  setupDropdown() {
    const btn = document.getElementById('userMenuBtn');
    const dropdown = document.getElementById('userDropdown');

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('hidden');
    });

    document.addEventListener('click', () => {
      dropdown.classList.add('hidden');
    });
  }

  switchUser(userParam) {
    if (this.currentUser?.isLiffUser) {
      this.showToast('warning', '⚠️ บัญชี LINE จริงไม่สามารถสลับบทบาทได้');
      return;
    }

    if (typeof userParam === 'string' && MOCK_USERS[userParam]) {
      this.currentUser = { ...MOCK_USERS[userParam] };
      if (userParam === 'host' && this.monthData?.hostName) {
        this.currentUser.name = `${this.monthData.hostName} (Host)`;
      }
    } else if (typeof userParam === 'object' && userParam !== null) {
      this.currentUser = userParam;
    }

    localStorage.setItem('liff_mock_user', JSON.stringify(this.currentUser));
    this.updateUserUI();
    this.loadMonthCalendar();
    this.loadMyBookings();
    this.loadHostBookings();
    this.showToast('info', `สลับเป็น: ${this.currentUser.name}`);
  }

  renderUserDropdown(teamLeaders, hostName) {
    this.teamLeaders = teamLeaders || [];

    // On real LINE LIFF, don't populate switcher buttons
    if (this.currentUser?.isLiffUser) {
      return;
    }

    // 1. Update Host button in dropdown
    const hostBtnText = document.getElementById('userDropdownHostName');
    if (hostBtnText && hostName) {
      hostBtnText.textContent = `👑 สลับเป็นเจ้าของคิว (Host / ${hostName})`;
    }

    // 2. Populate dynamic team leaders list in dropdown
    const container = document.getElementById('userDropdownLeaders');
    const countBadge = document.getElementById('userDropdownLeadersCount');
    if (!container) return;
    container.innerHTML = '';

    if (countBadge) {
      countBadge.textContent = `${(teamLeaders || []).length} ท่าน`;
    }

    if (!teamLeaders || teamLeaders.length === 0) {
      container.innerHTML = '<div class="px-3 py-1 text-[11px] text-slate-400 italic">ยังไม่มีหัวหน้าทีมในระบบ</div>';
      return;
    }

    teamLeaders.forEach(l => {
      const btn = document.createElement('button');
      const isCurrent = this.currentUser && (this.currentUser.leaderId === l.id || this.currentUser.id === l.lineUserId);
      btn.className = `w-full text-left px-3 py-1.5 text-xs flex items-center justify-between hover:bg-teal-50 text-slate-700 hover:text-teal-900 transition font-medium ${isCurrent ? 'bg-teal-50 text-teal-900 font-bold' : ''}`;
      btn.innerHTML = `
        <div class="flex items-center space-x-2 truncate">
          <span class="w-2 h-2 rounded-full ${isCurrent ? 'bg-emerald-500 ring-2 ring-emerald-300' : 'bg-teal-500'} shrink-0"></span>
          <span class="truncate">👤 ${l.name} <span class="text-[10px] text-slate-400 font-normal">(${l.department || ''})</span></span>
        </div>
        ${isCurrent ? '<span class="text-[10px] text-teal-600 font-bold ml-1">✓</span>' : ''}
      `;
      btn.onclick = () => {
        this.switchUser({
          id: l.lineUserId || ('U_' + l.id),
          leaderId: l.id,
          name: `${l.name} (${l.department || 'หัวหน้าทีม'})`,
          picture: l.picture || `https://api.dicebear.com/7.x/bottts/svg?seed=${l.id}`,
          role: 'team_leader'
        });
      };
      container.appendChild(btn);
    });
  }

  updateUserUI() {
    document.getElementById('userName').textContent = this.currentUser.name;
    document.getElementById('userAvatar').src = this.currentUser.picture;

    // Dropdown profile card elements
    const dropdownAvatar = document.getElementById('dropdownUserAvatar');
    const dropdownName = document.getElementById('dropdownUserName');
    const roleBadge = document.getElementById('userRoleBadge');
    const statusText = document.getElementById('dropdownUserStatusText');

    if (dropdownAvatar) dropdownAvatar.src = this.currentUser.picture;
    if (dropdownName) dropdownName.textContent = this.currentUser.name;

    if (roleBadge) {
      if (this.currentUser.role === 'host') {
        roleBadge.className = 'text-[9px] px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-800 border border-amber-200 shrink-0';
        roleBadge.textContent = '👑 เจ้าของคิว (Host)';
      } else if (this.currentUser.role === 'team_leader') {
        roleBadge.className = 'text-[9px] px-2 py-0.5 rounded-full font-bold bg-teal-100 text-teal-800 border border-teal-200 shrink-0';
        roleBadge.textContent = '👤 หัวหน้าทีม';
      } else {
        roleBadge.className = 'text-[9px] px-2 py-0.5 rounded-full font-bold bg-blue-50 text-blue-700 border border-blue-200 shrink-0';
        roleBadge.textContent = '🟢 พนักงาน';
      }
    }

    const hostTabBtn = document.getElementById('tabHostBtn');
    const tabHostBtnText = document.getElementById('tabHostBtnText');
    const hostAdminSettingsGrid = document.getElementById('hostAdminSettingsGrid');
    const hostClearTestBookingsBtn = document.getElementById('hostClearTestBookingsBtn');
    const hostAdminActionBtns = document.getElementById('hostAdminActionBtns');
    const hostHeaderBanner = document.getElementById('hostHeaderBanner');
    const hostRoleBadge = document.getElementById('hostRoleBadge');
    const hostPanelTitle = document.getElementById('hostPanelTitle');
    const hostPanelDesc = document.getElementById('hostPanelDesc');

    if (this.currentUser.role === 'host') {
      if (hostTabBtn) hostTabBtn.classList.remove('opacity-50');
      if (tabHostBtnText) tabHostBtnText.textContent = 'จัดการระบบ (Host)';
      if (hostAdminSettingsGrid) hostAdminSettingsGrid.classList.remove('hidden');
      if (hostClearTestBookingsBtn) hostClearTestBookingsBtn.classList.remove('hidden');
      if (hostAdminActionBtns) hostAdminActionBtns.classList.remove('hidden');
      if (hostHeaderBanner) {
        hostHeaderBanner.className = 'bg-gradient-to-r from-amber-500 to-orange-500 rounded-2xl p-4 text-white shadow-md';
      }
      if (hostRoleBadge) {
        hostRoleBadge.textContent = '👑 แผงควบคุมผู้ดูแลระบบ (Host Control)';
        hostRoleBadge.className = 'inline-block px-2.5 py-0.5 bg-white/20 rounded-full text-[11px] font-bold uppercase tracking-wider mb-1 text-white';
      }
      if (hostPanelTitle) hostPanelTitle.textContent = 'จัดการระบบและรายชื่อคิวทั้งหมด';
      if (hostPanelDesc) {
        hostPanelDesc.className = 'text-xs text-amber-100 mt-1';
        hostPanelDesc.innerHTML = '✨ <strong>การจัดการประจำวัน:</strong> คุณและหัวหน้าทีมสามารถกดที่วันที่ในหน้าปฏิทินเพื่อเปลี่ยนสาขา แจ้งวันลา หรือบล็อก/ปลดล็อกคิวได้ทันที';
      }
    } else if (this.currentUser.role === 'team_leader') {
      if (hostTabBtn) hostTabBtn.classList.remove('opacity-50');
      if (tabHostBtnText) tabHostBtnText.textContent = 'คิวทั้งหมด (ทีม)';
      if (hostAdminSettingsGrid) hostAdminSettingsGrid.classList.add('hidden');
      if (hostClearTestBookingsBtn) hostClearTestBookingsBtn.classList.add('hidden');
      if (hostAdminActionBtns) hostAdminActionBtns.classList.add('hidden');
      if (hostHeaderBanner) {
        hostHeaderBanner.className = 'bg-gradient-to-r from-teal-600 via-cyan-700 to-teal-800 rounded-2xl p-4 text-white shadow-md';
      }
      if (hostRoleBadge) {
        hostRoleBadge.textContent = '👤 สิทธิ์หัวหน้าทีม (Team Leader)';
        hostRoleBadge.className = 'inline-block px-2.5 py-0.5 bg-white/20 rounded-full text-[11px] font-bold uppercase tracking-wider mb-1 text-teal-100';
      }
      if (hostPanelTitle) hostPanelTitle.textContent = 'รายชื่อคิวการประชุมทั้งหมด (มุมมองหัวหน้าทีม)';
      if (hostPanelDesc) {
        hostPanelDesc.className = 'text-xs text-teal-100 mt-1';
        hostPanelDesc.innerHTML = '👁️ <strong>มุมมองหัวหน้าทีม:</strong> ตรวจสอบรายชื่อพนักงานที่ลงคิวทั้งหมดได้ (ดูอย่างเดียว ไม่สามารถแก้ไขหรือยกเลิกคิวได้)';
      }
    } else {
      if (hostTabBtn) hostTabBtn.classList.remove('opacity-50');
      if (tabHostBtnText) tabHostBtnText.textContent = 'คิวทั้งหมด';
      if (hostAdminSettingsGrid) hostAdminSettingsGrid.classList.add('hidden');
      if (hostClearTestBookingsBtn) hostClearTestBookingsBtn.classList.add('hidden');
      if (hostAdminActionBtns) hostAdminActionBtns.classList.add('hidden');
      if (hostHeaderBanner) {
        hostHeaderBanner.className = 'bg-gradient-to-r from-indigo-600 via-blue-600 to-teal-600 rounded-2xl p-4 text-white shadow-md';
      }
      if (hostRoleBadge) {
        hostRoleBadge.textContent = '👥 รายชื่อคิวประชุมทั้งหมด';
        hostRoleBadge.className = 'inline-block px-2.5 py-0.5 bg-white/20 rounded-full text-[11px] font-bold uppercase tracking-wider mb-1 text-indigo-100';
      }
      if (hostPanelTitle) hostPanelTitle.textContent = 'รายชื่อคิวการประชุมทั้งหมดในระบบ';
      if (hostPanelDesc) {
        hostPanelDesc.className = 'text-xs text-indigo-100 mt-1';
        hostPanelDesc.innerHTML = '👁️ <strong>มุมมองเพื่อนร่วมงาน:</strong> สามารถตรวจสอบคิวและช่วงเวลาที่เพื่อนร่วมงานนัดหมายไว้ได้';
      }
    }

    let isLive = Boolean(this.currentUser && this.currentUser.isLiffUser);
    try {
      if (!isLive && typeof liff !== 'undefined' && liff.isLoggedIn && liff.isLoggedIn()) {
        isLive = true;
      }
    } catch (e) {
      isLive = false;
    }
    const devSection = document.getElementById('devTestAccountsSection');
    const leadersSection = document.getElementById('userDropdownLeadersSection');
    const hostSection = document.getElementById('userDropdownHostSection');
    const liffConfigSection = document.getElementById('userDropdownLiffConfigSection');

    if (isLive) {
      if (devSection) devSection.classList.add('hidden');
      if (leadersSection) leadersSection.classList.add('hidden');
      if (hostSection) hostSection.classList.add('hidden');
      if (liffConfigSection) liffConfigSection.classList.add('hidden');
      if (statusText) statusText.textContent = '🟢 เข้าสู่ระบบผ่าน LINE สำเร็จ';
    } else {
      if (devSection) devSection.classList.remove('hidden');
      if (leadersSection) leadersSection.classList.remove('hidden');
      if (hostSection) hostSection.classList.remove('hidden');
      if (liffConfigSection) liffConfigSection.classList.remove('hidden');
      if (statusText) statusText.textContent = 'โหมดจำลอง (Dev Browser)';
    }

    const lineIdSection = document.getElementById('userLineIdSection');
    const lineIdDisplay = document.getElementById('userLineIdDisplay');
    if (this.currentUser && this.currentUser.id) {
      if (lineIdSection) lineIdSection.classList.remove('hidden');
      if (lineIdDisplay) lineIdDisplay.textContent = this.currentUser.id;
    }
  }

  copyMyLineId() {
    if (this.currentUser?.id) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(this.currentUser.id);
      } else {
        const input = document.createElement('input');
        input.value = this.currentUser.id;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }
      this.showToast('success', `คัดลอก LINE ID เรียบร้อย: ${this.currentUser.id}`);
    }
  }

  switchTab(tabName) {
    const tabs = ['calendar', 'my-bookings', 'host'];
    tabs.forEach(t => {
      const section = document.getElementById(t === 'calendar' ? 'tabCalendar' : t === 'my-bookings' ? 'tabMyBookings' : 'tabHost');
      const btn = document.getElementById(t === 'calendar' ? 'tabCalendarBtn' : t === 'my-bookings' ? 'tabMyBookingsBtn' : 'tabHostBtn');

      if (t === tabName) {
        section.classList.remove('hidden');
        btn.classList.add('border-emerald-500', 'text-emerald-600');
        btn.classList.remove('border-transparent', 'text-slate-500');
      } else {
        section.classList.add('hidden');
        btn.classList.remove('border-emerald-500', 'text-emerald-600');
        btn.classList.add('border-transparent', 'text-slate-500');
      }
    });

    if (tabName === 'my-bookings') this.loadMyBookings();
    if (tabName === 'host') this.loadHostBookings();
    lucide.createIcons();
  }

  // -------------------------------------------------------------
  // Calendar Navigation & Rendering
  // -------------------------------------------------------------
  prevMonth() {
    this.viewMonth--;
    if (this.viewMonth < 1) {
      this.viewMonth = 12;
      this.viewYear--;
    }
    this.loadMonthCalendar();
  }

  nextMonth() {
    this.viewMonth++;
    if (this.viewMonth > 12) {
      this.viewMonth = 1;
      this.viewYear++;
    }
    this.loadMonthCalendar();
  }

  todayMonth() {
    const now = new Date();
    this.viewYear = now.getFullYear();
    this.viewMonth = now.getMonth() + 1;
    this.loadMonthCalendar();
  }

  async loadMonthCalendar() {
    const grid = document.getElementById('calendarGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="col-span-7 py-12 text-center text-slate-400 text-sm">กำลังโหลดข้อมูลปฏิทิน...</div>';

    // Update Title (Thai Buddhist Era = Year + 543)
    const titleEl = document.getElementById('calendarMonthTitle');
    if (titleEl) {
      titleEl.textContent = `${THAI_MONTHS[this.viewMonth - 1]} ${this.viewYear + 543}`;
    }

    try {
      const currentUserId = (this.currentUser && this.currentUser.id) ? this.currentUser.id : '';
      const res = await fetch(`/api/calendar/month?year=${this.viewYear}&month=${this.viewMonth}&userId=${encodeURIComponent(currentUserId)}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      this.monthData = data;
      this.branches = data.branches || [];
      this.eventTypes = data.eventTypes || [];

      const hostHeader = document.getElementById('hostNameHeader');
      if (hostHeader && data.hostName) {
        hostHeader.textContent = `คิวของ: ${data.hostName}`;
      }

      this.renderTeamLegend(data);
      this.populateBranchDropdown();
      this.populateEventTypeDropdown();
      this.renderUserDropdown(data.teamLeaders, data.hostName);
      this.renderCalendarGrid(data.days || []);
    } catch (err) {
      console.error('loadMonthCalendar error:', err);
      grid.innerHTML = '<div class="col-span-7 py-12 text-center text-rose-500 text-sm">เกิดข้อผิดพลาดในการโหลดปฏิทิน กรุณารีเฟรชอีกครั้ง</div>';
    }
  }

  populateEventTypeDropdown() {
    const select = document.getElementById('bookingEventType');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '';
    
    const isHostOrLeader = (this.currentUser.role === 'host' || this.currentUser.role === 'team_leader');

    (this.eventTypes || []).forEach(et => {
      // General employees cannot select "ประชุมบริษัท"
      if (!isHostOrLeader && et.includes('ประชุมบริษัท')) {
        return;
      }
      const opt = document.createElement('option');
      opt.value = et;
      opt.textContent = et;
      select.appendChild(opt);
    });

    if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
      select.value = currentVal;
    }
  }

  renderTeamLegend(data) {
    const container = document.getElementById('teamLegendItems');
    if (!container) return;
    container.innerHTML = '';

    // 1. Host Legend
    const hostEl = document.createElement('div');
    hostEl.className = 'flex items-center space-x-1.5 badge-person badge-person-indigo px-2.5 py-1 rounded-lg border text-[11px] shadow-2xs';
    hostEl.innerHTML = `<span>👑</span> <span class="font-bold">${data.hostName || 'คุณมณเทียร'} (Host)</span> <span class="text-[9px] bg-indigo-100 text-indigo-900 px-1.5 py-0.2 rounded font-medium">📍 ประจำ: ${data.hostDefaultBranchName || 'สำนักงานใหญ่'}</span>`;
    container.appendChild(hostEl);

    // 2. Leaders Legend
    (data.teamLeaders || []).forEach(l => {
      const leaderEl = document.createElement('div');
      const theme = l.colorTheme || 'sky';
      leaderEl.className = `flex items-center space-x-1.5 badge-person badge-person-${theme} px-2.5 py-1 rounded-lg border text-[11px] shadow-2xs`;
      leaderEl.innerHTML = `<span>👤</span> <span class="font-bold">${l.name}</span> <span class="text-[9px] opacity-75">(${l.department})</span> <span class="text-[9px] bg-white/80 px-1.5 py-0.2 rounded font-medium border border-current/20">📍 ประจำ: ${l.defaultBranchName || 'สำนักงานใหญ่'}</span>`;
      container.appendChild(leaderEl);
    });
  }

  renderCalendarGrid(days) {
    const grid = document.getElementById('calendarGrid');
    grid.innerHTML = '';

    // First day of month day-of-week (0 = Sunday, 1 = Monday)
    const firstDayIndex = new Date(this.viewYear, this.viewMonth - 1, 1).getDay();

    // Render blank padding cells before the 1st day
    for (let i = 0; i < firstDayIndex; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'calendar-cell rounded-xl bg-slate-100/40 border border-transparent opacity-40';
      grid.appendChild(emptyCell);
    }

    const isHost = this.currentUser.role === 'host';

    // Render days
    days.forEach(day => {
      const cell = document.createElement('div');
      
      // Determine if date is weekend (Saturday or Sunday)
      const dObj = new Date(day.date + 'T00:00:00');
      const isWeekend = day.isWeekend !== undefined ? !!day.isWeekend : (dObj.getDay() === 0 || dObj.getDay() === 6);

      // Determine CSS class:
      // status-green, status-yellow, status-red, status-grey, status-weekend
      let statusClass = `status-${day.status}`;
      if (isWeekend && day.status === 'grey') {
        statusClass = 'status-weekend';
      }

      cell.className = `calendar-cell rounded-xl border p-1 sm:p-1.5 flex flex-col justify-between cursor-pointer ${statusClass}`;
      
      if (day.status === 'grey') {
        cell.classList.add('cursor-not-allowed');
      }

      // Roster Badges HTML (Host & Team Leaders with compact abbreviations for mobile)
      let rosterBadgesHtml = '';
      if (day.roster && day.roster.length > 0) {
        // Show max 2 roster entries on the calendar cell to prevent vertical overflow on mobile
        const visibleRoster = day.roster.slice(0, 2);
        visibleRoster.forEach(r => {
          const themeClass = `badge-person-${r.colorTheme || 'indigo'}`;
          let text = '';
          if (r.isLeave) {
            if (r.leaveType === 'On Sales') {
              text = r.role === 'host' ? '💼 On Sales' : `${r.shortName}: Sales`;
            } else {
              text = '🏖️ ลา';
            }
          } else if (r.role === 'host') {
            if (r.branchName) {
              let branchShort = r.branchName;
              if (branchShort === 'สำนักงานใหญ่') branchShort = 'สนง.ใหญ่';
              else if (branchShort === 'WFH / ออนไลน์') branchShort = 'WFH';
              text = `👑 ${branchShort}${r.isHalfDay ? ' (ครึ่งวัน)' : ''}`;
            } else {
              // Host duty is blank/unspecified or half-day without branch - do NOT render badge, keep cell clean
              return;
            }
          } else {
            let branchShort = r.branchName || '';
            if (branchShort === 'สำนักงานใหญ่') branchShort = 'สนง.ใหญ่';
            else if (branchShort === 'WFH / ออนไลน์') branchShort = 'WFH';
            text = `${r.shortName}: ${branchShort || 'ปฏิบัติงาน'}`;
          }
          rosterBadgesHtml += `<span class="badge-person ${themeClass}" title="${r.name}: ${r.isLeave ? (r.leaveType || 'ลาพักร้อน') : (r.branchName || 'ปฏิบัติงาน')}">${text}</span>`;
        });
        if (day.roster.length > 2) {
          rosterBadgesHtml += `<span class="text-[7.5px] text-slate-400 font-bold block text-center leading-none">+${day.roster.length - 2}</span>`;
        }
      }

      // Company Meeting indicator & Badge
      let companyMeetingIndicatorHtml = '';
      let companyMeetingBadgeHtml = '';
      if (day.hasCompanyMeeting) {
        companyMeetingIndicatorHtml = `<span class="text-[9px] sm:text-[10px] font-bold leading-none inline-block text-blue-600" title="มีการประชุมบริษัทในวันนี้ (${day.companyMeetingCount || 1} รายการ)">📢</span>`;
        companyMeetingBadgeHtml = `<div class="w-full text-center overflow-hidden"><span class="badge-person inline-block bg-blue-100 text-blue-800 border border-blue-200 text-[8px] sm:text-[9px] font-bold px-1 py-0.2 rounded shadow-2xs leading-tight whitespace-nowrap" title="มีการประชุมบริษัทในวันนี้ (${day.companyMeetingCount || 1} ช่วง)">📢 ประชุมบริษัท${day.companyMeetingCount > 1 ? ` (${day.companyMeetingCount})` : ''}</span></div>`;
      }

      // Interview indicator & Badge
      let interviewIndicatorHtml = '';
      let interviewBadgeHtml = '';
      if (day.hasInterview) {
        interviewIndicatorHtml = `<span class="text-[9px] sm:text-[10px] font-bold leading-none inline-block" title="มีนัดสัมภาษณ์งาน (${day.interviewCount || 1} คิว)">💼</span>`;
        interviewBadgeHtml = `<div class="w-full text-center overflow-hidden"><span class="badge-person inline-block bg-purple-100 text-purple-800 border border-purple-200 text-[8px] sm:text-[9px] font-bold px-1 py-0.2 rounded shadow-2xs leading-tight whitespace-nowrap" title="มีการนัดสัมภาษณ์งานในวันนี้ (${day.interviewCount || 1} คิว)">💼 สัมภาษณ์${day.interviewCount > 1 ? ` (${day.interviewCount})` : ''}</span></div>`;
      }

      // "My Booking" Star Indicator
      let myBookingHtml = '';
      if (day.hasMyBooking) {
        myBookingHtml = `<span class="text-[9px] sm:text-xs font-bold text-amber-500 leading-none" title="คุณมีคิวจองในวันนี้">⭐</span>`;
      }

      // Lock Indicator (Subtle icon for blocked days or weekend)
      let lockIndicatorHtml = '';
      if (isWeekend && day.status === 'grey') {
        lockIndicatorHtml = `<span class="text-[8px] sm:text-[9px] text-rose-400 font-bold leading-none" title="วันหยุดเสาร์-อาทิตย์ (ไม่ได้เปิดรับคิว)">⛱️</span>`;
      } else if (day.status === 'grey' || day.isFullDayBlocked) {
        lockIndicatorHtml = `<span class="text-[8px] sm:text-[9px] text-slate-400 font-bold leading-none" title="ปิดรับคิว (กดเพื่อดูและปลดล็อกได้)">🔒</span>`;
      }

      // Status text summary (Centered, compact, never broken awkwardly into 2 lines)
      let queueText = '';
      if (day.status === 'green') {
        queueText = `<span class="inline-block text-[8px] sm:text-[9.5px] font-semibold text-emerald-700 leading-tight whitespace-nowrap">ว่าง (${day.availableSlots})</span>`;
      } else if (day.status === 'yellow') {
        queueText = `<span class="inline-block text-[8px] sm:text-[9.5px] font-bold text-amber-800 bg-amber-200/70 px-1 py-0.5 rounded leading-tight whitespace-nowrap">จอง ${day.bookedSlots}/${day.totalSlots}</span>`;
      } else if (day.status === 'red') {
        queueText = `<span class="inline-block text-[8px] sm:text-[9.5px] font-bold text-rose-700 bg-rose-100 px-1 py-0.5 rounded leading-tight whitespace-nowrap">คิวเต็ม</span>`;
      } else if (isWeekend) {
        queueText = `<span class="inline-block text-[7.5px] sm:text-[9px] font-semibold text-rose-700 bg-rose-100/90 px-1 py-0.5 rounded leading-tight whitespace-nowrap">เสาร์-อาทิตย์</span>`;
      } else {
        queueText = `<span class="inline-block text-[7.5px] sm:text-[9px] font-semibold text-slate-600 bg-slate-200/90 px-1 py-0.5 rounded leading-tight whitespace-nowrap">ปิดคิว</span>`;
      }

      const dayNumColor = isWeekend ? 'text-rose-600 font-extrabold' : 'text-slate-700';

      cell.innerHTML = `
        <div class="flex items-center justify-between w-full px-0.5 leading-none">
          <span class="font-bold text-xs sm:text-sm ${dayNumColor} leading-none">${day.dayNumber}</span>
          <div class="flex items-center space-x-0.5">
            ${companyMeetingIndicatorHtml}
            ${interviewIndicatorHtml}
            ${myBookingHtml}
            ${lockIndicatorHtml}
          </div>
        </div>
        <div class="my-0.5 space-y-0.5 w-full overflow-hidden">
          ${companyMeetingBadgeHtml}
          ${interviewBadgeHtml}
          ${rosterBadgesHtml}
        </div>
        <div class="w-full text-center leading-none mt-auto pt-0.5 overflow-hidden">
          ${queueText}
        </div>
      `;

      cell.addEventListener('click', () => {
        this.openDayModal(day.date);
      });

      grid.appendChild(cell);
    });

    lucide.createIcons();
  }

  // -------------------------------------------------------------
  // Day Details & Booking Flow
  // -------------------------------------------------------------
  async openDayModal(dateStr) {
    this.selectedDate = dateStr;
    this.selectedSlot = null;

    const modal = document.getElementById('dayModal');
    const titleEl = document.getElementById('modalDateTitle');
    const badgeEl = document.getElementById('modalDateBadge');
    const dutyBanner = document.getElementById('modalDutyBanner');
    const dutyTitle = document.getElementById('modalDutyTitle');
    const dutyDesc = document.getElementById('modalDutyDesc');
    const slotsList = document.getElementById('modalSlotsList');
    const formContainer = document.getElementById('bookingFormContainer');

    formContainer.classList.add('hidden');
    slotsList.innerHTML = '<div class="py-8 text-center text-slate-400 text-xs">กำลังโหลดช่วงเวลา...</div>';
    modal.classList.remove('hidden');

    // Format Thai Date
    const d = new Date(dateStr + 'T00:00:00');
    titleEl.textContent = `วัน${THAI_DAYS[d.getDay()]}ที่ ${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;

    try {
      const res = await fetch(`/api/calendar/day?date=${dateStr}&userId=${encodeURIComponent(this.currentUser.id)}`, {
        headers: {
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        }
      });
      const data = await res.json();

      this.currentDayData = data;

      // 1. Host Inline Management Box (แสดงเฉพาะเมื่อ Host เป็นผู้เปิดดู)
      const hostBox = document.getElementById('hostInlineManageBox');
      const hostStatusText = document.getElementById('hostDayBlockStatusText');
      const toggleBtn = document.getElementById('toggleDayBlockBtn');
      const toggleBtnText = document.getElementById('toggleDayBlockBtnText');

      if (data.isHost) {
        hostBox.classList.remove('hidden');
        if (data.isFullDayBlocked) {
          hostStatusText.textContent = 'สถานะ: ⛔ ถูกบล็อกคิวไว้ทั้งวัน (กดเพื่อ Unlock เปิดรับคิว)';
          toggleBtnText.textContent = '🔓 ปลดล็อกเปิดรับคิว (Unlock Queue)';
          toggleBtn.className = 'px-4 py-2 font-bold rounded-xl text-xs shadow-md transition flex items-center justify-center space-x-1.5 bg-emerald-600 hover:bg-emerald-700 text-white self-stretch sm:self-auto ring-2 ring-emerald-300';
        } else {
          hostStatusText.textContent = 'สถานะ: เปิดรับคิวตามปกติ';
          toggleBtnText.textContent = '⛔ บล็อกคิวทั้งวัน (ปิดรับคิว)';
          toggleBtn.className = 'px-3.5 py-1.5 font-bold rounded-xl text-xs shadow-xs transition flex items-center justify-center space-x-1.5 bg-rose-600 hover:bg-rose-700 text-white self-stretch sm:self-auto';
        }

        // Populate host branches
        const hostBranchSelect = document.getElementById('inlineHostBranchSelect');
        hostBranchSelect.innerHTML = '';
        
        // Option 1: None (Blank / Work normally without showing location badge)
        const optNone = document.createElement('option');
        optNone.value = 'none';
        optNone.textContent = '🔘 ไม่ระบุสถานที่ (ทำงานปกติ / แสดงตารางว่าง)';
        hostBranchSelect.appendChild(optNone);

        this.branches.forEach(b => {
          const opt = document.createElement('option');
          opt.value = b.id;
          opt.textContent = `${b.name} (${b.address || ''})`;
          hostBranchSelect.appendChild(opt);
        });

        const modalDObj = new Date(dateStr + 'T00:00:00');
        const isModalDateWeekend = (modalDObj.getDay() === 0 || modalDObj.getDay() === 6);
        const halfDayRow = document.getElementById('inlineHostHalfDayRow');
        if (halfDayRow) {
          if (isModalDateWeekend) {
            halfDayRow.classList.remove('hidden');
          } else {
            halfDayRow.classList.add('hidden');
          }
        }

        const halfDayCheckbox = document.getElementById('inlineHostHalfDay');
        if (halfDayCheckbox) {
          halfDayCheckbox.onchange = () => {
            if (halfDayCheckbox.checked) {
              this.setInlineHostDutyMode('work');
              // Automatically reset host branch to 'none' so host status is blank on calendar
              hostBranchSelect.value = 'none';
            }
          };
        }

        // Prefill Host Duty
        if (data.duty) {
          if (data.duty.isLeave) {
            this.setInlineHostDutyMode('leave');
            document.getElementById('inlineHostLeaveTypeSelect').value = data.duty.leaveType || 'ลาพักร้อน';
          } else {
            this.setInlineHostDutyMode('work');
            if (data.duty.branchId) {
              hostBranchSelect.value = data.duty.branchId;
            } else {
              hostBranchSelect.value = 'none';
            }
          }
          if (halfDayCheckbox) {
            halfDayCheckbox.checked = isModalDateWeekend ? !!data.duty.isHalfDay : false;
          }
          document.getElementById('inlineHostNoteInput').value = (data.duty.note && data.duty.note !== 'สาขาประจำปกติ') ? data.duty.note : '';
        } else {
          this.setInlineHostDutyMode('work');
          hostBranchSelect.value = 'none';
          if (halfDayCheckbox) halfDayCheckbox.checked = false;
          document.getElementById('inlineHostNoteInput').value = '';
        }
      } else {
        hostBox.classList.add('hidden');
      }

      // Status Badge
      const status = data.statusInfo.status;
      badgeEl.textContent = data.statusInfo.statusText;
      badgeEl.className = 'inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider mb-0.5 ' +
        (status === 'green' ? 'bg-emerald-100 text-emerald-700' :
         status === 'yellow' ? 'bg-amber-100 text-amber-700' :
         status === 'red' ? 'bg-rose-100 text-rose-700' : 'bg-slate-200 text-slate-600');

      // Duty / Branch Banner (แบนเนอร์แสดงสถานที่ของหัวหน้า)
      if (data.duty) {
        dutyBanner.classList.remove('hidden');
        if (data.duty.isLeave) {
          if (data.duty.leaveType === 'On Sales') {
            dutyBanner.className = 'p-3.5 rounded-2xl border flex items-start space-x-3 bg-amber-50 border-amber-300 text-amber-900';
            dutyTitle.textContent = '💼 เจ้าของคิว (Host): On Sales';
            dutyDesc.textContent = data.duty.note || 'ออกพบลูกค้า / ขายงานภายนอก (ปิดรับคิวการประชุม)';
          } else {
            dutyBanner.className = 'p-3.5 rounded-2xl border flex items-start space-x-3 bg-rose-50 border-rose-200 text-rose-900';
            dutyTitle.textContent = `🏖️ เจ้าของคิว (Host) ลา: ${data.duty.leaveType || 'ลาพักร้อน'}`;
            dutyDesc.textContent = data.duty.note || 'ปิดรับคิวการประชุม';
          }
        } else if (data.duty.isHalfDay && !data.duty.branchName) {
          dutyBanner.className = 'p-3.5 rounded-2xl border flex items-start space-x-3 bg-amber-50 border-amber-200 text-amber-900';
          dutyTitle.textContent = '⏰ ปฏิบัติงานครึ่งวัน (08:00 - 12:00 น.)';
          dutyDesc.textContent = data.duty.note || 'เปิดรับคิว 4 ช่วงเวลาในตอนเช้า (08:00 - 12:00 น.)';
        } else if (data.duty.branchName) {
          dutyBanner.className = 'p-3.5 rounded-2xl border flex items-start space-x-3 bg-blue-50 border-blue-200 text-blue-900';
          dutyTitle.textContent = `📍 สถานที่ปฏิบัติงาน: ${data.duty.branchName}${data.duty.isHalfDay ? ' (ครึ่งวันเช้า)' : ''}`;
          dutyDesc.textContent = data.duty.note || 'เข้าปฏิบัติงานตามปกติ สามารถลงคิวเข้าพบได้';
        } else {
          dutyBanner.className = 'p-3.5 rounded-2xl border flex items-start space-x-3 bg-slate-50 border-slate-200 text-slate-700';
          dutyTitle.textContent = '📍 สถานะ: เข้าปฏิบัติงานตามปกติ';
          dutyDesc.textContent = data.duty.note || 'เปิดรับคิวการประชุมตามปกติ';
        }
      } else {
        dutyBanner.classList.remove('hidden');
        dutyBanner.className = 'p-3.5 rounded-2xl border flex items-start space-x-3 bg-slate-50 border-slate-200 text-slate-700';
        dutyTitle.textContent = '📍 สถานะ: เข้าปฏิบัติงานตามปกติ';
        dutyDesc.textContent = 'เปิดรับคิวการประชุมตามปกติ';
      }

      // 3. Setup Team Leader Inline Box & Leaders List
      const leaderSelect = document.getElementById('inlineLeaderSelect');
      leaderSelect.innerHTML = '';
      const leaderBranchSelect = document.getElementById('inlineLeaderBranchSelect');
      leaderBranchSelect.innerHTML = '';
      const optNoneLeader = document.createElement('option');
      optNoneLeader.value = 'none';
      optNoneLeader.textContent = '🔘 ไม่ระบุสถานที่ (ทำงานปกติ / แสดงตารางว่าง)';
      leaderBranchSelect.appendChild(optNoneLeader);
      this.branches.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = `${b.name} (${b.address || ''})`;
        leaderBranchSelect.appendChild(opt);
      });

      (data.teamDuties || []).forEach(tl => {
        const opt = document.createElement('option');
        opt.value = tl.leaderId;
        opt.textContent = `${tl.leaderName} (${tl.department})`;
        leaderSelect.appendChild(opt);
      });

      const leaderBox = document.getElementById('leaderInlineManageBox');
      const isLeader = this.currentUser.role === 'team_leader';
      const isHost = data.isHost || this.currentUser.role === 'host';
      const btnLeaderUpdateSelf = document.getElementById('btnLeaderUpdateSelf');

      if (isLeader) {
        // Auto-show inline box for leader and preselect self
        const myTl = (data.teamDuties || []).find(tl => tl.lineUserId === this.currentUser.id || tl.leaderId === this.currentUser.leaderId);
        if (myTl) {
          leaderSelect.value = myTl.leaderId;
        }
        this.populateLeaderInlineForm(leaderSelect.value);
        leaderBox.classList.remove('hidden');
        btnLeaderUpdateSelf.classList.remove('hidden');
      } else if (isHost) {
        // Host can open it if needed
        btnLeaderUpdateSelf.classList.remove('hidden');
        leaderBox.classList.add('hidden');
      } else {
        leaderBox.classList.add('hidden');
        btnLeaderUpdateSelf.classList.add('hidden');
      }

      // Render Team Leaders Daily Duties List
      const leadersListEl = document.getElementById('modalTeamLeadersList');
      leadersListEl.innerHTML = '';
      if (!data.teamDuties || data.teamDuties.length === 0) {
        leadersListEl.innerHTML = '<div class="text-[11px] text-slate-400 py-1">ยังไม่มีรายชื่อหัวหน้าทีม</div>';
      } else {
        data.teamDuties.forEach(tl => {
          const item = document.createElement('div');
          item.className = 'p-2 rounded-xl border border-slate-200 bg-white flex items-center justify-between text-xs shadow-2xs';

          let statusBadge = '';
          if (tl.duty) {
            if (tl.duty.isLeave) {
              if (tl.duty.leaveType === 'On Sales') {
                statusBadge = `<span class="bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded-md text-[10px]">💼 On Sales</span>`;
              } else {
                statusBadge = `<span class="bg-rose-100 text-rose-700 font-bold px-2 py-0.5 rounded-md text-[10px]">🏖️ ${tl.duty.leaveType || 'ลาพักร้อน'}</span>`;
              }
            } else if (tl.duty.branchName) {
              statusBadge = `<span class="bg-blue-100 text-blue-700 font-bold px-2 py-0.5 rounded-md text-[10px]">🏢 ${tl.duty.branchName}</span>`;
            } else {
              statusBadge = `<span class="bg-emerald-100 text-emerald-700 font-semibold px-2 py-0.5 rounded-md text-[10px]">🏢 ปฏิบัติงานปกติ (ว่าง)</span>`;
            }
          } else {
            statusBadge = `<span class="bg-slate-100 text-slate-500 font-medium px-2 py-0.5 rounded-md text-[10px]">🏢 ปฏิบัติงานปกติ (ว่าง)</span>`;
          }

          const isMe = (this.currentUser.id === tl.lineUserId || (this.currentUser.leaderId && this.currentUser.leaderId === tl.leaderId));

          item.innerHTML = `
            <div class="flex items-center space-x-2">
              <img src="${tl.picture}" class="w-6 h-6 rounded-full bg-slate-200 border border-white">
              <div>
                <span class="font-bold text-slate-800 text-[11px] sm:text-xs">${tl.leaderName}</span>
                <span class="text-[10px] text-slate-400 ml-1">(${tl.department})</span>
                ${isMe ? '<span class="ml-1 text-[9px] font-bold bg-teal-100 text-teal-800 px-1 py-0.2 rounded">คุณ</span>' : ''}
                ${tl.duty && tl.duty.note ? `<div class="text-[10px] text-slate-500 italic mt-0.5">"${tl.duty.note}"</div>` : ''}
              </div>
            </div>
            <div class="flex items-center space-x-1.5">
              ${statusBadge}
              ${(isMe || isHost) ? `
                <button onclick="app.openLeaderInlineBox('${tl.leaderId}')" class="p-1 text-teal-600 hover:bg-teal-50 rounded transition" title="แก้ไขสถานะในหน้านี้">
                  <i data-lucide="edit-2" class="w-3 h-3"></i>
                </button>
              ` : ''}
            </div>
          `;
          leadersListEl.appendChild(item);
        });
      }

      this.renderSlots(data.slots, data.isHost);
    } catch (err) {
      console.error(err);
      slotsList.innerHTML = '<div class="py-6 text-center text-rose-500 text-xs">เกิดข้อผิดพลาดในการโหลดช่วงเวลา</div>';
    }

    lucide.createIcons();
  }

  closeDayModal() {
    document.getElementById('dayModal').classList.add('hidden');
    this.selectedDate = null;
    this.selectedSlot = null;
  }

  async toggleDayBlock() {
    if (!this.selectedDate) return;

    try {
      const res = await fetch('/api/host/toggle-day-block', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({ date: this.selectedDate })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถเปลี่ยนสถานะบล็อกได้');

      this.showToast(data.isBlocked ? 'info' : 'success', data.message);
      await this.openDayModal(this.selectedDate);
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async quickUnlockDate(dateStr) {
    if (this.currentUser.role !== 'host') {
      this.showToast('error', 'ความปลอดภัย: เฉพาะ Host เท่านั้นที่สามารถปลดล็อกคิวได้');
      return;
    }

    try {
      const res = await fetch('/api/host/toggle-day-block', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({ date: dateStr })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถปลดล็อกได้');

      this.showToast('success', `🔓 ${data.message}`);
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async clearTestBookings() {
    if (this.currentUser.role !== 'host') {
      this.showToast('error', 'ความปลอดภัย: เฉพาะ Host เท่านั้นที่สามารถล้างคิวได้');
      return;
    }

    if (!confirm('ยืนยันการล้างประวัติการจองทดสอบทั้งหมดหรือไม่?\n\n(ข้อมูลการจองทั้งหมดจะถูกรีเซ็ตให้ว่าง 100% เพื่อเตรียมเปิดรับคิวจริง)')) {
      return;
    }

    try {
      const res = await fetch('/api/host/clear-test-bookings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        }
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถล้างคิวได้');

      this.showToast('success', '🧹 ล้างประวัติการจองทดสอบทั้งหมดเรียบร้อยแล้ว');
      await this.loadMonthCalendar();
      if (typeof this.loadHostBookings === 'function') {
        await this.loadHostBookings();
      }
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  // -------------------------------------------------------------
  // Backup & Restore Database (สำรองและกู้คืนฐานข้อมูล)
  // -------------------------------------------------------------
  async exportDatabase() {
    if (this.currentUser.role !== 'host') {
      this.showToast('error', 'ความปลอดภัย: เฉพาะ Host เท่านั้นที่สามารถสำรองข้อมูลได้');
      return;
    }

    try {
      const res = await fetch('/api/admin/export-database', {
        headers: {
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        }
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'ไม่สามารถดาวน์โหลดข้อมูลได้');
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `database.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      this.showToast('success', '📥 ดาวน์โหลดไฟล์สำรองข้อมูล database.json เรียบร้อยแล้ว');
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async importDatabase(e) {
    if (this.currentUser.role !== 'host') {
      this.showToast('error', 'ความปลอดภัย: เฉพาะ Host เท่านั้นที่สามารถกู้คืนข้อมูลได้');
      e.target.value = '';
      return;
    }

    const file = e.target.files && e.target.files[0];
    if (!file) return;

    if (!confirm(`ต้องการกู้คืนฐานข้อมูลจากไฟล์ "${file.name}" ใช่หรือไม่?\n\nข้อมูลการตั้งค่า, สาขา, รายชื่อหัวหน้าทีม และคิวการจองทั้งหมดจะถูกแทนที่ด้วยข้อมูลจากไฟล์นี้`)) {
      e.target.value = '';
      return;
    }

    try {
      const text = await file.text();
      const json = JSON.parse(text);

      const res = await fetch('/api/admin/import-database', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify(json)
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถกู้คืนข้อมูลได้');

      this.showToast('success', '📤 กู้คืนฐานข้อมูลสำเร็จแล้ว กำลังโหลดข้อมูลใหม่...');
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      this.showToast('error', 'เกิดข้อผิดพลาดในการกู้คืน: ' + err.message);
    } finally {
      e.target.value = '';
    }
  }

  // -------------------------------------------------------------
  // Inline Host & Leader Daily Management Handlers (หน้าต่างจัดการคิวประจำวัน)
  // -------------------------------------------------------------
  switchHostSubTab(tab) {
    const dutyBtn = document.getElementById('tabHostSubDutyBtn');
    const blockBtn = document.getElementById('tabHostSubBlockBtn');
    const dutyTab = document.getElementById('hostSubTabDuty');
    const blockTab = document.getElementById('hostSubTabBlock');

    if (tab === 'duty') {
      dutyBtn.className = 'pb-2 px-2 font-bold border-b-2 border-amber-600 text-amber-900 transition flex items-center space-x-1';
      blockBtn.className = 'pb-2 px-2 font-medium text-slate-500 hover:text-slate-800 border-b-2 border-transparent transition flex items-center space-x-1';
      dutyTab.classList.remove('hidden');
      blockTab.classList.add('hidden');
    } else {
      dutyBtn.className = 'pb-2 px-2 font-medium text-slate-500 hover:text-slate-800 border-b-2 border-transparent transition flex items-center space-x-1';
      blockBtn.className = 'pb-2 px-2 font-bold border-b-2 border-rose-600 text-rose-900 transition flex items-center space-x-1';
      dutyTab.classList.add('hidden');
      blockTab.classList.remove('hidden');
    }
    lucide.createIcons();
  }

  setInlineHostDutyMode(mode) {
    this.inlineHostMode = mode;
    const workBtn = document.getElementById('inlineHostModeWork');
    const leaveBtn = document.getElementById('inlineHostModeLeave');
    const branchRow = document.getElementById('inlineHostBranchSelectRow');
    const leaveRow = document.getElementById('inlineHostLeaveSelectRow');

    if (mode === 'work') {
      workBtn.className = 'py-2 px-2.5 border border-amber-500 bg-amber-100/70 text-amber-900 rounded-xl font-bold text-center transition flex items-center justify-center space-x-1.5';
      leaveBtn.className = 'py-2 px-2.5 border border-slate-200 bg-white text-slate-600 rounded-xl font-semibold text-center transition flex items-center justify-center space-x-1.5 hover:bg-slate-50';
      branchRow.classList.remove('hidden');
      leaveRow.classList.add('hidden');
    } else {
      workBtn.className = 'py-2 px-2.5 border border-slate-200 bg-white text-slate-600 rounded-xl font-semibold text-center transition flex items-center justify-center space-x-1.5 hover:bg-slate-50';
      leaveBtn.className = 'py-2 px-2.5 border border-rose-500 bg-rose-100/70 text-rose-900 rounded-xl font-bold text-center transition flex items-center justify-center space-x-1.5';
      branchRow.classList.add('hidden');
      leaveRow.classList.remove('hidden');
    }
  }

  setInlineLeaderDutyMode(mode) {
    this.inlineLeaderMode = mode;
    const workBtn = document.getElementById('inlineLeaderModeWork');
    const leaveBtn = document.getElementById('inlineLeaderModeLeave');
    const branchRow = document.getElementById('inlineLeaderBranchSelectRow');
    const leaveRow = document.getElementById('inlineLeaderLeaveSelectRow');

    if (mode === 'work') {
      workBtn.className = 'py-2 px-2.5 border border-teal-500 bg-teal-100 text-teal-900 rounded-xl font-bold text-center transition flex items-center justify-center space-x-1.5';
      leaveBtn.className = 'py-2 px-2.5 border border-slate-200 bg-white text-slate-600 rounded-xl font-semibold text-center transition flex items-center justify-center space-x-1.5 hover:bg-slate-50';
      branchRow.classList.remove('hidden');
      leaveRow.classList.add('hidden');
    } else {
      workBtn.className = 'py-2 px-2.5 border border-slate-200 bg-white text-slate-600 rounded-xl font-semibold text-center transition flex items-center justify-center space-x-1.5 hover:bg-slate-50';
      leaveBtn.className = 'py-2 px-2.5 border border-rose-500 bg-rose-100 text-rose-900 rounded-xl font-bold text-center transition flex items-center justify-center space-x-1.5';
      branchRow.classList.add('hidden');
      leaveRow.classList.remove('hidden');
    }
  }

  toggleLeaderInlineBox(show) {
    const box = document.getElementById('leaderInlineManageBox');
    if (show) {
      box.classList.remove('hidden');
      const leaderSelect = document.getElementById('inlineLeaderSelect');
      this.populateLeaderInlineForm(leaderSelect.value);
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      box.classList.add('hidden');
    }
    lucide.createIcons();
  }

  openLeaderInlineBox(leaderId) {
    const box = document.getElementById('leaderInlineManageBox');
    box.classList.remove('hidden');
    const leaderSelect = document.getElementById('inlineLeaderSelect');
    if (leaderId) {
      leaderSelect.value = leaderId;
    }
    this.populateLeaderInlineForm(leaderSelect.value);
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    lucide.createIcons();
  }

  onInlineLeaderSelectChange() {
    const leaderSelect = document.getElementById('inlineLeaderSelect');
    this.populateLeaderInlineForm(leaderSelect.value);
  }

  populateLeaderInlineForm(leaderId) {
    if (!this.currentDayData || !this.currentDayData.teamDuties) return;
    const tl = this.currentDayData.teamDuties.find(t => t.leaderId === leaderId);
    if (tl && tl.duty) {
      if (tl.duty.isLeave) {
        this.setInlineLeaderDutyMode('leave');
        document.getElementById('inlineLeaderLeaveTypeSelect').value = tl.duty.leaveType || 'ลาพักร้อน';
      } else {
        this.setInlineLeaderDutyMode('work');
        if (tl.duty.branchId) {
          document.getElementById('inlineLeaderBranchSelect').value = tl.duty.branchId;
        } else {
          document.getElementById('inlineLeaderBranchSelect').value = 'none';
        }
      }
      document.getElementById('inlineLeaderNoteInput').value = (tl.duty.note && tl.duty.note !== 'สาขาประจำปกติ') ? tl.duty.note : '';
    } else {
      this.setInlineLeaderDutyMode('work');
      document.getElementById('inlineLeaderBranchSelect').value = 'none';
      document.getElementById('inlineLeaderNoteInput').value = '';
    }
  }

  async saveInlineHostDuty() {
    if (!this.selectedDate) return;
    const note = document.getElementById('inlineHostNoteInput').value.trim();
    const isHalfDay = document.getElementById('inlineHostHalfDay') ? document.getElementById('inlineHostHalfDay').checked : false;
    let payload = { date: this.selectedDate, note, isHalfDay };

    if (isHalfDay) {
      // เมื่อเลือกทำงานครึ่งวัน ให้บังคับเปิดคิวทันที (ไม่เป็นสถานะลา)
      payload.isLeave = false;
      const branchId = document.getElementById('inlineHostBranchSelect').value;
      if (branchId && branchId !== 'none' && branchId !== 'clear') {
        const branchObj = this.branches.find(b => b.id === branchId);
        payload.branchId = branchId;
        payload.branchName = branchObj ? branchObj.name : 'สำนักงานใหญ่';
      } else {
        payload.branchId = null;
        payload.branchName = null;
      }
    } else if (this.inlineHostMode === 'leave') {
      const leaveType = document.getElementById('inlineHostLeaveTypeSelect').value;
      payload.isLeave = true;
      payload.leaveType = leaveType;
    } else {
      const branchId = document.getElementById('inlineHostBranchSelect').value;
      if (branchId === 'none' || branchId === 'clear') {
        if (!isHalfDay && !note) {
          payload.isClear = true;
        } else {
          payload.isLeave = false;
          payload.branchId = null;
          payload.branchName = null;
        }
      } else {
        const branchObj = this.branches.find(b => b.id === branchId);
        payload.isLeave = false;
        payload.branchId = branchId;
        payload.branchName = branchObj ? branchObj.name : 'สำนักงานใหญ่';
      }
    }

    try {
      const res = await fetch('/api/host/duty', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถบันทึกได้');

      this.showToast('success', data.message);

      // แจ้งเตือนข้อความใน LINE ผ่าน LIFF
      if (payload.isLeave) {
        const hostName = (this.settings && this.settings.hostName) || this.currentUser.name || 'Host';
        let msg = `🏖️ แจ้งสถานะการลา / ภารกิจ\nหัวข้อ: ${payload.leaveType || 'ลาอื่นๆ'}\nวันที่: ${this.selectedDate}\nผู้แจ้ง: ${hostName}`;
        if (payload.note) msg += `\nหมายเหตุ: ${payload.note}`;
        await this.sendLineNotification(msg);
      } else if (payload.isHalfDay) {
        const hostName = (this.settings && this.settings.hostName) || this.currentUser.name || 'Host';
        let msg = `⏰ แจ้งเวลาปฏิบัติงาน (ทำงานครึ่งวัน 08:00 - 12:00 น.)\nวันที่: ${this.selectedDate}\nผู้แจ้ง: ${hostName}`;
        if (payload.branchName) msg += `\nสถานที่: ${payload.branchName}`;
        if (payload.note) msg += `\nหมายเหตุ: ${payload.note}`;
        await this.sendLineNotification(msg);
      } else if (payload.branchName) {
        const hostName = (this.settings && this.settings.hostName) || this.currentUser.name || 'Host';
        let msg = `📍 แจ้งสถานที่ปฏิบัติงาน\nสถานที่: ${payload.branchName}\nวันที่: ${this.selectedDate}\nผู้แจ้ง: ${hostName}`;
        if (payload.note) msg += `\nหมายเหตุ: ${payload.note}`;
        await this.sendLineNotification(msg);
      }

      await this.openDayModal(this.selectedDate);
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async clearInlineHostDuty() {
    if (!this.selectedDate) return;
    try {
      const res = await fetch('/api/host/duty', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({
          date: this.selectedDate,
          isClear: true
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถล้างสถานะได้');

      this.showToast('success', data.message || 'รีเซ็ตสถานะเป็นวันว่างปกติเรียบร้อยแล้ว');
      await this.openDayModal(this.selectedDate);
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async saveInlineHostBlock() {
    if (!this.selectedDate) return;
    const startTime = document.getElementById('inlineBlockStartTime').value;
    const endTime = document.getElementById('inlineBlockEndTime').value;
    const reason = document.getElementById('inlineBlockReason').value.trim();

    if (!startTime || !endTime) {
      this.showToast('error', 'กรุณาระบุเวลาเริ่มต้นและสิ้นสุด');
      return;
    }

    try {
      const res = await fetch('/api/host/block-slot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({
          date: this.selectedDate,
          isFullDay: false,
          startTime,
          endTime,
          reason: reason || 'Host ติดภารกิจ'
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถบล็อกช่วงเวลาได้');

      this.showToast('success', data.message);
      await this.openDayModal(this.selectedDate);
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async saveInlineLeaderDuty() {
    if (!this.selectedDate) return;
    const leaderId = document.getElementById('inlineLeaderSelect').value;
    const note = document.getElementById('inlineLeaderNoteInput').value.trim();

    if (!leaderId) {
      this.showToast('error', 'กรุณาเลือกหัวหน้าทีม');
      return;
    }

    let payload = { leaderId, date: this.selectedDate, note };

    if (this.inlineLeaderMode === 'leave') {
      payload.isLeave = true;
      payload.leaveType = document.getElementById('inlineLeaderLeaveTypeSelect').value;
    } else {
      const branchId = document.getElementById('inlineLeaderBranchSelect').value;
      if (branchId === 'none' || branchId === 'clear') {
        if (!note) {
          payload.isClear = true;
        } else {
          payload.isLeave = false;
          payload.branchId = null;
          payload.branchName = null;
        }
      } else {
        const bObj = this.branches.find(b => b.id === branchId);
        payload.isLeave = false;
        payload.branchId = branchId;
        payload.branchName = bObj ? bObj.name : 'สำนักงานใหญ่';
      }
    }

    try {
      const res = await fetch('/api/team-duty', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      this.showToast('success', data.message);

      // แจ้งเตือนข้อความใน LINE ผ่าน LIFF
      const leaderObj = this.teamLeaders.find(l => l.id === leaderId);
      const leaderName = leaderObj ? leaderObj.name : (this.currentUser.name || 'หัวหน้าทีม');
      if (payload.isLeave) {
        let msg = `🏖️ แจ้งสถานะการลา / ภารกิจ\nหัวข้อ: ${payload.leaveType || 'ลาอื่นๆ'}\nวันที่: ${this.selectedDate}\nผู้แจ้ง: ${leaderName}`;
        if (payload.note) msg += `\nหมายเหตุ: ${payload.note}`;
        await this.sendLineNotification(msg);
      } else if (payload.branchName) {
        let msg = `📍 แจ้งสถานที่ปฏิบัติงาน\nหัวหน้าทีม: ${leaderName}\nสถานที่: ${payload.branchName}\nวันที่: ${this.selectedDate}`;
        if (payload.note) msg += `\nหมายเหตุ: ${payload.note}`;
        await this.sendLineNotification(msg);
      }

      await this.openDayModal(this.selectedDate);
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async clearInlineLeaderDuty() {
    if (!this.selectedDate) return;
    const leaderId = document.getElementById('inlineLeaderSelect').value;
    if (!leaderId) {
      this.showToast('error', 'กรุณาเลือกหัวหน้าทีม');
      return;
    }

    try {
      const res = await fetch('/api/team-duty', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({
          leaderId,
          date: this.selectedDate,
          isClear: true
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถล้างสถานะได้');

      this.showToast('success', data.message || 'รีเซ็ตสถานะเป็นวันว่างปกติเรียบร้อยแล้ว');
      await this.openDayModal(this.selectedDate);
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  renderSlots(slots, isHost) {
    const slotsList = document.getElementById('modalSlotsList');
    slotsList.innerHTML = '';

    if (!slots || slots.length === 0) {
      slotsList.innerHTML = '<div class="py-6 text-center text-slate-400 text-xs">ไม่มีรอบเวลาสำหรับวันนี้</div>';
      return;
    }

    const effectiveIsHost = !!(isHost || (this.currentUser && this.currentUser.role === 'host'));
    const isLeader = !!(this.currentUser && this.currentUser.role === 'team_leader');

    // 1. Group contiguous slots belonging to the same booking or the same host block
    const displaySlots = [];
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot.state === 'booked' && slot.booking && slot.booking.id) {
        const lastGroup = displaySlots[displaySlots.length - 1];
        if (lastGroup && lastGroup.state === 'booked' && lastGroup.booking && lastGroup.booking.id === slot.booking.id) {
          lastGroup.endTime = slot.endTime;
          lastGroup.label = `${lastGroup.startTime} - ${slot.endTime}`;
          lastGroup.coveredSlots = (lastGroup.coveredSlots || 1) + 1;
          continue;
        }
        displaySlots.push({
          ...slot,
          coveredSlots: 1
        });
      } else if (slot.state === 'blocked' && slot.blockId) {
        const lastGroup = displaySlots[displaySlots.length - 1];
        if (lastGroup && lastGroup.state === 'blocked' && lastGroup.blockId === slot.blockId) {
          lastGroup.endTime = slot.endTime;
          lastGroup.label = `${lastGroup.startTime} - ${slot.endTime}`;
          lastGroup.coveredSlots = (lastGroup.coveredSlots || 1) + 1;
          continue;
        }
        displaySlots.push({
          ...slot,
          coveredSlots: 1
        });
      } else {
        displaySlots.push({
          ...slot,
          coveredSlots: 1
        });
      }
    }

    displaySlots.forEach(slot => {
      const slotCard = document.createElement('div');
      slotCard.className = 'p-3 rounded-xl border transition flex flex-col sm:flex-row sm:items-center justify-between gap-2';

      if (slot.state === 'available') {
        slotCard.classList.add('bg-white', 'border-emerald-200', 'hover:border-emerald-500', 'hover:bg-emerald-50/40');
        slotCard.innerHTML = `
          <div class="flex items-center space-x-2.5">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
            <div>
              <span class="font-bold text-xs sm:text-sm text-slate-800">${slot.label}</span>
              <span class="ml-2 text-[11px] font-semibold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-md">ว่าง</span>
            </div>
          </div>
          <div class="flex items-center space-x-2 self-end sm:self-center">
            ${effectiveIsHost ? `
              <button onclick="app.quickBlockSlot('${slot.startTime}', '${slot.endTime}')" class="px-2.5 py-1.5 bg-slate-100 hover:bg-rose-50 text-slate-600 hover:text-rose-600 border border-slate-200 hover:border-rose-300 text-xs font-semibold rounded-lg transition flex items-center space-x-1" title="บล็อกช่วงเวลานี้">
                <i data-lucide="slash" class="w-3 h-3 text-rose-500"></i>
                <span>บล็อกรอบนี้</span>
              </button>
            ` : ''}
            <button onclick="app.selectSlot('${slot.startTime}', '${slot.endTime}')" class="px-3.5 py-1.5 btn-line text-xs font-bold rounded-lg shadow-xs">
              ลงคิวรอบนี้
            </button>
          </div>
        `;
      } else if (slot.state === 'booked') {
        const b = slot.booking || {};
        const isMine = !!b.isMine;
        const isInterview = !!(b.isInterview || (b.eventType && b.eventType.includes('สัมภาษณ์')));
        const isCompanyMeeting = !!(b.isCompanyMeeting || (b.eventType && b.eventType.includes('ประชุมบริษัท')));
        const canViewDetails = isMine || effectiveIsHost || isLeader;
        const coveredBadgeHtml = (slot.coveredSlots > 1) ? `<span class="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.2 rounded-md">${slot.coveredSlots} ช่วงเวลาต่อเนื่อง (${slot.startTime} - ${slot.endTime} น.)</span>` : '';
        const branchDisplay = b.meetingType === 'online' ? '💻 ออนไลน์' : '🏢 ' + (b.branchName || 'ที่สาขา') + (b.branchAddress ? ` (${b.branchAddress})` : '');

        // Cancel / Trim Buttons HTML
        const actionBtnHtml = (isMine || effectiveIsHost) ? (
          (slot.coveredSlots > 1) ? `
            <div class="flex items-center space-x-1.5 self-end sm:self-center shrink-0">
              <button onclick="app.openTrimModal('${b.id}', '${slot.startTime}', '${slot.endTime}', ${slot.coveredSlots})" class="px-2 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 text-[11px] font-bold rounded-lg transition" title="ปรับลดช่วงเวลาที่จองลง">
                ✂️ ปรับลดเวลา
              </button>
              <button onclick="app.cancelBooking('${b.id}', '${slot.startTime}', '${slot.endTime}', ${slot.coveredSlots})" class="px-2.5 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-[11px] font-bold rounded-lg transition">
                ${effectiveIsHost && !isMine ? 'ยกเลิกทั้งคิว (Host)' : 'ยกเลิกทั้งคิว'}
              </button>
            </div>
          ` : `
            <button onclick="app.cancelBooking('${b.id}', '${slot.startTime}', '${slot.endTime}', 1)" class="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-semibold rounded-lg transition self-end sm:self-center shrink-0">
              ${effectiveIsHost && !isMine ? 'ยกเลิก (Host)' : 'ยกเลิกคิวนี้'}
            </button>
          `
        ) : `
          <span class="text-[11px] font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-lg self-end sm:self-center shrink-0">
            จองแล้ว
          </span>
        `;

        if (isMine) {
          slotCard.classList.add(isInterview ? 'bg-purple-50/90' : isCompanyMeeting ? 'bg-blue-50/90' : 'bg-amber-50/80', isInterview ? 'border-purple-300' : isCompanyMeeting ? 'border-blue-300' : 'border-amber-300');
          const myBadgeText = isInterview ? '💼 สัมภาษณ์งาน (คิวของคุณ) ⭐' : isCompanyMeeting ? '📢 ประชุมบริษัท (คิวของคุณ) ⭐' : 'คิวของคุณ ⭐';
          const myBadgeColor = isInterview ? 'text-purple-700 bg-purple-100' : isCompanyMeeting ? 'text-blue-700 bg-blue-100' : 'text-amber-700 bg-amber-100';
          const myDotColor = isInterview ? 'bg-purple-500' : isCompanyMeeting ? 'bg-blue-500' : 'bg-amber-500';

          slotCard.innerHTML = `
            <div class="flex items-center space-x-2.5">
              <span class="w-2.5 h-2.5 rounded-full ${myDotColor} shrink-0"></span>
              <div>
                <div class="flex items-center space-x-1.5 flex-wrap">
                  <span class="font-bold text-xs sm:text-sm text-slate-800">${slot.label}</span>
                  <span class="text-[10px] font-bold ${myBadgeColor} px-1.5 py-0.2 rounded-md">${myBadgeText}</span>
                  ${coveredBadgeHtml}
                  <span class="text-[10px] font-medium text-slate-500 bg-white border border-slate-200 px-1.5 py-0.2 rounded-md">${branchDisplay}</span>
                </div>
                <div class="text-xs font-bold text-slate-700 mt-0.5">📌 ${b.eventTitle || 'หัวข้อการประชุม'} <span class="font-normal text-slate-500">(${b.eventType || 'ทั่วไป'})</span></div>
                ${b.notes && b.notes !== 'รายละเอียดการประชุม' ? `<div class="text-[11px] text-slate-500 mt-0.5 italic">"${b.notes}"</div>` : ''}
              </div>
            </div>
            ${actionBtnHtml}
          `;
        } else if (isInterview && canViewDetails) {
          // Interview viewed by Host or Team Leader
          slotCard.classList.add('bg-purple-50/80', 'border-purple-200');
          slotCard.innerHTML = `
            <div class="flex items-center space-x-2.5">
              <img src="${b.employeePicture || 'https://api.dicebear.com/7.x/bottts/svg?seed=' + encodeURIComponent(b.employeeName || 'User')}" class="w-8 h-8 rounded-full bg-purple-100 border-2 border-white shadow-xs shrink-0 object-cover">
              <div>
                <div class="flex items-center space-x-1.5 flex-wrap">
                  <span class="font-bold text-xs sm:text-sm text-slate-800">${slot.label}</span>
                  <span class="text-[10px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.2 rounded-md">🎯 💼 สัมภาษณ์งาน (กรรมการ)</span>
                  ${coveredBadgeHtml}
                  <span class="text-[10px] font-medium text-slate-500 bg-white border border-slate-200 px-1.5 py-0.2 rounded-md">${branchDisplay}</span>
                </div>
                <div class="text-xs font-bold text-slate-800 mt-0.5">
                  <span>${b.employeeName}</span>
                  <span class="font-medium text-slate-600 ml-1.5">📌 ${b.eventTitle || 'นัดสัมภาษณ์งาน'} <span class="text-[11px] text-purple-600 font-normal">(${b.eventType || 'สัมภาษณ์งาน'})</span></span>
                </div>
                ${b.notes && b.notes !== 'รายละเอียดการประชุม' ? `<div class="text-[11px] text-slate-600 mt-0.5 italic">"${b.notes}"</div>` : ''}
              </div>
            </div>
            ${effectiveIsHost ? actionBtnHtml : `
              <span class="text-[11px] font-medium text-purple-700 bg-purple-100/80 px-2.5 py-1 rounded-lg self-end sm:self-center shrink-0">
                👁️ กรรมการร่วม
              </span>
            `}
          `;
        } else if (isCompanyMeeting && canViewDetails) {
          // Company Meeting viewed by Host or Team Leader
          slotCard.classList.add('bg-blue-50/80', 'border-blue-200');
          slotCard.innerHTML = `
            <div class="flex items-center space-x-2.5">
              <div class="w-8 h-8 rounded-full bg-blue-100 border-2 border-white shadow-xs shrink-0 flex items-center justify-center text-blue-600 text-sm font-bold">
                📢
              </div>
              <div>
                <div class="flex items-center space-x-1.5 flex-wrap">
                  <span class="font-bold text-xs sm:text-sm text-slate-800">${slot.label}</span>
                  <span class="text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.2 rounded-md">📢 ประชุมบริษัท (Host/หัวหน้าทีม)</span>
                  ${coveredBadgeHtml}
                  <span class="text-[10px] font-medium text-slate-500 bg-white border border-slate-200 px-1.5 py-0.2 rounded-md">${branchDisplay}</span>
                </div>
                <div class="text-xs font-bold text-slate-800 mt-0.5">
                  <span class="text-blue-900">📌 ${b.eventTitle || 'การประชุมบริษัท'}</span>
                  <span class="text-slate-500 font-normal ml-1 text-[11px]">(ผู้ลงคิว: ${b.employeeName})</span>
                </div>
                ${b.notes && b.notes !== 'รายละเอียดการประชุม' ? `<div class="text-[11px] text-slate-600 mt-0.5 italic">"${b.notes}"</div>` : ''}
              </div>
            </div>
            ${effectiveIsHost ? actionBtnHtml : `
              <span class="text-[11px] font-medium text-blue-700 bg-blue-100/80 px-2.5 py-1 rounded-lg self-end sm:self-center shrink-0">
                👁️ เข้าร่วมประชุม
              </span>
            `}
          `;
        } else if (isCompanyMeeting && !canViewDetails) {
          // Company Meeting viewed by general user (MASKED)
          slotCard.classList.add('bg-slate-50/90', 'border-slate-200');
          slotCard.innerHTML = `
            <div class="flex items-center space-x-2.5">
              <div class="w-8 h-8 rounded-full bg-blue-50 border-2 border-white shadow-xs shrink-0 flex items-center justify-center text-blue-600 text-sm font-bold">
                📢
              </div>
              <div>
                <div class="flex items-center space-x-1.5 flex-wrap">
                  <span class="font-bold text-xs sm:text-sm text-slate-700">${slot.label}</span>
                  <span class="text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.2 rounded-md">📢 ประชุมบริษัท</span>
                  ${coveredBadgeHtml}
                  <span class="text-[10px] font-medium text-slate-500 bg-white border border-slate-200 px-1.5 py-0.2 rounded-md">${branchDisplay}</span>
                </div>
                <div class="text-xs font-bold text-slate-700 mt-0.5">
                  <span>📌 การประชุมบริษัท</span>
                  <span class="text-[11px] text-slate-400 font-normal ml-1">(ช่วงเวลานี้มีประชุมบริษัท)</span>
                </div>
                <div class="text-[10px] text-slate-400 mt-0.5 italic">📢 มีการประชุมบริษัทในช่วงเวลานี้ (ปิดรับคิว)</div>
              </div>
            </div>
            <span class="text-[11px] font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-lg self-end sm:self-center shrink-0">
              จองแล้ว
            </span>
          `;
        } else if (isInterview && !canViewDetails) {
          // Interview viewed by general colleague (PRIVACY PROTECTED)
          slotCard.classList.add('bg-slate-50/90', 'border-slate-200');
          slotCard.innerHTML = `
            <div class="flex items-center space-x-2.5">
              <div class="w-8 h-8 rounded-full bg-purple-100 border-2 border-white shadow-xs shrink-0 flex items-center justify-center text-purple-600 text-sm font-bold">
                💼
              </div>
              <div>
                <div class="flex items-center space-x-1.5 flex-wrap">
                  <span class="font-bold text-xs sm:text-sm text-slate-700">${slot.label}</span>
                  <span class="text-[10px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.2 rounded-md">🔒 💼 สัมภาษณ์งาน</span>
                  ${coveredBadgeHtml}
                  <span class="text-[10px] font-medium text-slate-500 bg-white border border-slate-200 px-1.5 py-0.2 rounded-md">${branchDisplay}</span>
                </div>
                <div class="text-xs font-bold text-slate-600 mt-0.5">
                  <span class="text-slate-400 font-normal">[สงวนสิทธิ์ข้อมูลผู้สมัครงาน]</span>
                  <span class="font-medium text-slate-500 ml-1.5">📌 สัมภาษณ์งาน <span class="text-[11px] text-slate-400 font-normal">(สงวนสิทธิ์ข้อมูล)</span></span>
                </div>
                <div class="text-[10px] text-slate-400 mt-0.5 italic">🔒 สงวนสิทธิ์ข้อมูลเฉพาะกรรมการสัมภาษณ์ (Host & หัวหน้าทีม)</div>
              </div>
            </div>
            <span class="text-[11px] font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-lg self-end sm:self-center shrink-0">
              จองแล้ว
            </span>
          `;
        } else {
          // Booked by other colleague / employee
          slotCard.classList.add('bg-slate-50/90', 'border-slate-200');
          slotCard.innerHTML = `
            <div class="flex items-center space-x-2.5">
              <img src="${b.employeePicture || 'https://api.dicebear.com/7.x/bottts/svg?seed=' + encodeURIComponent(b.employeeName || 'User')}" class="w-8 h-8 rounded-full bg-slate-200 border-2 border-white shadow-xs shrink-0 object-cover">
              <div>
                <div class="flex items-center space-x-1.5 flex-wrap">
                  <span class="font-bold text-xs sm:text-sm text-slate-700">${slot.label}</span>
                  <span class="text-[10px] font-bold text-teal-700 bg-teal-100 px-1.5 py-0.2 rounded-md">👥 คิวเพื่อนร่วมงาน</span>
                  ${coveredBadgeHtml}
                  <span class="text-[10px] font-medium text-slate-500 bg-white border border-slate-200 px-1.5 py-0.2 rounded-md">${branchDisplay}</span>
                </div>
                <div class="text-xs font-bold text-slate-800 mt-0.5">
                  <span>${b.employeeName || 'เพื่อนร่วมงาน'}</span>
                  <span class="font-medium text-slate-600 ml-1.5">📌 ${b.eventTitle || 'นัดหมาย'} <span class="text-[11px] text-slate-500 font-normal">(${b.eventType || 'ทั่วไป'})</span></span>
                </div>
                ${b.notes && b.notes !== 'รายละเอียดการประชุม' ? `<div class="text-[11px] text-slate-500 mt-0.5 italic">"${b.notes}"</div>` : ''}
              </div>
            </div>
            ${actionBtnHtml}
          `;
        }
      } else if (slot.state === 'blocked') {
        // Blocked by Host
        slotCard.classList.add('bg-slate-100', 'border-slate-300');
        slotCard.innerHTML = `
          <div class="flex items-center space-x-2.5">
            <span class="w-2.5 h-2.5 rounded-full bg-slate-400"></span>
            <div>
              <span class="font-bold text-xs sm:text-sm text-slate-600">${slot.label}</span>
              <span class="ml-2 text-[10px] font-medium text-slate-500 bg-slate-200 px-1.5 py-0.2 rounded-md">Host ติดภารกิจ</span>
              <div class="text-[11px] text-slate-500 mt-0.5">⛔ ${slot.reason}</div>
            </div>
          </div>
          ${effectiveIsHost && slot.blockId ? `
            <button onclick="app.unblockSlot('${slot.blockId}')" class="px-2.5 py-1 bg-white hover:bg-emerald-50 text-slate-700 hover:text-emerald-700 border border-slate-300 hover:border-emerald-300 text-[11px] font-semibold rounded-lg transition self-end sm:self-center flex items-center space-x-1">
              <i data-lucide="unlock" class="w-3 h-3 text-emerald-600"></i>
              <span>ยกเลิกบล็อก (เปิดรับคิว)</span>
            </button>
          ` : `
            <span class="text-[11px] text-slate-400 self-end sm:self-center">งดรับคิว</span>
          `}
        `;
      }

      slotsList.appendChild(slotCard);
    });
    lucide.createIcons();
  }

  async quickBlockSlot(startTime, endTime) {
    if (!this.selectedDate) return;
    const reason = prompt(`ระบุเหตุผลที่ไม่ว่างสำหรับรอบ ${startTime} - ${endTime} (หรือเว้นว่างไว้เพื่อใช้ค่าเริ่มต้น):`, 'Host ติดภารกิจ');
    if (reason === null) return; // User cancelled

    try {
      const res = await fetch('/api/host/block-slot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({
          date: this.selectedDate,
          isFullDay: false,
          startTime,
          endTime,
          reason: reason.trim() || 'Host ติดภารกิจ'
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถบล็อกช่วงเวลาได้');

      this.showToast('success', `บล็อกช่วงเวลา ${startTime} - ${endTime} เรียบร้อยแล้ว`);
      await this.openDayModal(this.selectedDate);
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  selectSlot(startTime, endTime) {
    this.selectedSlot = { startTime, endTime };
    const formContainer = document.getElementById('bookingFormContainer');
    const badge = document.getElementById('selectedSlotBadge');
    badge.textContent = `${startTime} - ${endTime}`;
    formContainer.classList.remove('hidden');

    const multiSlotSection = document.getElementById('bookingMultiSlotSection');
    const startTimeDisplay = document.getElementById('bookingStartTimeDisplay');
    const endTimeSelect = document.getElementById('bookingEndTimeSelect');

    // Calculate slot interval in minutes (e.g. 30 or 60)
    const startMin = this.timeToMinutes(startTime);
    const endMin = this.timeToMinutes(endTime);
    const stepMin = Math.max(15, endMin - startMin);
    this.selectedSlotDurationMinutes = stepMin;

    if (multiSlotSection && endTimeSelect) {
      multiSlotSection.classList.remove('hidden');
      if (startTimeDisplay) startTimeDisplay.value = startTime;

      // Populate valid subsequent end times using stepMin
      endTimeSelect.innerHTML = '';

      // Determine max end time of day from currentDayData or fallback to 17:00
      let maxEndMin = 17 * 60;
      if (this.currentDayData && Array.isArray(this.currentDayData.slots) && this.currentDayData.slots.length > 0) {
        const lastSlot = this.currentDayData.slots[this.currentDayData.slots.length - 1];
        maxEndMin = this.timeToMinutes(lastSlot.endTime);
      }

      // Find if there is any booked or blocked slot starting after this slot to prevent overlapping
      let limitEndMin = maxEndMin;
      if (this.currentDayData && Array.isArray(this.currentDayData.slots)) {
        for (const s of this.currentDayData.slots) {
          const sStart = this.timeToMinutes(s.startTime);
          if (sStart >= endMin && (s.state === 'booked' || s.state === 'blocked')) {
            limitEndMin = sStart;
            break;
          }
        }
      }

      for (let curEnd = endMin; curEnd <= limitEndMin; curEnd += stepMin) {
        const timeStr = this.minutesToTime(curEnd);
        const durationMin = curEnd - startMin;
        const numSlots = Math.round(durationMin / stepMin);

        let durationLabel = '';
        if (durationMin < 60) {
          durationLabel = `${durationMin} นาที`;
        } else if (durationMin % 60 === 0) {
          durationLabel = `${durationMin / 60} ชั่วโมง`;
        } else {
          durationLabel = `${Math.floor(durationMin / 60)} ชม. ${durationMin % 60} นาที`;
        }

        const opt = document.createElement('option');
        opt.value = timeStr;
        opt.textContent = `${timeStr} (${durationLabel}${numSlots > 1 ? ` / ${numSlots} ช่วงเวลา` : ''})`;
        endTimeSelect.appendChild(opt);
      }

      // If limit prevented any option, at least add current slot endTime
      if (endTimeSelect.options.length === 0) {
        const opt = document.createElement('option');
        opt.value = endTime;
        opt.textContent = `${endTime} (${stepMin} นาที)`;
        endTimeSelect.appendChild(opt);
      }

      endTimeSelect.value = endTime;
      this.onBookingEndTimeChange();
    } else if (multiSlotSection) {
      multiSlotSection.classList.add('hidden');
    }

    // Auto focus on event title
    const input = document.getElementById('bookingEventTitle');
    input.focus();
    formContainer.scrollIntoView({ behavior: 'smooth' });
    lucide.createIcons();
  }

  onBookingEndTimeChange() {
    if (!this.selectedSlot) return;
    const endTimeSelect = document.getElementById('bookingEndTimeSelect');
    const durationBadge = document.getElementById('bookingDurationBadge');
    const badge = document.getElementById('selectedSlotBadge');
    if (!endTimeSelect || !endTimeSelect.value) return;

    const startMin = this.timeToMinutes(this.selectedSlot.startTime);
    const endMin = this.timeToMinutes(endTimeSelect.value);
    const diffMin = Math.max(15, endMin - startMin);

    const stepMin = this.selectedSlotDurationMinutes || (endMin - startMin) || 30;
    const numSlots = Math.max(1, Math.round(diffMin / stepMin));

    let durationText = '';
    if (diffMin < 60) {
      durationText = `${diffMin} นาที (${numSlots} ช่วงเวลา)`;
    } else if (diffMin % 60 === 0) {
      durationText = `${diffMin / 60} ชั่วโมง (${numSlots} ช่วงเวลา)`;
    } else {
      const h = Math.floor(diffMin / 60);
      const m = diffMin % 60;
      durationText = `${h} ชม. ${m} นาที (${numSlots} ช่วงเวลา)`;
    }

    if (durationBadge) {
      durationBadge.textContent = durationText;
    }
    if (badge) {
      badge.textContent = `${this.selectedSlot.startTime} - ${endTimeSelect.value}`;
    }
  }

  onBookingEventTypeChange() {
    const select = document.getElementById('bookingEventType');
    const multiNotice = document.getElementById('bookingMultiSlotNotice');
    if (select && select.value.includes('ประชุมบริษัท') && multiNotice) {
      multiNotice.innerHTML = '📢 <strong>การประชุมบริษัท:</strong> สามารถขยายเวลาสิ้นสุดเพื่อจองครอบคลุมทุกช่วงเวลาที่ต้องการได้ทันที';
    }
  }

  async submitBooking() {
    if (!this.selectedDate || !this.selectedSlot) {
      this.showToast('error', 'กรุณาเลือกรอบเวลาที่ต้องการลงคิว');
      return;
    }

    const eventTitle = document.getElementById('bookingEventTitle').value.trim();
    const eventType = document.getElementById('bookingEventType').value;
    const meetingFormat = document.querySelector('input[name="meetingFormat"]:checked')?.value || 'onsite';
    const notes = document.getElementById('bookingNotes').value.trim();

    if (!eventTitle) {
      this.showToast('error', 'กรุณาระบุชื่องาน / หัวข้อการประชุม');
      document.getElementById('bookingEventTitle').focus();
      return;
    }

    let effectiveEndTime = this.selectedSlot.endTime;
    const multiSlotSection = document.getElementById('bookingMultiSlotSection');
    const endTimeSelect = document.getElementById('bookingEndTimeSelect');
    if (multiSlotSection && !multiSlotSection.classList.contains('hidden') && endTimeSelect && endTimeSelect.value) {
      effectiveEndTime = endTimeSelect.value;
    }

    const payload = {
      date: this.selectedDate,
      startTime: this.selectedSlot.startTime,
      endTime: effectiveEndTime,
      eventTitle,
      eventType,
      employeeName: this.currentUser.name,
      employeeUserId: this.currentUser.id,
      employeePicture: this.currentUser.picture,
      meetingType: meetingFormat,
      notes
    };

    const submitBtn = document.getElementById('submitBookingBtn');
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>กำลังบันทึกคิว...</span>';

    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'ไม่สามารถลงคิวได้');
      }

      this.showToast('success', '🎉 ลงคิว Meeting สำเร็จเรียบร้อยแล้ว!');

      // Send LINE message via LIFF if inside LINE app
      const locText = meetingFormat === 'online' ? '💻 คุยออนไลน์' : `🏢 ${(data.booking && data.booking.branchName) ? data.booking.branchName + (data.booking.branchAddress ? ' (' + data.booking.branchAddress + ')' : '') : 'ที่สาขา'}`;
      await this.sendLineNotification(`📅 ลงคิว Meeting สำเร็จ!\nหัวข้อ: ${eventTitle}\nวันที่: ${this.selectedDate}\nเวลา: ${this.selectedSlot.startTime} - ${effectiveEndTime} น.\nสถานที่: ${locText}\nผู้ลงคิว: ${this.currentUser.name}`);

      // Reset form
      document.getElementById('bookingEventTitle').value = '';
      document.getElementById('bookingNotes').value = '';

      // Reload
      await this.openDayModal(this.selectedDate);
      await this.loadMonthCalendar();
      this.loadMyBookings();
    } catch (err) {
      this.showToast('error', err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i><span>ยืนยันการลงคิว Meeting</span>';
      lucide.createIcons();
    }
  }

  // -------------------------------------------------------------
  // Cancel Booking (Strict Permission Enforcement)
  // -------------------------------------------------------------
  async cancelBooking(bookingId, startTime = null, endTime = null, coveredSlots = 1) {
    let confirmMsg = 'คุณต้องการยกเลิกคิวการประชุมนี้ใช่หรือไม่?';
    if (startTime && endTime && coveredSlots > 1) {
      confirmMsg = `คิวนี้เป็นการจองครอบคลุม ${startTime} - ${endTime} น. (${coveredSlots} ช่วงเวลา)\n\nคุณต้องการยกเลิกคิวการประชุมนี้ทั้งหมดใช่หรือไม่?`;
    }
    if (!confirm(confirmMsg)) {
      return;
    }

    try {
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: 'DELETE',
        headers: {
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        }
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'ไม่สามารถยกเลิกคิวได้');
      }

      this.showToast('info', 'ยกเลิกคิวเรียบร้อยแล้ว');
      if (this.selectedDate) {
        await this.openDayModal(this.selectedDate);
      }
      await this.loadMonthCalendar();
      this.loadMyBookings();
      this.loadHostBookings();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  // -------------------------------------------------------------
  // Multi-Slot Trim Modal (Interactive Slot Selection)
  // -------------------------------------------------------------
  openTrimModal(bookingId, startTime, endTime, coveredSlots) {
    if (!bookingId) return;

    // Find all sub-slots for this booking from currentDayData
    let bookingSlots = [];
    let bTitle = '';
    let bDate = this.selectedDate || '';

    if (this.currentDayData && Array.isArray(this.currentDayData.slots)) {
      this.currentDayData.slots.forEach(s => {
        if (s.state === 'booked' && s.booking && s.booking.id === bookingId) {
          bookingSlots.push({
            startTime: s.startTime,
            endTime: s.endTime,
            label: `${s.startTime} - ${s.endTime} น.`
          });
          if (!bTitle && s.booking.eventTitle) bTitle = s.booking.eventTitle;
        }
      });
    }

    // Fallback if not found in currentDayData
    if (bookingSlots.length === 0) {
      const startMin = this.timeToMinutes(startTime);
      const endMin = this.timeToMinutes(endTime);
      const stepMin = this.selectedSlotDurationMinutes || Math.round((endMin - startMin) / (coveredSlots || 2)) || 30;
      for (let m = startMin; m < endMin; m += stepMin) {
        const s1 = this.minutesToTime(m);
        const s2 = this.minutesToTime(Math.min(m + stepMin, endMin));
        bookingSlots.push({
          startTime: s1,
          endTime: s2,
          label: `${s1} - ${s2} น.`
        });
      }
    }

    this.trimModalState = {
      bookingId,
      eventTitle: bTitle || 'การประชุม',
      date: bDate,
      originalStartTime: startTime,
      originalEndTime: endTime,
      slots: bookingSlots.map((s, idx) => ({
        id: idx,
        startTime: s.startTime,
        endTime: s.endTime,
        label: s.label,
        keep: true
      }))
    };

    // Populate modal elements
    const titleEl = document.getElementById('trimModalTitle');
    const dateEl = document.getElementById('trimModalDate');
    const rangeEl = document.getElementById('trimModalOriginalRange');

    if (titleEl) titleEl.innerHTML = `📌 <strong class="text-slate-800">${this.trimModalState.eventTitle}</strong>`;
    if (dateEl) dateEl.textContent = this.formatThaiDate(this.trimModalState.date);
    if (rangeEl) rangeEl.textContent = `${startTime} - ${endTime} น. (${this.trimModalState.slots.length} ช่วงเวลา)`;

    this.renderTrimModalSlots();

    const modal = document.getElementById('trimBookingModal');
    if (modal) modal.classList.remove('hidden');
    lucide.createIcons();
  }

  closeTrimModal() {
    const modal = document.getElementById('trimBookingModal');
    if (modal) modal.classList.add('hidden');
    this.trimModalState = null;
  }

  toggleTrimSlot(slotId) {
    if (!this.trimModalState || !this.trimModalState.slots) return;
    const target = this.trimModalState.slots.find(s => s.id === slotId);
    if (target) {
      target.keep = !target.keep;
      this.renderTrimModalSlots();
    }
  }

  renderTrimModalSlots() {
    if (!this.trimModalState) return;
    const listEl = document.getElementById('trimModalSlotsList');
    if (!listEl) return;
    listEl.innerHTML = '';

    this.trimModalState.slots.forEach(s => {
      const card = document.createElement('div');
      card.className = `p-3 rounded-2xl border transition flex items-center justify-between gap-3 ${
        s.keep 
          ? 'bg-white border-slate-200 hover:border-slate-300 shadow-2xs' 
          : 'bg-rose-50/70 border-rose-200 opacity-80'
      }`;

      card.innerHTML = `
        <div class="flex items-center space-x-3 cursor-pointer select-none grow" onclick="app.toggleTrimSlot(${s.id})">
          <input type="checkbox" ${s.keep ? 'checked' : ''} onclick="event.stopPropagation(); app.toggleTrimSlot(${s.id})" class="w-4 h-4 text-emerald-600 rounded focus:ring-emerald-500 cursor-pointer">
          <div>
            <div class="flex items-center space-x-2">
              <span class="text-xs font-bold ${s.keep ? 'text-slate-800' : 'text-rose-600 line-through'}">${s.label}</span>
              <span class="text-[10px] font-bold px-2 py-0.5 rounded-md ${
                s.keep 
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                  : 'bg-rose-100 text-rose-700 border border-rose-200'
              }">
                ${s.keep ? '✅ คงไว้' : '🗑️ จะถูกลบ'}
              </span>
            </div>
          </div>
        </div>
        <button type="button" onclick="app.toggleTrimSlot(${s.id})" class="px-3 py-1.5 text-xs font-bold rounded-xl transition shrink-0 ${
          s.keep 
            ? 'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200' 
            : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200'
        }">
          ${s.keep ? '🗑️ ลบช่วงนี้' : '↩️ กู้คืน'}
        </button>
      `;

      listEl.appendChild(card);
    });

    this.updateTrimModalSummary();
  }

  calculateKeptRanges(keptSlots) {
    if (!keptSlots || keptSlots.length === 0) return [];
    const sorted = [...keptSlots].sort((a, b) => a.startTime.localeCompare(b.startTime));
    const ranges = [];
    for (const s of sorted) {
      const last = ranges[ranges.length - 1];
      if (last && last.endTime === s.startTime) {
        last.endTime = s.endTime;
      } else {
        ranges.push({ startTime: s.startTime, endTime: s.endTime });
      }
    }
    return ranges;
  }

  updateTrimModalSummary() {
    if (!this.trimModalState) return;
    const keptSlots = this.trimModalState.slots.filter(s => s.keep);
    const summaryEl = document.getElementById('trimModalSummary');
    const confirmBtn = document.getElementById('trimModalConfirmBtn');
    if (!summaryEl || !confirmBtn) return;

    if (keptSlots.length === 0) {
      summaryEl.innerHTML = '<span class="text-rose-600 font-bold">⚠️ ยกเลิกคิวทั้งหมด (ลบทุกช่วงเวลา)</span>';
      confirmBtn.className = 'w-full py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl text-xs shadow-xs transition flex items-center justify-center space-x-1.5';
      confirmBtn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i><span>ยืนยันยกเลิกคิวทั้งหมด</span>';
    } else if (keptSlots.length === this.trimModalState.slots.length) {
      summaryEl.innerHTML = '<span class="text-slate-500 font-medium">ยังไม่ได้นำช่วงเวลาใดออก</span>';
      confirmBtn.className = 'w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs transition flex items-center justify-center space-x-1.5';
      confirmBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i><span>คงเวลาเดิม (ปิดหน้าต่าง)</span>';
    } else {
      const ranges = this.calculateKeptRanges(keptSlots);
      const rangeLabels = ranges.map(r => `${r.startTime} - ${r.endTime} น.`).join(' และ ');
      summaryEl.innerHTML = `<strong class="text-emerald-700 text-xs">${rangeLabels}</strong> <span class="text-slate-500 font-normal">(${keptSlots.length} ช่วงเวลา)</span>`;
      confirmBtn.className = 'w-full py-2.5 btn-line font-bold rounded-xl text-xs shadow-xs transition flex items-center justify-center space-x-1.5';
      confirmBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i><span>ยืนยันบันทึกการปรับเวลา</span>';
    }
    lucide.createIcons();
  }

  async confirmTrimBooking() {
    if (!this.trimModalState) return;
    const { bookingId } = this.trimModalState;
    const keptSlots = this.trimModalState.slots.filter(s => s.keep);

    // If all slots deleted -> Cancel entire booking
    if (keptSlots.length === 0) {
      if (!confirm('คุณได้เลือกนำทุกช่วงเวลาออก คุณต้องการยกเลิกคิวนี้ทั้งหมดใช่หรือไม่?')) {
        return;
      }
      this.closeTrimModal();
      return this.cancelBooking(bookingId);
    }

    // If unchanged
    if (keptSlots.length === this.trimModalState.slots.length) {
      this.closeTrimModal();
      return;
    }

    const ranges = this.calculateKeptRanges(keptSlots);
    const confirmBtn = document.getElementById('trimModalConfirmBtn');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<span>กำลังบันทึก...</span>';
    }

    try {
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({ ranges })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถปรับลดเวลาได้');

      const rangeLabels = ranges.map(r => `${r.startTime} - ${r.endTime} น.`).join(' และ ');
      this.showToast('success', `ปรับลดเวลาคิวเป็น ${rangeLabels} เรียบร้อยแล้ว`);
      this.closeTrimModal();

      if (this.selectedDate) {
        await this.openDayModal(this.selectedDate);
      }
      await this.loadMonthCalendar();
      this.loadMyBookings();
      this.loadHostBookings();
    } catch (err) {
      this.showToast('error', err.message);
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  // Backward compatibility alias
  promptTrimBooking(bookingId, startTime, endTime, coveredSlots) {
    this.openTrimModal(bookingId, startTime, endTime, coveredSlots);
  }

  async trimBooking(bookingId, newStartTime, newEndTime) {
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({ startTime: newStartTime, endTime: newEndTime })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถปรับลดเวลาได้');

      this.showToast('success', `ปรับลดเวลาคิวเป็น ${newStartTime} - ${newEndTime} น. เรียบร้อยแล้ว`);
      if (this.selectedDate) {
        await this.openDayModal(this.selectedDate);
      }
      await this.loadMonthCalendar();
      this.loadMyBookings();
      this.loadHostBookings();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  // -------------------------------------------------------------
  // My Bookings Tab
  // -------------------------------------------------------------
  async loadMyBookings() {
    const list = document.getElementById('myBookingsList');
    const badge = document.getElementById('myBookingsBadge');

    try {
      const res = await fetch(`/api/my-bookings?userId=${encodeURIComponent(this.currentUser.id)}`, {
        headers: { 'x-user-id': this.currentUser.id }
      });
      const data = await res.json();
      const bookings = data.bookings || [];

      badge.textContent = bookings.length;
      if (bookings.length > 0) {
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }

      if (bookings.length === 0) {
        list.innerHTML = '<div class="text-center py-10 text-slate-400 text-xs">คุณยังไม่มีคิวการประชุมที่ลงไว้</div>';
        return;
      }

      list.innerHTML = '';
      bookings.forEach(b => {
        const item = document.createElement('div');
        const isInterviewDuty = !!b.isInterviewDuty;
        const isCompanyMeetingDuty = !!b.isCompanyMeetingDuty;
        const isHost = this.currentUser.role === 'host';
        const d = new Date(b.date + 'T00:00:00');
        const thaiDateStr = `วัน${THAI_DAYS[d.getDay()]}ที่ ${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;

        const cardBg = isCompanyMeetingDuty ? 'bg-blue-50/70 border-blue-200' : isInterviewDuty ? 'bg-purple-50/70 border-purple-200' : 'bg-white border-slate-200';
        item.className = `p-4 rounded-2xl border shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${cardBg}`;
        
        const dateTagColor = isCompanyMeetingDuty ? 'bg-blue-100 text-blue-800' : isInterviewDuty ? 'bg-purple-100 text-purple-800' : 'bg-emerald-100 text-emerald-800';
        let tagHtml = `<span class="px-2.5 py-0.5 ${dateTagColor} text-[11px] font-bold rounded-lg">${thaiDateStr}</span>`;
        if (isInterviewDuty) {
          tagHtml += `<span class="text-[10px] font-bold text-purple-700 bg-purple-100 px-2 py-0.5 rounded-md">🎯 คิวร่วมสัมภาษณ์งาน (กรรมการ/Host)</span>`;
        } else if (isCompanyMeetingDuty) {
          tagHtml += `<span class="text-[10px] font-bold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-md">📢 คิวประชุมบริษัท (Host/หัวหน้าทีม)</span>`;
        }

        let actionBtnHtml = '';
        if ((isInterviewDuty || isCompanyMeetingDuty) && !isHost) {
          actionBtnHtml = `
            <div class="px-3.5 py-2 ${isCompanyMeetingDuty ? 'bg-blue-100 text-blue-700 border-blue-200' : 'bg-purple-100 text-purple-700 border-purple-200'} border text-xs font-bold rounded-xl self-end sm:self-center">
              ${isCompanyMeetingDuty ? '👁️ เข้าร่วมประชุม' : '👁️ กรรมการร่วม'}
            </div>
          `;
        } else {
          actionBtnHtml = `
            <button onclick="app.cancelBooking('${b.id}')" class="px-3.5 py-2 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold rounded-xl transition self-end sm:self-center">
              ยกเลิกคิวนี้
            </button>
          `;
        }

        item.innerHTML = `
          <div>
            <div class="flex items-center space-x-2 flex-wrap gap-y-1">
              ${tagHtml}
              <span class="text-xs font-bold text-slate-700">${b.startTime} - ${b.endTime} น.</span>
            </div>
            <h4 class="font-bold text-slate-800 text-sm mt-1.5">📌 ${b.eventTitle}</h4>
            <div class="flex flex-wrap items-center gap-2 mt-1 text-xs text-slate-500">
              <span class="bg-slate-100 px-2 py-0.5 rounded-md font-medium">${b.eventType}</span>
              ${b.employeeName && (isCompanyMeetingDuty || b.isCompanyMeeting || (b.eventType && b.eventType.includes('ประชุม'))) ? `<span class="text-blue-700 font-semibold bg-blue-50 px-2 py-0.5 rounded-md border border-blue-200">👤 ผู้ลงคิว: ${b.employeeName}</span>` : ''}
              ${b.employeeName && isInterviewDuty ? `<span class="text-purple-700 font-semibold bg-purple-50 px-2 py-0.5 rounded-md border border-purple-200">👤 ผู้จอง: ${b.employeeName}</span>` : ''}
              <span>📍 ${b.meetingType === 'online' ? '💻 คุยออนไลน์' : `🏢 ${b.branchName || 'ที่สาขา'}${b.branchAddress ? ` (${b.branchAddress})` : ''}`}</span>
            </div>
            ${b.notes ? `<p class="text-xs text-slate-500 mt-1 italic">"${b.notes}"</p>` : ''}
          </div>
          ${actionBtnHtml}
        `;
        list.appendChild(item);
      });
    } catch (err) {
      console.error(err);
      list.innerHTML = '<div class="text-center py-6 text-rose-500 text-xs">เกิดข้อผิดพลาดในการโหลดคิวของฉัน</div>';
    }
  }

  // -------------------------------------------------------------
  // Host Management Tab
  // -------------------------------------------------------------
  populateBranchDropdown() {
    const select = document.getElementById('dutyBranchSelect');
    if (select) {
      select.innerHTML = '';
      this.branches.forEach(br => {
        const opt = document.createElement('option');
        opt.value = br.id;
        opt.textContent = `${br.name} (${br.address})`;
        select.appendChild(opt);
      });
    }

    const hostBranchSelect = document.getElementById('settingHostDefaultBranch');
    if (hostBranchSelect) {
      const currentHostBranch = hostBranchSelect.value;
      hostBranchSelect.innerHTML = '';
      this.branches.forEach(br => {
        const opt = document.createElement('option');
        opt.value = br.id;
        opt.textContent = `${br.name} (${br.address})`;
        hostBranchSelect.appendChild(opt);
      });
      if (currentHostBranch) hostBranchSelect.value = currentHostBranch;
    }

    const newLeaderBranchSelect = document.getElementById('newLeaderDefaultBranch');
    if (newLeaderBranchSelect) {
      const currentLeaderBranch = newLeaderBranchSelect.value;
      newLeaderBranchSelect.innerHTML = '';
      this.branches.forEach(br => {
        const opt = document.createElement('option');
        opt.value = br.id;
        opt.textContent = `${br.name} (${br.address})`;
        newLeaderBranchSelect.appendChild(opt);
      });
      if (currentLeaderBranch) newLeaderBranchSelect.value = currentLeaderBranch;
    }
  }

  openDutyModal() {
    const dateInput = document.getElementById('dutyDateInput');
    const todayStr = new Date().toISOString().split('T')[0];
    dateInput.value = this.selectedDate || todayStr;
    this.setDutyMode('work');
    document.getElementById('dutyModal').classList.remove('hidden');
    lucide.createIcons();
  }

  closeDutyModal() {
    document.getElementById('dutyModal').classList.add('hidden');
  }

  setDutyMode(mode) {
    const workBtn = document.getElementById('dutyTypeWorkBtn');
    const leaveBtn = document.getElementById('dutyTypeLeaveBtn');
    const branchSection = document.getElementById('dutyBranchSection');
    const leaveSection = document.getElementById('dutyLeaveSection');

    if (mode === 'work') {
      workBtn.className = 'py-2 px-3 border border-amber-500 bg-amber-50 text-amber-900 rounded-xl font-semibold text-center transition';
      leaveBtn.className = 'py-2 px-3 border border-slate-200 bg-slate-50 text-slate-600 rounded-xl font-semibold text-center transition';
      branchSection.classList.remove('hidden');
      leaveSection.classList.add('hidden');
      this.dutyMode = 'work';
    } else {
      workBtn.className = 'py-2 px-3 border border-slate-200 bg-slate-50 text-slate-600 rounded-xl font-semibold text-center transition';
      leaveBtn.className = 'py-2 px-3 border border-rose-500 bg-rose-50 text-rose-900 rounded-xl font-semibold text-center transition';
      branchSection.classList.add('hidden');
      leaveSection.classList.remove('hidden');
      this.dutyMode = 'leave';
    }
  }

  async saveDuty() {
    const date = document.getElementById('dutyDateInput').value;
    const note = document.getElementById('dutyNoteInput').value.trim();
    if (!date) {
      this.showToast('error', 'กรุณาเลือกวันที่');
      return;
    }

    let payload = { date, note };
    if (this.dutyMode === 'leave') {
      const leaveType = document.getElementById('dutyLeaveTypeSelect').value;
      payload.isLeave = true;
      payload.leaveType = leaveType;
    } else {
      const branchId = document.getElementById('dutyBranchSelect').value;
      const branchObj = this.branches.find(b => b.id === branchId);
      payload.isLeave = false;
      payload.branchId = branchId;
      payload.branchName = branchObj ? branchObj.name : 'สำนักงานใหญ่';
    }

    try {
      const res = await fetch('/api/host/duty', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      this.showToast('success', data.message);

      // แจ้งเตือนข้อความใน LINE ผ่าน LIFF
      if (payload.isLeave) {
        const hostName = (this.settings && this.settings.hostName) || this.currentUser.name || 'Host';
        let msg = `🏖️ แจ้งสถานะการลา / ภารกิจ\nหัวข้อ: ${payload.leaveType || 'ลาอื่นๆ'}\nวันที่: ${date}\nผู้แจ้ง: ${hostName}`;
        if (payload.note) msg += `\nหมายเหตุ: ${payload.note}`;
        await this.sendLineNotification(msg);
      } else if (payload.branchName) {
        const hostName = (this.settings && this.settings.hostName) || this.currentUser.name || 'Host';
        let msg = `📍 แจ้งสถานที่ปฏิบัติงาน\nสถานที่: ${payload.branchName}\nวันที่: ${date}\nผู้แจ้ง: ${hostName}`;
        if (payload.note) msg += `\nหมายเหตุ: ${payload.note}`;
        await this.sendLineNotification(msg);
      }

      this.closeDutyModal();
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  openBlockModal() {
    const dateInput = document.getElementById('blockDateInput');
    const todayStr = new Date().toISOString().split('T')[0];
    dateInput.value = this.selectedDate || todayStr;
    document.getElementById('blockFullDayCheckbox').checked = false;
    document.getElementById('blockTimeInputs').classList.remove('hidden');
    document.getElementById('blockReasonInput').value = '';
    document.getElementById('blockModal').classList.remove('hidden');
    lucide.createIcons();
  }

  closeBlockModal() {
    document.getElementById('blockModal').classList.add('hidden');
  }

  toggleBlockFullDay() {
    const isFullDay = document.getElementById('blockFullDayCheckbox').checked;
    const timeInputs = document.getElementById('blockTimeInputs');
    if (isFullDay) {
      timeInputs.classList.add('hidden');
    } else {
      timeInputs.classList.remove('hidden');
    }
  }

  async saveBlockSlot() {
    const date = document.getElementById('blockDateInput').value;
    const isFullDay = document.getElementById('blockFullDayCheckbox').checked;
    const startTime = document.getElementById('blockStartTimeInput').value;
    const endTime = document.getElementById('blockEndTimeInput').value;
    const reason = document.getElementById('blockReasonInput').value.trim();

    if (!date) {
      this.showToast('error', 'กรุณาเลือกวันที่');
      return;
    }

    try {
      const res = await fetch('/api/host/block-slot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({ date, isFullDay, startTime, endTime, reason })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถบันทึกบล็อกเวลาได้');

      this.showToast('success', data.message);
      this.closeBlockModal();
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async unblockSlot(blockId) {
    if (!confirm('ต้องการยกเลิกการบล็อกช่วงเวลานี้หรือไม่?')) return;

    try {
      const res = await fetch(`/api/host/block-slot/${blockId}`, {
        method: 'DELETE',
        headers: {
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        }
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถยกเลิกได้');

      this.showToast('info', data.message);
      if (this.selectedDate) await this.openDayModal(this.selectedDate);
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async loadHostBookings() {
    const list = document.getElementById('hostBookingsList');
    const countBadge = document.getElementById('hostTotalBookingsCount');

    try {
      const res = await fetch('/api/host/bookings', {
        headers: {
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        }
      });

      if (res.status === 403) {
        list.innerHTML = '<div class="text-center py-8 text-slate-400 text-xs">🔒 เฉพาะ Host หรือหัวหน้าทีมเท่านั้นที่สามารถดูรายชื่อคิวได้</div>';
        countBadge.textContent = 'ล็อกสิทธิ์';
        return;
      }

      const data = await res.json();
      const bookings = data.bookings || [];
      countBadge.textContent = `${bookings.length} รายการ`;

      if (bookings.length === 0) {
        list.innerHTML = '<div class="text-center py-8 text-slate-400 text-xs">ยังไม่มีคิวที่ลงไว้</div>';
        return;
      }

      const isHost = this.currentUser.role === 'host';

      list.innerHTML = '';
      bookings.forEach(b => {
        const item = document.createElement('div');
        item.className = 'p-4 rounded-2xl border border-slate-200 bg-white shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3';
        
        const d = new Date(b.date + 'T00:00:00');
        const thaiDateStr = `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;

        const isMine = this.currentUser && b.employeeUserId === this.currentUser.id;

        let badgeHtml = '';
        if (b.isCompanyMeeting) {
          if (isMine) {
            badgeHtml = '<span class="text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.2 rounded-md">📢 ประชุมบริษัท (คิวของคุณ) ⭐</span>';
          } else if (isHost || this.currentUser.role === 'team_leader') {
            badgeHtml = '<span class="text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.2 rounded-md">📢 ประชุมบริษัท (Host/หัวหน้าทีม)</span>';
          } else {
            badgeHtml = '<span class="text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.2 rounded-md">📢 ประชุมบริษัท</span>';
          }
        } else if (b.isInterview) {
          if (isMine) {
            badgeHtml = '<span class="text-[10px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.2 rounded-md">💼 สัมภาษณ์งาน (คิวของคุณ) ⭐</span>';
          } else if (isHost || this.currentUser.role === 'team_leader') {
            badgeHtml = '<span class="text-[10px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.2 rounded-md">🎯 💼 สัมภาษณ์งาน (กรรมการ)</span>';
          } else {
            badgeHtml = '<span class="text-[10px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.2 rounded-md">🔒 💼 สัมภาษณ์งาน</span>';
          }
        } else {
          badgeHtml = isMine ? '<span class="text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.2 rounded-md">คิวของคุณ ⭐</span>' : '<span class="text-[10px] font-bold text-teal-700 bg-teal-100 px-1.5 py-0.2 rounded-md">👥 เพื่อนร่วมงาน</span>';
        }

        item.innerHTML = `
          <div class="flex items-start space-x-3">
            <img src="${b.employeePicture || 'https://api.dicebear.com/7.x/bottts/svg?seed=' + encodeURIComponent(b.employeeName || 'User')}" class="w-10 h-10 rounded-full bg-slate-200 border-2 border-white shadow-xs shrink-0 object-cover">
            <div>
              <div class="flex items-center space-x-2 flex-wrap">
                <span class="text-xs font-bold text-slate-800">${b.employeeName}</span>
                ${badgeHtml}
                <span class="text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.2 rounded-md">${b.meetingType === 'online' ? '💻 ออนไลน์' : '🏢 ' + (b.branchName || 'ที่สาขา')}</span>
              </div>
              <h4 class="font-bold text-slate-800 text-xs sm:text-sm mt-0.5">📌 ${b.eventTitle || 'นัดหมาย'}</h4>
              <div class="flex items-center space-x-2 text-xs text-slate-500 mt-0.5">
                <span class="font-medium text-emerald-700">📅 ${thaiDateStr} (${b.startTime} - ${b.endTime} น.)</span>
                <span>•</span>
                <span>${b.eventType || 'ทั่วไป'}</span>
              </div>
              ${b.notes && b.notes !== 'รายละเอียดการประชุม' ? `<p class="text-xs text-slate-500 mt-1 italic">"${b.notes}"</p>` : ''}
            </div>
          </div>
          ${isHost ? `
            <button onclick="app.cancelBooking('${b.id}')" class="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold rounded-xl transition self-end sm:self-center shrink-0">
              ยกเลิก (Host)
            </button>
          ` : isMine ? `
            <button onclick="app.cancelBooking('${b.id}')" class="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold rounded-xl transition self-end sm:self-center shrink-0">
              ยกเลิกคิวนี้
            </button>
          ` : `
            <span class="px-2.5 py-1 bg-slate-100 text-slate-500 rounded-xl text-[11px] font-medium self-end sm:self-center shrink-0">
              👁️ ดูอย่างเดียว
            </span>
          `}
        `;
        list.appendChild(item);
      });
    } catch (err) {
      console.error(err);
      list.innerHTML = '<div class="text-center py-6 text-rose-500 text-xs">เกิดข้อผิดพลาดในการโหลดรายการคิว</div>';
    }
  }

  // -------------------------------------------------------------
  // Branch Management (จัดการรายชื่อสาขา)
  // -------------------------------------------------------------
  openBranchModal() {
    this.renderBranchList();
    document.getElementById('newBranchName').value = '';
    document.getElementById('newBranchAddress').value = '';
    document.getElementById('branchModal').classList.remove('hidden');
    lucide.createIcons();
  }

  closeBranchModal() {
    document.getElementById('branchModal').classList.add('hidden');
  }

  renderBranchList() {
    const container = document.getElementById('branchListContainer');
    container.innerHTML = '';

    if (!this.branches || this.branches.length === 0) {
      container.innerHTML = '<div class="text-center py-4 text-slate-400 text-xs">ยังไม่มีสาขาที่บันทึกไว้</div>';
      return;
    }

    this.branches.forEach(b => {
      const item = document.createElement('div');
      item.className = 'p-3 rounded-xl border border-slate-200 bg-white flex items-center justify-between gap-2 text-xs';
      item.innerHTML = `
        <div class="flex-1">
          <div class="font-bold text-slate-800 flex items-center space-x-1.5">
            <span class="w-2 h-2 rounded-full bg-teal-500"></span>
            <span id="branchNameDisplay_${b.id}">${b.name}</span>
          </div>
          <div id="branchAddressDisplay_${b.id}" class="text-[11px] text-slate-500 mt-0.5">${b.address || 'ไม่มีที่อยู่ระบุ'}</div>
        </div>
        <div class="flex items-center space-x-1.5">
          <button onclick="app.editBranch('${b.id}')" class="p-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition" title="แก้ไข">
            <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
          </button>
          <button onclick="app.deleteBranch('${b.id}')" class="p-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg transition" title="ลบ">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      `;
      container.appendChild(item);
    });

    lucide.createIcons();
  }

  async addBranch() {
    const name = document.getElementById('newBranchName').value.trim();
    const address = document.getElementById('newBranchAddress').value.trim();

    if (!name) {
      this.showToast('error', 'กรุณาระบุชื่อสาขา');
      return;
    }

    try {
      const res = await fetch('/api/branches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({ name, address })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถเพิ่มสาขาได้');

      this.showToast('success', 'เพิ่มสาขาเรียบร้อยแล้ว!');
      this.branches.push(data.branch);
      document.getElementById('newBranchName').value = '';
      document.getElementById('newBranchAddress').value = '';
      this.renderBranchList();
      this.populateBranchDropdown();
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async editBranch(branchId) {
    const branch = this.branches.find(b => b.id === branchId);
    if (!branch) return;

    const newName = prompt('แก้ไขชื่อสาขา:', branch.name);
    if (newName === null) return;
    if (!newName.trim()) {
      alert('ชื่อสาขาต้องไม่เว้นว่าง');
      return;
    }

    const newAddress = prompt('แก้ไขที่อยู่ / ห้องประชุม:', branch.address || '');
    if (newAddress === null) return;

    try {
      const res = await fetch(`/api/branches/${branchId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({ name: newName.trim(), address: newAddress.trim() })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถแก้ไขได้');

      this.showToast('success', 'แก้ไขชื่อสาขาสำเร็จ!');
      branch.name = newName.trim();
      branch.address = newAddress.trim();
      this.renderBranchList();
      this.populateBranchDropdown();
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async deleteBranch(branchId) {
    const branch = this.branches.find(b => b.id === branchId);
    if (!branch) return;

    if (!confirm(`คุณต้องการลบสาขา "${branch.name}" ใช่หรือไม่?`)) return;

    try {
      const res = await fetch(`/api/branches/${branchId}`, {
        method: 'DELETE',
        headers: {
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        }
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถลบได้');

      this.showToast('info', 'ลบสาขาเรียบร้อยแล้ว');
      this.branches = this.branches.filter(b => b.id !== branchId);
      this.renderBranchList();
      this.populateBranchDropdown();
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  // -------------------------------------------------------------
  // Team Leader Duty (หัวหน้าทีมบันทึกสาขา / วันลา)
  // -------------------------------------------------------------
  async openTeamDutyModal(targetLeaderId) {
    const leaderSelect = document.getElementById('teamDutyLeaderSelect');
    const branchSelect = document.getElementById('teamDutyBranchSelect');
    const dateInput = document.getElementById('teamDutyDateInput');

    const todayStr = new Date().toISOString().split('T')[0];
    dateInput.value = this.selectedDate || todayStr;

    // Populate branches
    branchSelect.innerHTML = '';
    this.branches.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = `${b.name} (${b.address || ''})`;
      branchSelect.appendChild(opt);
    });

    // Populate leaders
    try {
      const res = await fetch('/api/team-leaders');
      const data = await res.json();
      this.teamLeaders = data.leaders || [];

      leaderSelect.innerHTML = '';
      this.teamLeaders.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = `${l.name} (${l.department})`;
        if (targetLeaderId && l.id === targetLeaderId) {
          opt.selected = true;
        } else if (!targetLeaderId && this.currentUser.leaderId === l.id) {
          opt.selected = true;
        }
        leaderSelect.appendChild(opt);
      });
    } catch (e) {
      console.error(e);
    }

    this.setTeamDutyMode('work');
    document.getElementById('teamDutyNoteInput').value = '';
    document.getElementById('teamDutyModal').classList.remove('hidden');
    lucide.createIcons();
  }

  closeTeamDutyModal() {
    document.getElementById('teamDutyModal').classList.add('hidden');
  }

  setTeamDutyMode(mode) {
    const workBtn = document.getElementById('teamDutyTypeWorkBtn');
    const leaveBtn = document.getElementById('teamDutyTypeLeaveBtn');
    const branchSection = document.getElementById('teamDutyBranchSection');
    const leaveSection = document.getElementById('teamDutyLeaveSection');

    if (mode === 'work') {
      workBtn.className = 'py-2 px-3 border border-teal-500 bg-teal-50 text-teal-900 rounded-xl font-semibold text-center transition';
      leaveBtn.className = 'py-2 px-3 border border-slate-200 bg-slate-50 text-slate-600 rounded-xl font-semibold text-center transition';
      branchSection.classList.remove('hidden');
      leaveSection.classList.add('hidden');
      this.teamDutyMode = 'work';
    } else {
      workBtn.className = 'py-2 px-3 border border-slate-200 bg-slate-50 text-slate-600 rounded-xl font-semibold text-center transition';
      leaveBtn.className = 'py-2 px-3 border border-rose-500 bg-rose-50 text-rose-900 rounded-xl font-semibold text-center transition';
      branchSection.classList.add('hidden');
      leaveSection.classList.remove('hidden');
      this.teamDutyMode = 'leave';
    }
  }

  async saveTeamDuty() {
    const leaderId = document.getElementById('teamDutyLeaderSelect').value;
    const date = document.getElementById('teamDutyDateInput').value;
    const note = document.getElementById('teamDutyNoteInput').value.trim();

    if (!leaderId || !date) {
      this.showToast('error', 'กรุณาระบุข้อมูลให้ครบถ้วน');
      return;
    }

    let payload = { leaderId, date, note };
    if (this.teamDutyMode === 'leave') {
      payload.isLeave = true;
      payload.leaveType = document.getElementById('teamDutyLeaveTypeSelect').value;
    } else {
      const branchId = document.getElementById('teamDutyBranchSelect').value;
      const bObj = this.branches.find(b => b.id === branchId);
      payload.isLeave = false;
      payload.branchId = branchId;
      payload.branchName = bObj ? bObj.name : 'สำนักงานใหญ่';
    }

    try {
      const res = await fetch('/api/team-duty', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      this.showToast('success', data.message);

      // แจ้งเตือนข้อความใน LINE ผ่าน LIFF
      const leaderObj = this.teamLeaders.find(l => l.id === leaderId);
      const leaderName = leaderObj ? leaderObj.name : (this.currentUser.name || 'หัวหน้าทีม');
      if (payload.isLeave) {
        let msg = `🏖️ แจ้งสถานะการลา / ภารกิจ\nหัวข้อ: ${payload.leaveType || 'ลาอื่นๆ'}\nวันที่: ${date}\nผู้แจ้ง: ${leaderName}`;
        if (payload.note) msg += `\nหมายเหตุ: ${payload.note}`;
        await this.sendLineNotification(msg);
      } else if (payload.branchName) {
        let msg = `📍 แจ้งสถานที่ปฏิบัติงาน\nหัวหน้าทีม: ${leaderName}\nสถานที่: ${payload.branchName}\nวันที่: ${date}`;
        if (payload.note) msg += `\nหมายเหตุ: ${payload.note}`;
        await this.sendLineNotification(msg);
      }

      this.closeTeamDutyModal();
      if (this.selectedDate) {
        await this.openDayModal(this.selectedDate);
      }
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  // -------------------------------------------------------------
  // Team Leader Management (Host จัดการรายชื่อหัวหน้าทีม)
  // -------------------------------------------------------------
  async openTeamLeaderManageModal() {
    const branchSelect = document.getElementById('newLeaderDefaultBranch');
    if (branchSelect) {
      branchSelect.innerHTML = '';
      this.branches.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = `${b.name} (${b.address || ''})`;
        branchSelect.appendChild(opt);
      });
    }

    const editSection = document.getElementById('editLeaderFormSection');
    if (editSection) editSection.classList.add('hidden');

    document.getElementById('newLeaderName').value = '';
    document.getElementById('newLeaderDept').value = '';
    document.getElementById('newLeaderLineId').value = '';

    // โหลดรายชื่อสมาชิก LINE ที่เคยเข้าใช้ระบบลงใน Dropdown
    await this.populateRegisteredUsersDropdown();

    await this.renderTeamLeaderManageList();
    document.getElementById('teamLeaderManageModal').classList.remove('hidden');
    lucide.createIcons();
  }

  async populateRegisteredUsersDropdown() {
    const userSelect = document.getElementById('selectRegisteredUser');
    if (!userSelect) return;
    userSelect.innerHTML = '<option value="">-- แตะเพื่อเลือกสมาชิก LINE ที่เคยเข้าใช้ระบบ --</option>';

    try {
      const res = await fetch('/api/users');
      const data = await res.json();
      this.registeredUsers = data.users || [];

      this.registeredUsers.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u.userId;
        const shortId = (u.userId || '').length > 10 ? (u.userId.substring(0, 8) + '...') : u.userId;
        opt.textContent = `👤 ${u.displayName} (${shortId})`;
        userSelect.appendChild(opt);
      });
    } catch (e) {
      console.warn('Could not load users:', e);
    }
  }

  onSelectRegisteredUser(userId) {
    if (!userId) {
      document.getElementById('newLeaderName').value = '';
      document.getElementById('newLeaderLineId').value = '';
      return;
    }

    const user = (this.registeredUsers || []).find(u => u.userId === userId);
    if (user) {
      document.getElementById('newLeaderName').value = user.displayName || '';
      document.getElementById('newLeaderLineId').value = user.userId || '';
      if (!document.getElementById('newLeaderDept').value) {
        document.getElementById('newLeaderDept').value = 'Unit';
      }
    }
  }

  closeTeamLeaderManageModal() {
    document.getElementById('teamLeaderManageModal').classList.add('hidden');
  }

  async renderTeamLeaderManageList() {
    const container = document.getElementById('teamLeaderListContainer');
    container.innerHTML = '<div class="py-4 text-center text-slate-400 text-xs">กำลังโหลด...</div>';

    try {
      const res = await fetch('/api/team-leaders');
      const data = await res.json();
      const leaders = data.leaders || [];
      this.currentLeadersList = leaders;

      if (leaders.length === 0) {
        container.innerHTML = '<div class="py-4 text-center text-slate-400 text-xs">ยังไม่มีรายชื่อหัวหน้าทีม</div>';
        return;
      }

      container.innerHTML = '';
      leaders.forEach(l => {
        const branch = this.branches.find(b => b.id === l.defaultBranchId);
        const branchName = branch ? branch.name : 'สำนักงานใหญ่';

        const item = document.createElement('div');
        item.className = 'p-3 rounded-xl border border-slate-200 bg-white flex items-center justify-between gap-2 text-xs shadow-2xs hover:border-indigo-200 transition';
        item.innerHTML = `
          <div class="flex items-center space-x-2.5">
            <img src="${l.picture}" class="w-8 h-8 rounded-full bg-slate-200 border border-white shrink-0">
            <div>
              <div class="font-bold text-slate-800 flex items-center space-x-1.5">
                <span>${l.name}</span>
                <span class="text-[10px] bg-teal-50 text-teal-700 border border-teal-200 px-1.5 py-0.2 rounded font-medium">📍 ${branchName}</span>
              </div>
              <div class="text-[11px] text-slate-500">${l.department} • <code class="bg-slate-100 px-1 py-0.2 rounded text-[10px]">${l.lineUserId}</code></div>
            </div>
          </div>
          <div class="flex items-center space-x-1 shrink-0">
            <button onclick="app.openEditTeamLeader('${l.id}')" class="p-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded-lg transition" title="แก้ไข">
              <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
            </button>
            <button onclick="app.deleteTeamLeader('${l.id}')" class="p-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg transition" title="ลบ">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        `;
        container.appendChild(item);
      });

      lucide.createIcons();
    } catch (e) {
      console.error(e);
      container.innerHTML = '<div class="py-4 text-center text-rose-500 text-xs">เกิดข้อผิดพลาดในการโหลด</div>';
    }
  }

  openEditTeamLeader(leaderId) {
    const leader = (this.currentLeadersList || []).find(l => l.id === leaderId);
    if (!leader) return;

    const editSection = document.getElementById('editLeaderFormSection');
    if (!editSection) return;

    document.getElementById('editLeaderId').value = leader.id;
    document.getElementById('editLeaderName').value = leader.name;
    document.getElementById('editLeaderDept').value = leader.department || '';
    document.getElementById('editLeaderLineId').value = leader.lineUserId || '';

    const branchSelect = document.getElementById('editLeaderDefaultBranch');
    if (branchSelect) {
      branchSelect.innerHTML = '';
      this.branches.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = `${b.name} (${b.address || ''})`;
        branchSelect.appendChild(opt);
      });
      if (leader.defaultBranchId) {
        branchSelect.value = leader.defaultBranchId;
      }
    }

    editSection.classList.remove('hidden');
    editSection.scrollIntoView({ behavior: 'smooth' });
    lucide.createIcons();
  }

  cancelEditTeamLeader() {
    const editSection = document.getElementById('editLeaderFormSection');
    if (editSection) editSection.classList.add('hidden');
  }

  async saveEditTeamLeader() {
    const leaderId = document.getElementById('editLeaderId').value;
    const name = document.getElementById('editLeaderName').value.trim();
    const department = document.getElementById('editLeaderDept').value.trim();
    const defaultBranchId = document.getElementById('editLeaderDefaultBranch').value;
    const lineUserId = document.getElementById('editLeaderLineId').value.trim();

    if (!name) {
      this.showToast('error', 'กรุณาระบุชื่อหัวหน้าทีม');
      return;
    }

    try {
      const res = await fetch(`/api/team-leaders/${leaderId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({ name, department, defaultBranchId, lineUserId })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถแก้ไขข้อมูลได้');

      this.showToast('success', 'บันทึกการแก้ไขหัวหน้าทีมเรียบร้อยแล้ว');
      this.cancelEditTeamLeader();
      await this.renderTeamLeaderManageList();
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async addTeamLeader() {
    const name = document.getElementById('newLeaderName').value.trim();
    const department = document.getElementById('newLeaderDept').value.trim();
    const defaultBranchId = document.getElementById('newLeaderDefaultBranch').value;
    const lineUserId = document.getElementById('newLeaderLineId').value.trim();

    if (!name) {
      this.showToast('error', 'กรุณาระบุชื่อหัวหน้าทีม');
      return;
    }

    try {
      const res = await fetch('/api/team-leaders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({ name, department, defaultBranchId, lineUserId })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถเพิ่มหัวหน้าทีมได้');

      this.showToast('success', 'เพิ่มหัวหน้าทีมเรียบร้อยแล้ว!');
      document.getElementById('newLeaderName').value = '';
      document.getElementById('newLeaderDept').value = '';
      document.getElementById('newLeaderLineId').value = '';
      const selectReg = document.getElementById('selectRegisteredUser');
      if (selectReg) selectReg.value = '';
      await this.renderTeamLeaderManageList();
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async deleteTeamLeader(leaderId) {
    if (!confirm('คุณต้องการลบรายชื่อหัวหน้าทีมท่านนี้ใช่หรือไม่?')) return;

    try {
      const res = await fetch(`/api/team-leaders/${leaderId}`, {
        method: 'DELETE',
        headers: {
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        }
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถลบได้');

      this.showToast('info', 'ลบหัวหน้าทีมเรียบร้อยแล้ว');
      await this.renderTeamLeaderManageList();
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  // -------------------------------------------------------------
  // Settings Modal (ตั้งค่าระบบ & ข้อมูล Host & ที่อยู่ปกติ)
  // -------------------------------------------------------------
  async openSettingsModal() {
    try {
      const branchSelect = document.getElementById('settingHostDefaultBranch');
      if (branchSelect) {
        branchSelect.innerHTML = '';
        this.branches.forEach(br => {
          const opt = document.createElement('option');
          opt.value = br.id;
          opt.textContent = `${br.name} (${br.address || ''})`;
          branchSelect.appendChild(opt);
        });
      }

      const res = await fetch('/api/settings');
      const data = await res.json();
      const s = data.settings || {};

      document.getElementById('settingHostName').value = s.hostName || '';
      if (branchSelect && s.defaultBranchId) {
        branchSelect.value = s.defaultBranchId;
      }
      document.getElementById('settingSlotDuration').value = s.slotDurationMinutes || 60;
      if (document.getElementById('settingWorkStartHour')) {
        document.getElementById('settingWorkStartHour').value = s.workStartHour || 8;
      }
      if (document.getElementById('settingWorkEndHour')) {
        document.getElementById('settingWorkEndHour').value = s.workEndHour || 17;
      }
      if (document.getElementById('settingWeekendOpen')) {
        document.getElementById('settingWeekendOpen').checked = !!s.weekendOpen;
      }

      document.getElementById('settingsModal').classList.remove('hidden');
      lucide.createIcons();
    } catch (e) {
      this.showToast('error', 'ไม่สามารถโหลดการตั้งค่าได้');
    }
  }

  closeSettingsModal() {
    document.getElementById('settingsModal').classList.add('hidden');
  }

  async saveSettings() {
    const hostName = document.getElementById('settingHostName').value.trim();
    const defaultBranchId = document.getElementById('settingHostDefaultBranch') ? document.getElementById('settingHostDefaultBranch').value : undefined;
    const slotDurationMinutes = document.getElementById('settingSlotDuration').value;
    const workStartHour = document.getElementById('settingWorkStartHour') ? document.getElementById('settingWorkStartHour').value : 8;
    const workEndHour = document.getElementById('settingWorkEndHour') ? document.getElementById('settingWorkEndHour').value : 17;
    const weekendOpenEl = document.getElementById('settingWeekendOpen');
    const weekendOpen = weekendOpenEl ? weekendOpenEl.checked : false;

    if (!hostName) {
      this.showToast('error', 'กรุณาระบุชื่อเจ้าของคิว (Host)');
      return;
    }

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({
          hostName,
          defaultBranchId,
          slotDurationMinutes: parseInt(slotDurationMinutes),
          workStartHour: parseInt(workStartHour),
          workEndHour: parseInt(workEndHour),
          weekendOpen
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถบันทึกการตั้งค่าได้');

      this.showToast('success', 'บันทึกการตั้งค่าเรียบร้อยแล้ว');
      this.closeSettingsModal();
      await this.loadMonthCalendar();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  // -------------------------------------------------------------
  // Event Types Management (จัดการหมวดหมู่งาน Event)
  // -------------------------------------------------------------
  async openEventTypeModal() {
    await this.renderEventTypeList();
    const input = document.getElementById('newEventTypeName');
    if (input) input.value = '';
    document.getElementById('eventTypeModal').classList.remove('hidden');
    lucide.createIcons();
  }

  closeEventTypeModal() {
    document.getElementById('eventTypeModal').classList.add('hidden');
  }

  async renderEventTypeList() {
    const container = document.getElementById('eventTypeListContainer');
    if (!container) return;
    container.innerHTML = '<div class="py-4 text-center text-slate-400 text-xs">กำลังโหลด...</div>';

    try {
      const res = await fetch('/api/event-types');
      const data = await res.json();
      this.eventTypes = data.eventTypes || [];

      if (this.eventTypes.length === 0) {
        container.innerHTML = '<div class="py-4 text-center text-slate-400 text-xs">ยังไม่มีหมวดหมู่ Event</div>';
        return;
      }

      container.innerHTML = '';
      this.eventTypes.forEach((type, index) => {
        const isLocked = type.includes('สัมภาษณ์') || type.includes('ประชุมบริษัท');
        const item = document.createElement('div');
        item.className = 'p-3 rounded-xl border border-slate-200 bg-white flex items-center justify-between gap-2 text-xs shadow-2xs hover:border-purple-300 transition';
        
        let actionButtons = '';
        if (isLocked) {
          actionButtons = `
            <span class="px-2.5 py-1 bg-amber-50 text-amber-800 border border-amber-200 rounded-lg text-[10.5px] font-bold flex items-center gap-1 shrink-0" title="หมวดหมู่พื้นฐานของระบบ (ล็อกเพื่อความเสถียร)">
              <i data-lucide="lock" class="w-3 h-3 text-amber-600"></i>
              <span>ระบบล็อก</span>
            </span>
          `;
        } else {
          actionButtons = `
            <button onclick="app.editEventType(${index})" class="p-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 rounded-lg transition" title="แก้ไข">
              <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
            </button>
            <button onclick="app.deleteEventType(${index})" class="p-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg transition" title="ลบ">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          `;
        }

        item.innerHTML = `
          <div class="flex items-center space-x-2.5">
            <span class="w-6 h-6 rounded-lg ${isLocked ? 'bg-amber-100 text-amber-800' : 'bg-purple-100 text-purple-700'} font-bold flex items-center justify-center text-[10px] shrink-0">${index + 1}</span>
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-semibold text-slate-800" id="eventTypeName_${index}">${type}</span>
              ${isLocked ? '<span class="text-[9px] font-bold text-amber-700 bg-amber-100/60 border border-amber-200 px-1.5 py-0.2 rounded-md">หมวดหมู่ระบบ</span>' : ''}
            </div>
          </div>
          <div class="flex items-center space-x-1 shrink-0">
            ${actionButtons}
          </div>
        `;
        container.appendChild(item);
      });

      lucide.createIcons();
    } catch (e) {
      console.error(e);
      container.innerHTML = '<div class="py-4 text-center text-rose-500 text-xs">เกิดข้อผิดพลาดในการโหลด</div>';
    }
  }

  async addEventType() {
    const input = document.getElementById('newEventTypeName');
    const name = input ? input.value.trim() : '';

    if (!name) {
      this.showToast('error', 'กรุณาระบุชื่อหมวดหมู่ Event');
      return;
    }

    try {
      const res = await fetch('/api/event-types', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({ name })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถเพิ่มหมวดหมู่ได้');

      this.showToast('success', 'เพิ่มหมวดหมู่ Event เรียบร้อยแล้ว!');
      if (input) input.value = '';
      this.eventTypes = data.eventTypes || [];
      this.populateEventTypeDropdown();
      await this.renderEventTypeList();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async editEventType(index) {
    const currentName = this.eventTypes[index];
    if (currentName && (currentName.includes('สัมภาษณ์') || currentName.includes('ประชุมบริษัท'))) {
      this.showToast('error', `ไม่อนุญาตให้แก้ไขหมวดหมู่ "${currentName}" ได้ เนื่องจากเป็นหมวดหมู่ระบบ`);
      return;
    }

    const newName = prompt('แก้ไขชื่อหมวดหมู่ Event:', currentName);
    if (newName === null) return;
    const trimmed = newName.trim();
    if (!trimmed) {
      this.showToast('error', 'ชื่อหมวดหมู่ต้องไม่เว้นว่าง');
      return;
    }
    if (trimmed === currentName) return;

    try {
      const res = await fetch(`/api/event-types/${index}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        },
        body: JSON.stringify({ name: trimmed })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถแก้ไขหมวดหมู่ได้');

      this.showToast('success', 'แก้ไขหมวดหมู่เรียบร้อยแล้ว!');
      this.eventTypes = data.eventTypes || [];
      this.populateEventTypeDropdown();
      await this.renderEventTypeList();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  async deleteEventType(index) {
    const currentName = this.eventTypes[index];
    if (currentName && (currentName.includes('สัมภาษณ์') || currentName.includes('ประชุมบริษัท'))) {
      this.showToast('error', `ไม่อนุญาตให้ลบหมวดหมู่ "${currentName}" ได้ เนื่องจากเป็นหมวดหมู่ระบบ`);
      return;
    }

    if (!confirm(`คุณต้องการลบหมวดหมู่ "${currentName}" ใช่หรือไม่?`)) return;

    try {
      const res = await fetch(`/api/event-types/${index}`, {
        method: 'DELETE',
        headers: {
          'x-user-id': this.currentUser.id,
          'x-role': this.currentUser.role
        }
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'ไม่สามารถลบหมวดหมู่ได้');

      this.showToast('info', 'ลบหมวดหมู่เรียบร้อยแล้ว');
      this.eventTypes = data.eventTypes || [];
      this.populateEventTypeDropdown();
      await this.renderEventTypeList();
    } catch (err) {
      this.showToast('error', err.message);
    }
  }

  // -------------------------------------------------------------
  // LINE LIFF Messaging Helper
  // -------------------------------------------------------------
  async sendLineNotification(text) {
    try {
      if (typeof liff !== 'undefined' && typeof liff.isInClient === 'function' && liff.isInClient() && liff.isLoggedIn && liff.isLoggedIn()) {
        await liff.sendMessages([
          {
            type: 'text',
            text: text
          }
        ]);
        return true;
      }
    } catch (msgErr) {
      console.log('LIFF message send skipped:', msgErr.message);
    }
    return false;
  }

  // -------------------------------------------------------------
  // UI Helpers & Toasts
  // -------------------------------------------------------------
  showToast(type, message) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    const isError = type === 'error';
    const isSuccess = type === 'success';

    toast.className = `p-3.5 rounded-2xl shadow-xl border text-xs font-bold flex items-center justify-between pointer-events-auto transform transition-all duration-300 ${
      isError ? 'bg-rose-600 text-white border-rose-700' :
      isSuccess ? 'bg-emerald-600 text-white border-emerald-700' :
      'bg-slate-800 text-white border-slate-900'
    }`;

    toast.innerHTML = `
      <div class="flex items-center space-x-2">
        <i data-lucide="${isError ? 'alert-circle' : isSuccess ? 'check-circle' : 'info'}" class="w-4 h-4 shrink-0"></i>
        <span>${message}</span>
      </div>
    `;

    container.appendChild(toast);
    lucide.createIcons();

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }
}

// Instantiate App
const app = new MeetingQueueApp();
