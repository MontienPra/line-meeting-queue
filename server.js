const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
function getDbFile() {
  if (process.env.DATA_DIR) {
    const customDir = process.env.DATA_DIR;
    if (!fs.existsSync(customDir)) fs.mkdirSync(customDir, { recursive: true });
    return path.join(customDir, 'database.json');
  }
  const rootDb = path.join(__dirname, 'database.json');
  const dataDb = path.join(__dirname, 'data', 'database.json');
  if (fs.existsSync(rootDb) && fs.existsSync(dataDb)) {
    const mRoot = fs.statSync(rootDb).mtimeMs;
    const mData = fs.statSync(dataDb).mtimeMs;
    return mRoot >= mData ? rootDb : dataDb;
  }
  if (fs.existsSync(rootDb)) return rootDb;
  return dataDb;
}

app.use(cors());
app.use(express.json());

// Explicit routes for root-uploaded files take priority over any subfolder files:
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  const rootIndex = path.join(__dirname, 'index.html');
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  res.send('LINE Meeting Queue App Running');
});

app.get('/index.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  const rootIndex = path.join(__dirname, 'index.html');
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  res.status(404).send('index.html not found');
});

// App JS route: Serve root app.js first, then public/js/app.js
app.get('/js/app.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  const rootApp = path.join(__dirname, 'app.js');
  const publicApp = path.join(__dirname, 'public', 'js', 'app.js');
  const jsApp = path.join(__dirname, 'js', 'app.js');
  if (fs.existsSync(rootApp)) return res.sendFile(rootApp);
  if (fs.existsSync(publicApp)) return res.sendFile(publicApp);
  if (fs.existsSync(jsApp)) return res.sendFile(jsApp);
  res.status(404).send('app.js not found');
});

// CSS route
app.get('/css/styles.css', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  const rootCss = path.join(__dirname, 'styles.css');
  const publicCss = path.join(__dirname, 'public', 'css', 'styles.css');
  if (fs.existsSync(rootCss)) return res.sendFile(rootCss);
  if (fs.existsSync(publicCss)) return res.sendFile(publicCss);
  res.status(404).send('styles.css not found');
});

// Serve static assets without intercepting index
app.use(express.static(path.join(__dirname, 'public'), { index: false, etag: false, maxAge: 0 }));
app.use(express.static(__dirname, { index: false, etag: false, maxAge: 0 }));

// -------------------------------------------------------------
// Supabase Cloud Database Configuration
// -------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xepwbniexuompizfevrj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || Buffer.from('c2Jfc2VjcmV0X2tnSFRfWmtXczgybnNZYnJuNDZha3dfajFMOFliakk=', 'base64').toString('utf8');

let memoryDB = null;

