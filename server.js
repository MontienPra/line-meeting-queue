const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'database.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------
// Database Helper
// -------------------------------------------------------------
function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const defaultPath = path.join(__dirname, 'data', 'database.json');
      if (DB_FILE !== defaultPath && fs.existsSync(defaultPath)) {
        if (!fs.existsSync(DB_DIR)) {
          fs.mkdirSync(DB_DIR, { recursive: true });
        }
        const defaultData = fs.readFileSync(defaultPath, 'utf8');
        fs.writeFileSync(DB_FILE, defaultData, 'utf8');
        return JSON.parse(defaultData);
      }
      return { settings: {}, branches: [], event_types: [], daily_duties: {}, blocked_slots: [], bookings: [] };
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading database.json:', err);
    return { settings: {}, branches: [], event_types: [], daily_duties: {}, blocked_slots: [], bookings: [] };
  }
}

function writeDB(data) {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing database.json:', err);
    return false;
  }
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
    return {
      status: 'grey',
      statusText: 'วันหยุดสุดสัปดาห์ (ปิดรับคิว)',
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

  // Check Full-day Block by Host
  const fullDayBlock = (blocked_slots || []).find(b => b.date === dateStr && b.isFullDay);
  if (fullDayBlock) {
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
      const isBooked = dayBookings.some(b => b.startTime === slot.startTime);
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

    // 1. Host Duty
    if (duty && (duty.isLeave || duty.branchName || duty.isHalfDay)) {
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

    days.push({
      date: dateStr,
      dayNumber: day,
      status: statusInfo.status, // 'green' | 'yellow' | 'red' | 'grey'
      statusText: statusInfo.statusText,
      canBook: statusInfo.canBook,
      isFullDayBlocked: !!fullDayBlock,
      totalSlots: statusInfo.totalSlots,
      availableSlots: statusInfo.availableSlots,
      bookedSlots: statusInfo.bookedSlots,
      hasMyBooking: statusInfo.hasMyBooking,
      duty: duty ? {
        branchId: duty.branchId,
        branchName: duty.branchName,
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
      if (b.isFullDay) return true;
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

    // Check if booked by employee
    const bookingMatch = dayBookings.find(b => b.startTime === slot.startTime);
    if (bookingMatch) {
      const isMine = (currentUserId && bookingMatch.employeeUserId === currentUserId);
      return {
        ...slot,
        state: 'booked',
        canBook: false,
        booking: {
          id: bookingMatch.id,
          eventTitle: bookingMatch.eventTitle,
          eventType: bookingMatch.eventType,
          employeeName: bookingMatch.employeeName,
          employeePicture: bookingMatch.employeePicture,
          meetingType: bookingMatch.meetingType,
          notes: (isMine || isHost) ? bookingMatch.notes : 'รายละเอียดการประชุม',
          isMine,
          canCancel: (isMine || isHost) // STRICT PERMISSION: only owner or host
        }
      };
    }

    return {
      ...slot,
      state: 'available',
      canBook: (statusInfo.status !== 'grey')
    };
  });

  const fullDayBlock = (db.blocked_slots || []).find(b => b.date === date && b.isFullDay);

  // Host Duty fallback (ใช้ defaultBranchId ของ Host หากไม่มี duty เฉพาะวัน)
  const hostDefaultBranch = (db.branches || []).find(b => b.id === db.settings.defaultBranchId) || (db.branches && db.branches[0]);
  const hostDutyResolved = duty ? {
    branchId: duty.branchId,
    branchName: duty.branchName,
    isLeave: duty.isLeave,
    leaveType: duty.leaveType,
    note: duty.note,
    isDefault: false
  } : {
    branchId: hostDefaultBranch ? hostDefaultBranch.id : null,
    branchName: hostDefaultBranch ? hostDefaultBranch.name : 'สำนักงานใหญ่',
    isLeave: false,
    leaveType: null,
    note: 'สาขาประจำปกติ',
    isDefault: true
  };

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
        note: lDuty.note,
        isDefault: false
      } : {
        branchId: defBranch ? defBranch.id : null,
        branchName: defBranch ? defBranch.name : 'สำนักงานใหญ่',
        isLeave: false,
        leaveType: null,
        note: 'สาขาประจำปกติ',
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

  // Check if already booked
  const isAlreadyBooked = (db.bookings || []).some(b => {
    return b.date === date && b.startTime === startTime && b.status !== 'cancelled';
  });
  if (isAlreadyBooked) {
    return res.status(409).json({ error: 'ขออภัย ช่วงเวลานี้มีผู้ลงคิวไว้เรียบร้อยแล้ว' });
  }

  // Resolve branch info from daily duty
  const duty = db.daily_duties[date] || null;
  const branchName = duty ? duty.branchName : 'สำนักงานใหญ่';

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

// 5. Get My Bookings (Employee)
app.get('/api/my-bookings', (req, res) => {
  const db = readDB();
  const userId = req.headers['x-user-id'] || req.query.userId;

  if (!userId) {
    return res.status(400).json({ error: 'กรุณาระบุ User ID' });
  }

  const myBookings = (db.bookings || [])
    .filter(b => b.employeeUserId === userId && b.status !== 'cancelled')
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));

  res.json({ bookings: myBookings });
});

// 6. Get All Bookings (For Host / Admin view)
app.get('/api/host/bookings', (req, res) => {
  const db = readDB();
  if (!isHostUser(req, db.settings)) {
    return res.status(403).json({ error: 'เฉพาะ Host / ผู้ดูแลระบบ เท่านั้นที่สามารถดูรายชื่อคิวทั้งหมดได้' });
  }

  const activeBookings = (db.bookings || [])
    .filter(b => b.status !== 'cancelled')
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
  if (isClear || branchId === 'none' || branchId === 'clear') {
    delete db.daily_duties[date];
    writeDB(db);
    return res.json({
      message: 'ล้างสถานะเรียบร้อยแล้ว (กลับเป็นสถานะว่างปกติ ไม่ระบุสถานที่)',
      duty: null
    });
  }

  db.daily_duties[date] = {
    branchId: branchId || null,
    branchName: branchName || null,
    isWorkingDay: true,
    isHalfDay: !!isHalfDay,
    isLeave: !!isLeave,
    leaveType: leaveType || (isLeave ? 'ลาพักร้อน' : null),
    note: note || '',
    updatedAt: new Date().toISOString()
  };

  writeDB(db);

  let message = 'อัปเดตสถานะของ Host เรียบร้อยแล้ว';
  if (isLeave) {
    message = `บันทึกวัน ${leaveType || 'ลาพักร้อน'} เรียบร้อยแล้ว (ปิดรับคิวอัตโนมัติ)`;
  } else if (isHalfDay) {
    message = `เปิดรับคิวทำงานครึ่งวัน (09:00 - 12:00 น.) เรียบร้อยแล้ว`;
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
  const newLeader = {
    id,
    name: name.trim(),
    department: department ? department.trim() : 'หัวหน้าทีม',
    lineUserId: lineUserId ? lineUserId.trim() : `U_LEAD_${Date.now()}`,
    picture: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(name)}`,
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

  const removed = db.event_types.splice(index, 1);
  writeDB(db);

  res.json({ message: `ลบหมวดหมู่ "${removed[0]}" เรียบร้อยแล้ว`, eventTypes: db.event_types });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 LINE Meeting Queue App running on port ${PORT}`);
  console.log(`👉 Local:   http://localhost:${PORT}`);
  console.log(`👉 Network: http://127.0.0.1:${PORT}`);
  console.log(`====================================================`);
});