async function fetchFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.main&select=data`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'User-Agent': 'Node.js/Server'
      }
    });
    if (res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].data) {
        return rows[0].data;
      }
    }
  } catch (err) {
    console.warn('⚠️ [Supabase] Fetch error:', err.message);
  }
  return null;
}

async function saveToSupabase(data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
        'User-Agent': 'Node.js/Server'
      },
      body: JSON.stringify({
        id: 'main',
        data: data,
        updated_at: new Date().toISOString()
      })
    });
    if (res.ok) {
      console.log('☁️ [Supabase] Synced database state to cloud successfully');
    } else {
      const txt = await res.text();
      console.warn('⚠️ [Supabase] Sync returned status:', res.status, txt);
    }
  } catch (err) {
    console.warn('⚠️ [Supabase] Sync failed (offline fallback):', err.message);
  }
}

// Initial Sync from Supabase on startup
async function initSupabaseSync() {
  console.log('🔄 Connecting to Supabase Cloud Database...');
  const cloudData = await fetchFromSupabase();
  if (cloudData && typeof cloudData === 'object') {
    memoryDB = cloudData;
    if (!memoryDB.registered_users) memoryDB.registered_users = [];
    if (!memoryDB.event_types) {
      memoryDB.event_types = ['ประชุมบริษัท', 'สัมภาษณ์งาน', '1-on-1 ปรึกษางาน', 'ประชุมติดตามงานโครงการ (Project Sync)', 'ตรวจแบบและขออนุมัติงาน', 'นัดคุยงานด่วน', 'อื่นๆ'];
    } else {
      let changed = false;
      if (!memoryDB.event_types.includes('สัมภาษณ์งาน')) {
        memoryDB.event_types.unshift('สัมภาษณ์งาน');
        changed = true;
      }
      if (!memoryDB.event_types.includes('ประชุมบริษัท')) {
        memoryDB.event_types.unshift('ประชุมบริษัท');
        changed = true;
      }
      if (changed) {
        saveToSupabase(memoryDB).catch(() => {});
      }
    }
    const file = getDbFile();
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(memoryDB, null, 2), 'utf8');
    } catch (e) {}
    console.log('✅ [Supabase] Successfully restored database from Supabase Cloud!');
  } else {
    console.log('ℹ️ [Supabase] Seeding cloud from local database.json...');
    const local = readLocalDB();
    memoryDB = local;
    await saveToSupabase(local);
  }
}

// -------------------------------------------------------------
// Database Helper (In-memory + Local File + Supabase Cloud)
// -------------------------------------------------------------
function readLocalDB() {
  const file = getDbFile();
  try {
    if (!fs.existsSync(file)) {
      const defaultPath = path.join(__dirname, 'data', 'database.json');
      if (file !== defaultPath && fs.existsSync(defaultPath)) {
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const defaultData = fs.readFileSync(defaultPath, 'utf8').replace(/^\uFEFF/, '');
        fs.writeFileSync(file, defaultData, 'utf8');
        return JSON.parse(defaultData);
      }
      return { settings: {}, branches: [], event_types: [], daily_duties: {}, blocked_slots: [], bookings: [], registered_users: [] };
    }
    const data = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(data);
    if (!parsed.registered_users) parsed.registered_users = [];
    return parsed;
  } catch (err) {
    console.error('Error reading database.json:', err);
    return { settings: {}, branches: [], event_types: [], daily_duties: {}, blocked_slots: [], bookings: [], registered_users: [] };
  }
}

function readDB() {
  if (memoryDB) {
    if (!memoryDB.registered_users) memoryDB.registered_users = [];
    return memoryDB;
  }
  memoryDB = readLocalDB();
  return memoryDB;
}

function writeDB(data) {
  memoryDB = data;
  const file = getDbFile();
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing database.json:', err);
  }

  saveToSupabase(data).catch(() => {});
  return true;
}

// -------------------------------------------------------------
// Time & Slot Helpers
// -------------------------------------------------------------
function padZero(num) {
  return num < 10 ? '0' + num : '' + num;
}

function generateDaySlots(settings, customHours = null) {
  const startHour = customHours?.startHour || settings.workStartHour || 8;
  const endHour = customHours?.endHour || settings.workEndHour || 17;
  const duration = settings.slotDurationMinutes || 60;
  const lunchStart = customHours?.lunchStartHour ?? (settings.lunchStartHour ?? 12);
  const lunchEnd = customHours?.lunchEndHour ?? (settings.lunchEndHour ?? 13);

  const slots = [];
  let currentMinutes = startHour * 60;
  const endMinutes = endHour * 60;

  while (currentMinutes + duration <= endMinutes) {
    const slotStartHour = Math.floor(currentMinutes / 60);
    const slotStartMin = currentMinutes % 60;
    const nextMinutes = currentMinutes + duration;
    const slotEndHour = Math.floor(nextMinutes / 60);
    const slotEndMin = nextMinutes % 60;

    // Check if slot falls into lunch break
    const isLunch = (slotStartHour >= lunchStart && slotStartHour < lunchEnd);

    if (!isLunch) {
      const startTimeStr = `${padZero(slotStartHour)}:${padZero(slotStartMin)}`;
      const endTimeStr = `${padZero(slotEndHour)}:${padZero(slotEndMin)}`;
      slots.push({
        startTime: startTimeStr,
        endTime: endTimeStr,
        label: `${startTimeStr} - ${endTimeStr}`
      });
    }

    currentMinutes = nextMinutes;
  }

  return slots;
}

function isHostUser(req, settings) {
  const userId = req.headers['x-user-id'] || req.query.userId || req.body.userId;
  const role = req.headers['x-role'] || req.query.role || req.body.role;
  const pin = req.headers['x-admin-pin'] || req.query.adminPin || req.body.adminPin;

  if (role === 'host' || role === 'admin') return true;
  if (userId && (userId === settings.adminUserId || userId === 'U0547143d0738f92fe64497e5f49dcefe' || userId === 'U_ADMIN_MONTIEN')) return true;
  if (pin && pin === settings.adminPin) return true;
  return false;
}

function isLeaderUser(req, db) {
  const userId = req.headers['x-user-id'] || req.query.userId || req.body.userId;
  const role = req.headers['x-role'] || req.query.role || req.body.role;
  if (role === 'team_leader') return true;
  if (userId) {
    const isMatched = (db.team_leaders || []).some(l => l.lineUserId === userId || l.id === userId);
    if (isMatched) return true;
  }
  return false;
}

function isHostOrLeaderUser(req, db) {
  return isHostUser(req, db.settings) || isLeaderUser(req, db);
}

function isInterviewBooking(b) {
  if (!b) return false;
  const type = (b.eventType || '').toLowerCase();
  const title = (b.eventTitle || '').toLowerCase();
  return type.includes('สัมภาษณ์') || title.includes('สัมภาษณ์') || type.includes('interview') || title.includes('interview');
}

function isCompanyMeetingBooking(b) {
  if (!b) return false;
  const type = (b.eventType || '').toLowerCase();
  const title = (b.eventTitle || '').toLowerCase();
  return type.includes('ประชุมบริษัท') || title.includes('ประชุมบริษัท') || type.includes('company meeting') || title.includes('company meeting');
}

// -------------------------------------------------------------
// Calendar Status Calculation Logic
// 🟢 Green = ว่าง / ยังไม่ลงคิว
// 🟡 Yellow = ลงคิวแล้ว (มีคนจองบางช่วง / หรือผู้ใช้ปัจจุบันจองไว้)
// 🔴 Red = คิวเต็ม (ทุกช่วงเวลาว่างถูกจองแล้ว)
// ⚪ Grey = ปิดรับคิว (Host ปิดรับคิว / ลาพักร้อน / วันหยุด)
// -------------------------------------------------------------
function calculateDayStatus(dateStr, db, currentUserId) {
  const { settings, daily_duties, blocked_slots, bookings } = db;
  const dateObj = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = dateObj.getDay(); // 0 = Sun, 6 = Sat

  // Check Weekend (allow override if duty specifies working Saturday / half-day or branch)
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  const duty = daily_duties[dateStr];
  const isSpecialWorkingWeekend = isWeekend && duty && !duty.isLeave && (duty.isWorkingDay || duty.isHalfDay || duty.branchId);

  if (isWeekend && !settings.weekendOpen && !isSpecialWorkingWeekend) {
    const dayName = (dayOfWeek === 6 ? 'เสาร์' : 'อาทิตย์');
    return {
      status: 'grey',
      statusText: `วัน${dayName} (ปิดรับคิว)`,
      canBook: false,
      reason: 'weekend',
      totalSlots: 0,
      availableSlots: 0,
      bookedSlots: 0
    };
  }

  // Check Leave (ลาพักร้อน / ลากิจ)
  if (duty && duty.isLeave) {
    return {
      status: 'grey',
      statusText: `${duty.leaveType || 'ลาพักร้อน'} (ปิดรับคิว)`,
      canBook: false,
      reason: 'leave',
      dutyNote: duty.note,
      totalSlots: 0,
      availableSlots: 0,
      bookedSlots: 0
    };
  }

  // Check Full-day Block by Host (if half-day is set, full-day block is automatically bypassed/unlocked)
  const fullDayBlock = (blocked_slots || []).find(b => b.date === dateStr && b.isFullDay);
  if (fullDayBlock && !(duty && duty.isHalfDay)) {
    return {
      status: 'grey',
      statusText: fullDayBlock.reason || 'เจ้าของคิวปิดรับคิวในวันนี้',
      canBook: false,
      reason: 'blocked_fullday',
      totalSlots: 0,
      availableSlots: 0,
      bookedSlots: 0
    };
  }

  // Generate standard slots (or custom half-day slots if specified: 08:00 - 12:00)
  const customHours = (duty && duty.isHalfDay) ? { startHour: 8, endHour: 12, lunchStartHour: 12, lunchEndHour: 12 } : null;
  const allSlots = generateDaySlots(settings, customHours);
  const totalSlotsCount = allSlots.length;

  if (totalSlotsCount === 0) {
    return {
      status: 'grey',
      statusText: 'ไม่มีช่วงเวลาทำการ',
      canBook: false,
      reason: 'no_slots',
      totalSlots: 0,
      availableSlots: 0,
      bookedSlots: 0
    };
  }

  // Time-blocked slots by host
  const dayBlocks = (blocked_slots || []).filter(b => b.date === dateStr && !b.isFullDay);

  // Active bookings for this date
  const dayBookings = (bookings || []).filter(b => b.date === dateStr && b.status !== 'cancelled');

  let openSlotsCount = 0;
  let bookedSlotsCount = 0;
  let myBookingCount = 0;

  allSlots.forEach(slot => {
    // Check if slot is blocked by host
    const isBlocked = dayBlocks.some(b => {
      return (slot.startTime < b.endTime && slot.endTime > b.startTime);
    });

    if (!isBlocked) {
      openSlotsCount++;
      const isBooked = dayBookings.some(b => (slot.startTime < b.endTime && slot.endTime > b.startTime));
      if (isBooked) {
        bookedSlotsCount++;
      }
    }
  });

  if (currentUserId) {
    myBookingCount = dayBookings.filter(b => b.employeeUserId === currentUserId).length;
  }

  // Determine status color
  let status = 'green';
  let statusText = 'ว่าง (สามารถลงคิวได้)';

  if (openSlotsCount === 0) {
    status = 'grey';
    statusText = 'Host ติดภารกิจตลอดวัน (ปิดรับคิว)';
  } else if (bookedSlotsCount >= openSlotsCount) {
    status = 'red';
    statusText = 'คิวเต็มทุกช่วงเวลา';
  } else if (bookedSlotsCount > 0) {
    status = 'yellow';
    statusText = `ลงคิวแล้ว (${bookedSlotsCount}/${openSlotsCount} คิว)`;
  }

  return {
    status,
    statusText,
    canBook: (status === 'green' || status === 'yellow'),
    totalSlots: openSlotsCount,
    availableSlots: openSlotsCount - bookedSlotsCount,
    bookedSlots: bookedSlotsCount,
    hasMyBooking: myBookingCount > 0,
    myBookingCount
  };
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 1. Get Monthly Calendar Overview
app.get('/api/calendar/month', (req, res) => {
  const db = readDB();
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1); // 1-12
  const userId = req.query.userId || null;

  // Days in month
  const daysInMonth = new Date(year, month, 0).getDate();
  const days = [];
  const leaders = db.team_leaders || [];
  const colorThemes = ['sky', 'purple', 'cyan', 'fuchsia', 'slate'];

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${padZero(month)}-${padZero(day)}`;
    const statusInfo = calculateDayStatus(dateStr, db, userId);
    const duty = db.daily_duties[dateStr] || null;
    const fullDayBlock = (db.blocked_slots || []).find(b => b.date === dateStr && b.isFullDay);

    // Collect roster (Host + Team Leaders) for this day
    const roster = [];

    // 1. Host Duty (Show badge on calendar only if on leave or has branch assigned)
    if (duty && (duty.isLeave || duty.branchName)) {
      const hostShortName = (db.settings.hostName || 'มณเทียร').replace(/^(คุณ|\(.*\))/g, '').trim().split(' ')[0] || 'มณเทียร';
      roster.push({
        id: 'host',
        name: db.settings.hostName || 'คุณมณเทียร (Host)',
        shortName: hostShortName,
        role: 'host',
        colorTheme: 'indigo',
        branchName: duty.branchName,
        isHalfDay: !!duty.isHalfDay,
        isLeave: !!duty.isLeave,
        leaveType: duty.leaveType || null,
        note: duty.note || ''
      });
    }

    // 2. Team Leaders Duties
    const dayTeamDuties = (db.team_duties && db.team_duties[dateStr]) || {};
    leaders.forEach((leader, idx) => {
      const lDuty = dayTeamDuties[leader.id];
      if (lDuty && (lDuty.isLeave || lDuty.branchName)) {
        const theme = leader.colorTheme || colorThemes[idx % colorThemes.length];
        const shortName = leader.name.split(' ')[0];
        roster.push({
          id: leader.id,
          name: leader.name,
          shortName,
          role: 'team_leader',
          department: leader.department,
          colorTheme: theme,
          branchName: lDuty.branchName,
          isLeave: !!lDuty.isLeave,
          leaveType: lDuty.leaveType || null,
          note: lDuty.note || ''
        });
      }
    });

    // Check active interview & company meeting bookings for this day
    const dayActiveBookings = (db.bookings || []).filter(b => b.date === dateStr && b.status !== 'cancelled');
    const interviewBookings = dayActiveBookings.filter(isInterviewBooking);
    const hasInterview = interviewBookings.length > 0;
    const interviewCount = interviewBookings.length;

    const companyMeetingBookings = dayActiveBookings.filter(isCompanyMeetingBooking);
    const hasCompanyMeeting = companyMeetingBookings.length > 0;
    const companyMeetingCount = companyMeetingBookings.length;

    const isDayWeekend = (new Date(dateStr + 'T00:00:00').getDay() === 0 || new Date(dateStr + 'T00:00:00').getDay() === 6);
    days.push({
      date: dateStr,
      dayNumber: day,
      isWeekend: isDayWeekend,
      status: statusInfo.status, // 'green' | 'yellow' | 'red' | 'grey'
      statusText: statusInfo.statusText,
      canBook: statusInfo.canBook,
      isFullDayBlocked: !!fullDayBlock,
      totalSlots: statusInfo.totalSlots,
      availableSlots: statusInfo.availableSlots,
      bookedSlots: statusInfo.bookedSlots,
      hasMyBooking: statusInfo.hasMyBooking,
      hasInterview,
      interviewCount,
      hasCompanyMeeting,
      companyMeetingCount,
      duty: duty ? {
        branchId: duty.branchId,
        branchName: duty.branchName,
        isHalfDay: !!duty.isHalfDay,
        isLeave: duty.isLeave,
        leaveType: duty.leaveType,
        note: duty.note
      } : null,
      roster
    });
  }

  // Host default branch lookup
  const hostDefaultBranch = (db.branches || []).find(b => b.id === db.settings.defaultBranchId) || (db.branches && db.branches[0]);

  res.json({
    year,
    month,
    days,
    branches: db.branches,
    eventTypes: db.event_types,
    hostName: db.settings.hostName,
    hostDefaultBranchId: hostDefaultBranch ? hostDefaultBranch.id : null,
    hostDefaultBranchName: hostDefaultBranch ? hostDefaultBranch.name : 'สำนักงานใหญ่',
    teamLeaders: leaders.map((l, idx) => {
      const defBranch = (db.branches || []).find(b => b.id === l.defaultBranchId);
      return {
        ...l,
        colorTheme: l.colorTheme || colorThemes[idx % colorThemes.length],
        defaultBranchId: l.defaultBranchId || null,
        defaultBranchName: defBranch ? defBranch.name : 'สำนักงานใหญ่'
      };
    })
  });
});

// 2. Get Single Day Details & Slot Availability
app.get('/api/calendar/day', (req, res) => {
  const db = readDB();
  const { date } = req.query;
  const currentUserId = req.headers['x-user-id'] || req.query.userId;
  const isHost = isHostUser(req, db.settings);
  const isLeader = isLeaderUser(req, db);

  if (!date) {
    return res.status(400).json({ error: 'Missing date parameter (YYYY-MM-DD)' });
  }

  const statusInfo = calculateDayStatus(date, db, currentUserId);
  const duty = db.daily_duties[date] || null;
  const customHours = (duty && duty.isHalfDay) ? { startHour: 8, endHour: 12, lunchStartHour: 12, lunchEndHour: 12 } : null;
  const allSlots = generateDaySlots(db.settings, customHours);
  const dayBlocks = (db.blocked_slots || []).filter(b => b.date === date);
  const dayBookings = (db.bookings || []).filter(b => b.date === date && b.status !== 'cancelled');

  const slots = allSlots.map(slot => {
    // Check if blocked by host
    const blockMatch = dayBlocks.find(b => {
      if (b.isFullDay) return (duty && duty.isHalfDay) ? false : true;
      return (slot.startTime < b.endTime && slot.endTime > b.startTime);
    });

    if (blockMatch) {
      return {
        ...slot,
        state: 'blocked',
        reason: blockMatch.reason || 'Host ติดภารกิจ',
        blockId: blockMatch.id,
        canBook: false
      };
    }

    // Check if booked by employee / company meeting
    const bookingMatch = dayBookings.find(b => (slot.startTime < b.endTime && slot.endTime > b.startTime));
    if (bookingMatch) {
      const isMine = (currentUserId && bookingMatch.employeeUserId === currentUserId);
      const isInterview = isInterviewBooking(bookingMatch);
      const isCompanyMeeting = isCompanyMeetingBooking(bookingMatch);
      const canViewDetails = isMine || isHost || isLeader;

      let bookingData = {
        id: bookingMatch.id,
        eventTitle: bookingMatch.eventTitle,
        eventType: bookingMatch.eventType,
        employeeName: bookingMatch.employeeName,
        employeePicture: bookingMatch.employeePicture,
        meetingType: bookingMatch.meetingType,
        branchName: bookingMatch.branchName || 'สำนักงานใหญ่',
        notes: canViewDetails ? bookingMatch.notes : (bookingMatch.notes || 'นัดหมายการประชุม'),
        isMine,
        isInterview,
        isCompanyMeeting,
        bookingStartTime: bookingMatch.startTime,
        bookingEndTime: bookingMatch.endTime,
        canCancel: (isMine || isHost) // STRICT PERMISSION: only owner or host
      };

      if (isInterview && !canViewDetails) {
        bookingData.employeeName = '[สงวนสิทธิ์ข้อมูลผู้สมัครงาน]';
        bookingData.employeePicture = 'https://api.dicebear.com/7.x/bottts/svg?seed=interview-private';
        bookingData.notes = '🔒 สงวนสิทธิ์ข้อมูลเฉพาะกรรมการสัมภาษณ์ (Host & หัวหน้าทีม)';
        bookingData.eventTitle = 'สัมภาษณ์งาน (คิวส่วนบุคคล)';
      } else if (isCompanyMeeting && !canViewDetails) {
        bookingData.employeeName = 'ฝ่ายบริหาร / บริษัท';
        bookingData.employeePicture = 'https://api.dicebear.com/7.x/bottts/svg?seed=company-meeting';
        bookingData.notes = '📢 มีการประชุมบริษัทในช่วงเวลานี้ (ปิดรับคิว)';
        bookingData.eventTitle = 'ประชุมบริษัท';
      }

      return {
        ...slot,
        state: 'booked',
        canBook: false,
        booking: bookingData
      };
    }

    return {
      ...slot,
      state: 'available',
      canBook: (statusInfo.status !== 'grey')
    };
  });

  const fullDayBlock = (duty && duty.isHalfDay) ? null : (db.blocked_slots || []).find(b => b.date === date && b.isFullDay);

  // Host Duty fallback (ใช้ defaultBranchId ของ Host หากไม่มี duty เฉพาะวัน สำหรับวันธรรมดา)
  const dateObj = new Date(date + 'T00:00:00');
  const dayOfWeek = dateObj.getDay();
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

  const hostDefaultBranch = (db.branches || []).find(b => b.id === db.settings.defaultBranchId) || (db.branches && db.branches[0]);
  const hostDutyResolved = duty ? {
    branchId: duty.branchId,
    branchName: duty.branchName,
    isHalfDay: !!duty.isHalfDay,
    isLeave: !!duty.isLeave,
    leaveType: duty.leaveType || null,
    note: duty.note || '',
    isDefault: false
  } : (isWeekend ? null : {
    branchId: hostDefaultBranch ? hostDefaultBranch.id : null,
    branchName: hostDefaultBranch ? hostDefaultBranch.name : 'สำนักงานใหญ่',
    isLeave: false,
    isHalfDay: false,
    leaveType: null,
    note: '',
    isDefault: true
  });

  // Team Leaders Daily Duties for this day (ใช้ defaultBranchId ของแต่ละท่านหากไม่มี duty เฉพาะวัน)
  const leaders = db.team_leaders || [];
  const dayTeamDuties = (db.team_duties && db.team_duties[date]) || {};
  const teamDuties = leaders.map(leader => {
    const lDuty = dayTeamDuties[leader.id] || null;
    const defBranch = (db.branches || []).find(b => b.id === leader.defaultBranchId) || (db.branches && db.branches[0]);
    return {
      leaderId: leader.id,
      leaderName: leader.name,
      department: leader.department,
      picture: leader.picture,
      lineUserId: leader.lineUserId,
      defaultBranchId: leader.defaultBranchId || null,
      defaultBranchName: defBranch ? defBranch.name : 'สำนักงานใหญ่',
      duty: lDuty ? {
        branchId: lDuty.branchId,
        branchName: lDuty.branchName,
        isLeave: lDuty.isLeave,
        leaveType: lDuty.leaveType,
        note: lDuty.note || '',
        isDefault: false
      } : {
        branchId: defBranch ? defBranch.id : null,
        branchName: defBranch ? defBranch.name : 'สำนักงานใหญ่',
        isLeave: false,
        leaveType: null,
        note: '',
        isDefault: true
      }
    };
  });

  res.json({
    date,
    statusInfo,
    duty: hostDutyResolved,
    slots,
    isHost,
    isWeekend,
    isFullDayBlocked: !!fullDayBlock,
    fullDayBlockId: fullDayBlock ? fullDayBlock.id : null,
    teamDuties
  });
});

// 3. Create Booking (Employee)
app.post('/api/bookings', (req, res) => {
  const db = readDB();
  const {
    date,
    startTime,
    endTime,
    eventTitle,
    eventType,
    employeeName,
    employeeUserId,
    employeePicture,
    meetingType,
    notes
  } = req.body;

  // Validation
  if (!date || !startTime || !endTime || !eventTitle || !employeeName || !employeeUserId) {
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน (วันที่, เวลา, ชื่องาน, ชื่อผู้ลงคิว)' });
  }

  // Check if date is blocked or leave
  const statusInfo = calculateDayStatus(date, db, employeeUserId);
  if (!statusInfo.canBook) {
    return res.status(400).json({ error: `ไม่สามารถลงคิวในวันนี้ได้ (${statusInfo.statusText})` });
  }

  // Check if slot is blocked by host
  const isBlocked = (db.blocked_slots || []).some(b => {
    if (b.date !== date) return false;
    if (b.isFullDay) return true;
    return (startTime < b.endTime && endTime > b.startTime);
  });
  if (isBlocked) {
    return res.status(409).json({ error: 'ขออภัย ช่วงเวลานี้ Host ติดภารกิจหรือไม่เปิดรับคิว' });
  }

  // Security Check: Only Host or Team Leader can book "ประชุมบริษัท"
  if (isCompanyMeetingBooking(req.body)) {
    const isHost = isHostUser(req, db.settings);
    const isLeader = isLeaderUser(req, db);
    if (!isHost && !isLeader) {
      return res.status(403).json({ error: 'เฉพาะ Host และหัวหน้าทีมเท่านั้นที่มีสิทธิ์ลงคิวประเภทประชุมบริษัท' });
    }
  }

  // Check if slot or range is already booked
  const isAlreadyBooked = (db.bookings || []).some(b => {
    return b.date === date && b.status !== 'cancelled' && (startTime < b.endTime && endTime > b.startTime);
  });
  if (isAlreadyBooked) {
    return res.status(409).json({ error: 'ขออภัย มีบางช่วงเวลาที่มีผู้ลงคิวไว้เรียบร้อยแล้ว' });
  }

  // Resolve branch & address info from Host duty or Host default branch
  const duty = db.daily_duties[date] || null;
  const hostDefaultBranch = (db.branches || []).find(b => b.id === (db.settings && db.settings.defaultBranchId)) || (db.branches && db.branches[0]);
  
  let branchName = 'สำนักงานใหญ่';
  let branchAddress = '';

  if (duty && (duty.branchName || duty.branchId)) {
    const bObj = (db.branches || []).find(b => b.id === duty.branchId || b.name === duty.branchName);
    branchName = bObj ? bObj.name : duty.branchName;
    branchAddress = bObj ? (bObj.address || '') : '';
  } else if (hostDefaultBranch) {
    branchName = hostDefaultBranch.name;
    branchAddress = hostDefaultBranch.address || '';
  }

  const newBooking = {
    id: 'bk-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    date,
    startTime,
    endTime,
    eventTitle: eventTitle.trim(),
    eventType: eventType || '1-on-1 ปรึกษางาน',
    employeeName: employeeName.trim(),
    employeeUserId: employeeUserId.trim(),
    employeePicture: employeePicture || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(employeeName)}`,
    meetingType: meetingType || 'onsite',
    branchName,
    branchAddress,
    notes: notes ? notes.trim() : '',
    createdAt: new Date().toISOString(),
    status: 'confirmed'
  };

  db.bookings = db.bookings || [];
  db.bookings.push(newBooking);
  writeDB(db);

  res.status(201).json({
    message: 'ลงคิว Meeting สำเร็จเรียบร้อยแล้ว!',
    booking: newBooking
  });
});

// 4. Cancel Booking (Strict Permission Enforcement: Owner or Host Only!)
app.delete('/api/bookings/:id', (req, res) => {
  const db = readDB();
  const bookingId = req.params.id;
  const requestingUserId = req.headers['x-user-id'] || req.body.userId || req.query.userId;
  const isHost = isHostUser(req, db.settings);

  if (!bookingId) {
    return res.status(400).json({ error: 'Missing booking ID' });
  }

  const bookingIndex = (db.bookings || []).findIndex(b => b.id === bookingId && b.status !== 'cancelled');
  if (bookingIndex === -1) {
    return res.status(404).json({ error: 'ไม่พบคิวการนัดหมายนี้ หรือคิวถูกยกเลิกไปแล้ว' });
  }

  const booking = db.bookings[bookingIndex];

  // STRICT PERMISSION CHECK: Must be the employee who booked OR Host
  const isOwner = (requestingUserId && requestingUserId === booking.employeeUserId);
  if (!isOwner && !isHost) {
    return res.status(403).json({
      error: 'ความปลอดภัย: คุณไม่มีสิทธิ์ยกเลิกหรือแก้ไขคิวของพนักงานคนอื่น!',
      code: 'PERMISSION_DENIED'
    });
  }

  // Cancel booking
  booking.status = 'cancelled';
  booking.cancelledAt = new Date().toISOString();
  booking.cancelledBy = isHost ? 'host' : requestingUserId;

  writeDB(db);

  res.json({
    message: 'ยกเลิกคิวการนัดหมายเรียบร้อยแล้ว',
    cancelledBookingId: bookingId
  });
});

// 4.1 Update / Trim Booking Time Range (Owner or Host Only)
app.patch('/api/bookings/:id', (req, res) => {
  const db = readDB();
  const bookingId = req.params.id;
  const { startTime, endTime, ranges } = req.body;
  const requestingUserId = req.headers['x-user-id'] || req.body.userId || req.query.userId;
  const isHost = isHostUser(req, db.settings);

  if (!bookingId) {
    return res.status(400).json({ error: 'Missing booking ID' });
  }

  const booking = (db.bookings || []).find(b => b.id === bookingId && b.status !== 'cancelled');
  if (!booking) {
    return res.status(404).json({ error: 'ไม่พบคิวการนัดหมายนี้ หรือคิวถูกยกเลิกไปแล้ว' });
  }

  const isOwner = (requestingUserId && requestingUserId === booking.employeeUserId);
  if (!isOwner && !isHost) {
    return res.status(403).json({
      error: 'ความปลอดภัย: คุณไม่มีสิทธิ์แก้ไขคิวของพนักงานคนอื่น!',
      code: 'PERMISSION_DENIED'
    });
  }

  // Handle ranges array if provided (e.g. from multi-slot trim modal)
  if (Array.isArray(ranges)) {
    if (ranges.length === 0) {
      booking.status = 'cancelled';
      booking.cancelledAt = new Date().toISOString();
      booking.cancelledBy = isHost ? 'host' : requestingUserId;
      writeDB(db);
      return res.json({
        success: true,
        message: 'ยกเลิกคิวการนัดหมายเรียบร้อยแล้ว',
        cancelledBookingId: bookingId
      });
    }

    // Validate each range
    for (const r of ranges) {
      if (!r.startTime || !r.endTime || !/^\d{2}:\d{2}$/.test(r.startTime) || !/^\d{2}:\d{2}$/.test(r.endTime)) {
        return res.status(400).json({ error: 'รูปแบบเวลาในรายการช่วงเวลาไม่ถูกต้อง' });
      }
      if (r.startTime >= r.endTime) {
        return res.status(400).json({ error: 'เวลาเริ่มต้นต้องน้อยกว่าเวลาสิ้นสุดในทุกช่วง' });
      }
    }

    // First range updates existing booking
    booking.startTime = ranges[0].startTime;
    booking.endTime = ranges[0].endTime;
    booking.updatedAt = new Date().toISOString();
    booking.updatedBy = isHost ? 'host' : requestingUserId;

    // Additional split ranges (if cut in middle) create cloned bookings
    const createdBookings = [];
    for (let i = 1; i < ranges.length; i++) {
      const splitBooking = {
        ...booking,
        id: 'bk-' + Date.now() + '-' + Math.floor(Math.random() * 1000) + '-' + i,
        startTime: ranges[i].startTime,
        endTime: ranges[i].endTime,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updatedBy: isHost ? 'host' : requestingUserId
      };
      db.bookings.push(splitBooking);
      createdBookings.push(splitBooking);
    }

    writeDB(db);

    return res.json({
      success: true,
      message: 'ปรับช่วงเวลาการนัดหมายเรียบร้อยแล้ว',
      booking,
      createdBookings
    });
  }

  const newStart = startTime || booking.startTime;
  const newEnd = endTime || booking.endTime;

  if (startTime && !/^\d{2}:\d{2}$/.test(startTime)) {
    return res.status(400).json({ error: 'รูปแบบเวลาเริ่มต้นไม่ถูกต้อง' });
  }
  if (endTime && !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).json({ error: 'รูปแบบเวลาสิ้นสุดไม่ถูกต้อง' });
  }
  if (newStart >= newEnd) {
    return res.status(400).json({ error: 'เวลาเริ่มต้นต้องน้อยกว่าเวลาสิ้นสุด' });
  }

  booking.startTime = newStart;
  booking.endTime = newEnd;
  booking.updatedAt = new Date().toISOString();
  booking.updatedBy = isHost ? 'host' : requestingUserId;

  writeDB(db);

  res.json({
    success: true,
    message: 'ปรับช่วงเวลาการนัดหมายเรียบร้อยแล้ว',
    booking
  });
});

// 5. Get My Bookings (Employee + Interview Bookings for Host & Team Leaders)
app.get('/api/my-bookings', (req, res) => {
  const db = readDB();
  const userId = req.headers['x-user-id'] || req.query.userId;

  if (!userId) {
    return res.status(400).json({ error: 'กรุณาระบุ User ID' });
  }

  const isHost = isHostUser(req, db.settings);
  const isLeader = isLeaderUser(req, db);
  const activeBookings = (db.bookings || []).filter(b => b.status !== 'cancelled');

  let myBookings;
  if (isHost || isLeader) {
    // Host and Team Leaders see: their own bookings + ALL interview & company meeting bookings!
    myBookings = activeBookings.filter(b => {
      const isMine = (b.employeeUserId === userId);
      const isInterview = isInterviewBooking(b);
      const isCompanyMeeting = isCompanyMeetingBooking(b);
      return isMine || isInterview || isCompanyMeeting;
    }).map(b => {
      const isMine = (b.employeeUserId === userId);
      const isInterview = isInterviewBooking(b);
      const isCompanyMeeting = isCompanyMeetingBooking(b);
      return {
        ...b,
        isMine,
        isInterview,
        isCompanyMeeting,
        isInterviewDuty: (!isMine && isInterview),
        isCompanyMeetingDuty: (!isMine && isCompanyMeeting)
      };
    });
  } else {
    myBookings = activeBookings.filter(b => b.employeeUserId === userId).map(b => ({
      ...b,
      isMine: true,
      isInterview: isInterviewBooking(b),
      isCompanyMeeting: isCompanyMeetingBooking(b),
      isInterviewDuty: false,
      isCompanyMeetingDuty: false
    }));
  }

  myBookings.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));

  res.json({ bookings: myBookings });
});

// 6. Get All Bookings (Visible to Host, Team Leaders, and Employees with Privacy Protection)
app.get('/api/host/bookings', (req, res) => {
  const db = readDB();
  const userId = req.headers['x-user-id'] || req.query.userId;
  const isHost = isHostUser(req, db.settings);
  const isLeader = isLeaderUser(req, db);

  const activeBookings = (db.bookings || [])
    .filter(b => b.status !== 'cancelled')
    .map(b => {
      const isMine = (userId && b.employeeUserId === userId);
      const isInterview = isInterviewBooking(b);
      const isCompanyMeeting = isCompanyMeetingBooking(b);
      const canViewDetails = isMine || isHost || isLeader;

      if (isInterview && !canViewDetails) {
        return {
          ...b,
          employeeName: '[สงวนสิทธิ์ข้อมูลผู้สมัครงาน]',
          employeePicture: 'https://api.dicebear.com/7.x/bottts/svg?seed=interview-private',
          notes: '🔒 สงวนสิทธิ์ข้อมูลเฉพาะกรรมการสัมภาษณ์ (Host & หัวหน้าทีม)',
          eventTitle: 'สัมภาษณ์งาน (คิวส่วนบุคคล)',
          isInterview: true,
          isCompanyMeeting: false,
          isMine: false
        };
      } else if (isCompanyMeeting && !canViewDetails) {
        return {
          ...b,
          employeeName: 'ฝ่ายบริหาร / บริษัท',
          employeePicture: 'https://api.dicebear.com/7.x/bottts/svg?seed=company-meeting',
          notes: '📢 มีการประชุมบริษัทในช่วงเวลานี้ (ปิดรับคิว)',
          eventTitle: 'ประชุมบริษัท',
          isInterview: false,
          isCompanyMeeting: true,
          isMine: false
        };
      }
      return {
        ...b,
        isInterview,
        isCompanyMeeting,
        isMine
      };
    })
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));

  res.json({
    total: activeBookings.length,
    bookings: activeBookings
  });
});

// 6.1 Clear All Test Bookings (For Host / Admin)
app.post('/api/host/clear-test-bookings', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host / ผู้ดูแลระบบ เท่านั้นที่สามารถล้างข้อมูลคิวได้' });
  }

  const previousCount = (db.bookings || []).length;
  db.bookings = []; // Clear all bookings to 0
  writeDB(db);

  res.json({
    message: 'ล้างประวัติการจองทั้งหมดเรียบร้อยแล้ว ปฏิทินว่าง 100% พร้อมใช้งานจริง',
    clearedCount: previousCount
  });
});

// 7. Host Duty & Location & Leave Management
app.post('/api/host/duty', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถอัปเดตสาขาและวันลาได้' });
  }

  const { date, branchId, branchName, isLeave, leaveType, note, isHalfDay, isClear } = req.body;
  if (!date) {
    return res.status(400).json({ error: 'Missing date parameter' });
  }

  db.daily_duties = db.daily_duties || {};

  // If user requests to clear / reset duty (กลับเป็นวันว่างปกติ ไม่ระบุสถานที่)
  // หรือถ้าเป็นวันเสาร์-อาทิตย์ แล้วสลับปิดรับคิวทำงานครึ่งวัน (isHalfDay: false) โดยไม่เลือกสาขาอื่น ให้กลับเป็นวันหยุดเสาร์/อาทิตย์ตามเดิมอัตโนมัติ
  const dateObj = new Date(date + 'T00:00:00');
  const isDateWeekend = (dateObj.getDay() === 0 || dateObj.getDay() === 6);
  const isWeekendHalfDayClosed = (isDateWeekend && !isHalfDay && !isLeave && (!branchId || branchId === 'none' || branchId === 'clear'));

  if (!isHalfDay && (isClear || branchId === 'none' || branchId === 'clear' || isWeekendHalfDayClosed)) {
    delete db.daily_duties[date];
    writeDB(db);
    const dayName = (dateObj.getDay() === 6 ? 'เสาร์' : 'อาทิตย์');
    return res.json({
      message: isDateWeekend ? `ปิดรับคิววัน${dayName} เรียบร้อยแล้ว (กลับเป็นวันหยุดตามปกติ)` : 'ล้างสถานะเรียบร้อยแล้ว (กลับเป็นสถานะว่างปกติ ไม่ระบุสถานที่)',
      duty: null
    });
  }

  if (isHalfDay) {
    // Automatically UNLOCK and clear any full-day block on this date
    db.blocked_slots = (db.blocked_slots || []).filter(b => !(b.date === date && b.isFullDay));
  }

  const effectiveBranchId = (branchId === 'none' || branchId === 'clear') ? null : (branchId || null);
  const effectiveBranchName = effectiveBranchId ? (branchName || null) : null;

  db.daily_duties[date] = {
    branchId: effectiveBranchId,
    branchName: effectiveBranchName,
    isWorkingDay: true,
    isHalfDay: !!isHalfDay,
    isLeave: isHalfDay ? false : !!isLeave,
    leaveType: isHalfDay ? null : (leaveType || (isLeave ? 'ลาพักร้อน' : null)),
    note: note || '',
    updatedAt: new Date().toISOString()
  };

  writeDB(db);

  let message = 'อัปเดตสถานะของ Host เรียบร้อยแล้ว';
  if (isHalfDay) {
    message = 'เปิดรับคิวทำงานครึ่งวัน (08:00 - 12:00 น.) และปลดล็อกคิวอัตโนมัติเรียบร้อยแล้ว';
  } else if (isLeave) {
    message = `บันทึกวัน ${leaveType || 'ลาพักร้อน'} เรียบร้อยแล้ว (ปิดรับคิวอัตโนมัติ)`;
  } else if (branchName) {
    message = `อัปเดตสถานที่ประจำวัน: ${branchName} เรียบร้อยแล้ว`;
  } else {
    message = 'อัปเดตสถานะทำงานปกติ (ไม่ระบุสถานที่) เรียบร้อยแล้ว';
  }

  res.json({
    message,
    duty: db.daily_duties[date]
  });
});

// 8. Host Blockout Time / Close Day
app.post('/api/host/block-slot', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถบล็อกช่วงเวลาได้' });
  }

  const { date, startTime, endTime, reason, isFullDay } = req.body;
  if (!date) {
    return res.status(400).json({ error: 'Missing date parameter' });
  }

  if (!isFullDay && (!startTime || !endTime)) {
    return res.status(400).json({ error: 'กรุณาระบุเวลาเริ่มต้นและสิ้นสุด' });
  }

  const blockRecord = {
    id: 'blk-' + Date.now(),
    date,
    startTime: isFullDay ? '00:00' : startTime,
    endTime: isFullDay ? '23:59' : endTime,
    reason: reason || 'Host ติดภารกิจ',
    isFullDay: !!isFullDay,
    createdAt: new Date().toISOString()
  };

  db.blocked_slots = db.blocked_slots || [];
  db.blocked_slots.push(blockRecord);
  writeDB(db);

  res.status(201).json({
    message: isFullDay ? 'ปิดรับคิวทั้งวันเรียบร้อยแล้ว' : `บล็อกช่วงเวลา ${startTime} - ${endTime} เรียบร้อยแล้ว`,
    block: blockRecord
  });
});

// 8.1 Quick Toggle Full-Day Block (ปุ่มคลิกเดียว บล็อกคิวทั้งวัน / ปลดบล็อก)
app.post('/api/host/toggle-day-block', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถบล็อกคิวได้' });
  }

  const { date, reason } = req.body;
  if (!date) {
    return res.status(400).json({ error: 'Missing date parameter' });
  }

  db.blocked_slots = db.blocked_slots || [];
  const existingIndex = db.blocked_slots.findIndex(b => b.date === date && b.isFullDay);

  if (existingIndex !== -1) {
    // Already blocked -> Unblock it!
    db.blocked_slots.splice(existingIndex, 1);
    writeDB(db);
    return res.json({
      message: `ปลดบล็อกวันที่ ${date} เรียบร้อยแล้ว (เปิดรับคิวตามปกติ)`,
      isBlocked: false
    });
  } else {
    // Block the whole day
    const blockRecord = {
      id: 'blk-' + Date.now(),
      date,
      startTime: '00:00',
      endTime: '23:59',
      reason: reason || 'Host ปิดรับคิวตลอดวัน',
      isFullDay: true,
      createdAt: new Date().toISOString()
    };
    db.blocked_slots.push(blockRecord);
    writeDB(db);
    return res.json({
      message: `บล็อกคิววันที่ ${date} ตลอดทั้งวันเรียบร้อยแล้ว (สถานะเป็นสีเทา)`,
      isBlocked: true,
      block: blockRecord
    });
  }
});

// 9. Host Unblock Slot
app.delete('/api/host/block-slot/:id', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถยกเลิกการบล็อกได้' });
  }

  const blockId = req.params.id;
  const initialLength = db.blocked_slots.length;
  db.blocked_slots = (db.blocked_slots || []).filter(b => b.id !== blockId);

  if (db.blocked_slots.length === initialLength) {
    return res.status(404).json({ error: 'ไม่พบรายการบล็อกนี้' });
  }

  writeDB(db);
  res.json({ message: 'ยกเลิกการบล็อกช่วงเวลาเรียบร้อยแล้ว' });
});

// 10. Settings API
app.get('/api/settings', (req, res) => {
  const db = readDB();
  res.json({
    settings: db.settings,
    branches: db.branches,
    eventTypes: db.event_types
  });
});

app.post('/api/settings', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถแก้ไขการตั้งค่าได้' });
  }

  const { hostName, defaultBranchId, slotDurationMinutes, liffId, weekendOpen, adminPin, workStartHour, workEndHour } = req.body;
  if (hostName && hostName.trim()) db.settings.hostName = hostName.trim();
  if (defaultBranchId !== undefined) db.settings.defaultBranchId = defaultBranchId;
  if (slotDurationMinutes) db.settings.slotDurationMinutes = parseInt(slotDurationMinutes);
  if (workStartHour) db.settings.workStartHour = parseInt(workStartHour);
  if (workEndHour) db.settings.workEndHour = parseInt(workEndHour);
  if (liffId !== undefined) db.settings.liffId = liffId;
  if (weekendOpen !== undefined) db.settings.weekendOpen = !!weekendOpen;
  if (adminPin) db.settings.adminPin = adminPin;

  writeDB(db);
  res.json({ message: 'บันทึกการตั้งค่าเรียบร้อยแล้ว', settings: db.settings });
});

// 10.1 Backup & Restore Database
app.get('/api/admin/export-database', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถสำรองข้อมูลได้' });
  }
  res.setHeader('Content-Disposition', 'attachment; filename="database.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(db, null, 2));
});

app.post('/api/admin/import-database', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถกู้คืนข้อมูลได้' });
  }

  const importedData = req.body;
  if (!importedData || typeof importedData !== 'object' || !importedData.settings) {
    return res.status(400).json({ error: 'ไฟล์ฐานข้อมูลไม่ถูกต้อง' });
  }

  writeDB(importedData);
  res.json({ message: 'กู้คืนฐานข้อมูลเรียบร้อยแล้ว' });
});

// 11. Branch Management APIs (เพิ่ม / แก้ไข / ลบ รายชื่อสาขา)
app.get('/api/branches', (req, res) => {
  const db = readDB();
  res.json({ branches: db.branches || [] });
});

app.post('/api/branches', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถจัดการสาขาได้' });
  }

  const { name, address } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'กรุณาระบุชื่อสาขา' });
  }

  const id = 'br-' + Date.now();
  const newBranch = {
    id,
    name: name.trim(),
    address: address ? address.trim() : '',
    icon: 'building-2',
    badgeClass: 'bg-teal-100 text-teal-700 border-teal-200'
  };

  db.branches = db.branches || [];
  db.branches.push(newBranch);
  writeDB(db);

  res.status(201).json({ message: 'เพิ่มสาขาเรียบร้อยแล้ว', branch: newBranch });
});

app.put('/api/branches/:id', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถจัดการสาขาได้' });
  }

  const branchId = req.params.id;
  const { name, address } = req.body;

  const branch = (db.branches || []).find(b => b.id === branchId);
  if (!branch) {
    return res.status(404).json({ error: 'ไม่พบข้อมูลสาขานี้' });
  }

  if (name && name.trim()) branch.name = name.trim();
  if (address !== undefined) branch.address = address.trim();

  writeDB(db);
  res.json({ message: 'แก้ไขข้อมูลสาขาเรียบร้อยแล้ว', branch });
});

app.delete('/api/branches/:id', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถจัดการสาขาได้' });
  }

  const branchId = req.params.id;
  const initialCount = (db.branches || []).length;
  db.branches = (db.branches || []).filter(b => b.id !== branchId);

  if (db.branches.length === initialCount) {
    return res.status(404).json({ error: 'ไม่พบข้อมูลสาขานี้' });
  }

  writeDB(db);
  res.json({ message: 'ลบสาขาเรียบร้อยแล้ว' });
});

// 12. Team Leaders & Team Duties APIs (จัดการหัวหน้าทีม & บันทึกวันลา/สาขาของหัวหน้าทีม)
app.get('/api/team-leaders', (req, res) => {
  const db = readDB();
  res.json({ leaders: db.team_leaders || [] });
});

app.post('/api/team-leaders', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถเพิ่มหัวหน้าทีมได้' });
  }

  const { name, department, lineUserId, defaultBranchId } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'กรุณาระบุชื่อหัวหน้าทีม' });
  }

  const id = 'tl-' + Date.now();
  const matchedUser = (db.registered_users || []).find(u => u.userId === lineUserId);
  const picture = (matchedUser && matchedUser.pictureUrl) ? matchedUser.pictureUrl : `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(name)}`;

  const newLeader = {
    id,
    name: name.trim(),
    department: department ? department.trim() : 'หัวหน้าทีม',
    lineUserId: lineUserId ? lineUserId.trim() : `U_LEAD_${Date.now()}`,
    picture,
    defaultBranchId: defaultBranchId || (db.branches && db.branches[0] ? db.branches[0].id : null)
  };

  db.team_leaders = db.team_leaders || [];
  db.team_leaders.push(newLeader);
  writeDB(db);

  res.status(201).json({ message: 'เพิ่มหัวหน้าทีมเรียบร้อยแล้ว', leader: newLeader });
});

app.put('/api/team-leaders/:id', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถแก้ไขข้อมูลหัวหน้าทีมได้' });
  }

  const leaderId = req.params.id;
  const leader = (db.team_leaders || []).find(l => l.id === leaderId);
  if (!leader) {
    return res.status(404).json({ error: 'ไม่พบข้อมูลหัวหน้าทีม' });
  }

  const { name, department, lineUserId, defaultBranchId } = req.body;
  if (name && name.trim()) {
    leader.name = name.trim();
    leader.picture = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(leader.name)}`;
  }
  if (department !== undefined) leader.department = department.trim();
  if (lineUserId !== undefined) leader.lineUserId = lineUserId.trim();
  if (defaultBranchId !== undefined) leader.defaultBranchId = defaultBranchId;

  writeDB(db);
  res.json({ message: 'แก้ไขข้อมูลหัวหน้าทีมเรียบร้อยแล้ว', leader });
});

app.delete('/api/team-leaders/:id', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถลบหัวหน้าทีมได้' });
  }

  const leaderId = req.params.id;
  const initialCount = (db.team_leaders || []).length;
  db.team_leaders = (db.team_leaders || []).filter(l => l.id !== leaderId);

  if (db.team_leaders.length === initialCount) {
    return res.status(404).json({ error: 'ไม่พบข้อมูลหัวหน้าทีมท่านนี้' });
  }

  writeDB(db);
  res.json({ message: 'ลบรายชื่อหัวหน้าทีมเรียบร้อยแล้ว' });
});

// 11.1 User Check-in & Member Directory (บันทึกรายชื่อสมาชิก LINE ที่เคยเข้าใช้งาน)
app.post('/api/users/checkin', (req, res) => {
  const db = readDB();
  const { userId, displayName, pictureUrl } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  db.registered_users = db.registered_users || [];
  const existingIdx = db.registered_users.findIndex(u => u.userId === userId);
  const now = new Date().toISOString();

  if (existingIdx !== -1) {
    if (displayName) db.registered_users[existingIdx].displayName = displayName;
    if (pictureUrl) db.registered_users[existingIdx].pictureUrl = pictureUrl;
    db.registered_users[existingIdx].lastActiveAt = now;
  } else {
    db.registered_users.push({
      userId,
      displayName: displayName || 'LINE Member',
      pictureUrl: pictureUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${userId}`,
      firstSeenAt: now,
      lastActiveAt: now
    });
  }

  writeDB(db);
  res.json({ success: true });
});

app.get('/api/users', (req, res) => {
  const db = readDB();
  res.json({ users: db.registered_users || [] });
});

// บันทึกตารางงาน / วันลา ของหัวหน้าทีม
app.post('/api/team-duty', (req, res) => {
  const db = readDB();
  const { leaderId, date, branchId, branchName, isLeave, leaveType, note, isClear } = req.body;
  const requestingUserId = req.headers['x-user-id'] || req.body.userId;
  const isHost = isHostUser(req, db.settings);

  if (!leaderId || !date) {
    return res.status(400).json({ error: 'Missing leaderId or date' });
  }

  const leader = (db.team_leaders || []).find(l => l.id === leaderId);
  if (!leader) {
    return res.status(404).json({ error: 'ไม่พบข้อมูลหัวหน้าทีม' });
  }

  // Security Check: Must be that leader or Host
  const isAuthorized = isHost || (requestingUserId && (requestingUserId === leader.lineUserId || requestingUserId === leader.id));
  if (!isAuthorized) {
    return res.status(403).json({ error: 'คุณไม่มีสิทธิ์แก้ไขตารางงานของหัวหน้าท่านอื่น' });
  }

  db.team_duties = db.team_duties || {};
  db.team_duties[date] = db.team_duties[date] || {};

  // If user requests to clear / reset duty (ว่างปกติ / ไม่ระบุสถานที่)
  if (isClear || branchId === 'none' || branchId === 'clear') {
    delete db.team_duties[date][leaderId];
    writeDB(db);
    return res.json({
      message: `ล้างสถานะของ ${leader.name} เรียบร้อยแล้ว (กลับเป็นสถานะว่างปกติ ไม่ระบุสถานที่)`,
      duty: null
    });
  }

  db.team_duties[date][leaderId] = {
    leaderName: leader.name,
    branchId: isLeave ? null : (branchId || null),
    branchName: isLeave ? null : (branchName || null),
    isLeave: !!isLeave,
    leaveType: isLeave ? (leaveType || 'ลาพักร้อน') : null,
    note: note ? note.trim() : '',
    updatedAt: new Date().toISOString()
  };

  writeDB(db);

  res.json({
    message: isLeave 
      ? `บันทึกวัน ${leaveType || 'ลาพักร้อน'} ของ ${leader.name} เรียบร้อยแล้ว` 
      : `บันทึกสถานะของ ${leader.name} เรียบร้อยแล้ว`,
    duty: db.team_duties[date][leaderId]
  });
});

// 13. Event Types Management APIs (จัดการหมวดหมู่ Event / การประชุม)
app.get('/api/event-types', (req, res) => {
  const db = readDB();
  res.json({ eventTypes: db.event_types || [] });
});

app.post('/api/event-types', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถจัดการหมวดหมู่ Event ได้' });
  }

  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'กรุณาระบุชื่อหมวดหมู่ Event' });
  }

  db.event_types = db.event_types || [];
  if (db.event_types.includes(name.trim())) {
    return res.status(409).json({ error: 'หมวดหมู่นี้มีอยู่ในระบบแล้ว' });
  }

  db.event_types.push(name.trim());
  writeDB(db);

  res.status(201).json({ message: 'เพิ่มหมวดหมู่ Event เรียบร้อยแล้ว', eventTypes: db.event_types });
});

app.put('/api/event-types/:index', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถจัดการหมวดหมู่ Event ได้' });
  }

  const index = parseInt(req.params.index);
  const { name } = req.body;

  if (isNaN(index) || index < 0 || index >= (db.event_types || []).length) {
    return res.status(404).json({ error: 'ไม่พบหมวดหมู่นี้' });
  }

  const currentCategory = db.event_types[index] || '';
  if (currentCategory.includes('สัมภาษณ์') || currentCategory.includes('ประชุมบริษัท')) {
    return res.status(400).json({ error: `ไม่อนุญาตให้แก้ไขหมวดหมู่ "${currentCategory}" เนื่องจากเป็นหมวดหมู่ระบบที่จำเป็นต่อการทำงานของโปรแกรม` });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'กรุณาระบุชื่อหมวดหมู่ Event' });
  }

  db.event_types[index] = name.trim();
  writeDB(db);

  res.json({ message: 'แก้ไขหมวดหมู่ Event เรียบร้อยแล้ว', eventTypes: db.event_types });
});

app.delete('/api/event-types/:index', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host เท่านั้นที่สามารถจัดการหมวดหมู่ Event ได้' });
  }

  const index = parseInt(req.params.index);
  if (isNaN(index) || index < 0 || index >= (db.event_types || []).length) {
    return res.status(404).json({ error: 'ไม่พบหมวดหมู่นี้' });
  }

  const categoryToDelete = db.event_types[index] || '';
  if (categoryToDelete.includes('สัมภาษณ์') || categoryToDelete.includes('ประชุมบริษัท')) {
    return res.status(400).json({ error: `ไม่อนุญาตให้ลบหมวดหมู่ "${categoryToDelete}" เนื่องจากเป็นหมวดหมู่ระบบที่จำเป็นต่อการทำงานของโปรแกรม` });
  }

  const removed = db.event_types.splice(index, 1);
  writeDB(db);

  res.json({ message: `ลบหมวดหมู่ "${removed[0]}" เรียบร้อยแล้ว`, eventTypes: db.event_types });
});

// Start Server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`====================================================`);
  console.log(`🚀 LINE Meeting Queue App running on port ${PORT}`);
  console.log(`👉 Local:   http://localhost:${PORT}`);
  console.log(`👉 Network: http://127.0.0.1:${PORT}`);
  console.log(`====================================================`);
  await initSupabaseSync();
});
